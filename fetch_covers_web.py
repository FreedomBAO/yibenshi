"""
fetch_covers_web.py — 为「每天精读一本书」网站自动爬取封面

流程:
    1. 读 data.json, 取每本书的中文书名 title
    2. 用豆瓣 JSON 接口搜索 -> 下载大图 (百度兜底)
    3. 存到 images/ 目录, 文件名 = 书名.<ext>
    4. 回填该书的 cover 字段 = "images/<文件名>"

幂等: 已有 cover 字段的书会跳过, 可重复运行。

运行:
    python fetch_covers_web.py
依赖: pip install requests beautifulsoup4
"""

from __future__ import annotations

import json
import random
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, unquote

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data.json"
IMAGES_DIR = ROOT / "assets" / "covers"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

BLOCKED_MARKERS = ("拒绝访问", "访问受限", "检测到有异常请求", "有异常请求来自")


class Blocked(Exception):
    pass


class NotFound(Exception):
    pass


def make_session() -> requests.Session:
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    s = requests.Session()
    s.trust_env = False
    retry = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=(500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "HEAD"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=20)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def headers_for(referer=None):
    h = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
    }
    if referer:
        h["Referer"] = referer
    return h


def ext_from_url(url: str, content_type: str = "") -> str:
    path = urlparse(url).path.lower()
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        if path.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    ct = (content_type or "").lower()
    if "jpeg" in ct or "jpg" in ct:
        return ".jpg"
    if "png" in ct:
        return ".png"
    if "webp" in ct:
        return ".webp"
    return ".jpg"


def safe_filename(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\r\n\t]', "_", name).strip("._ ")


def _is_real_image(data: bytes) -> bool:
    """字节流签名 + 最小尺寸过滤, 不依赖 PIL。"""
    if len(data) < 5000:
        return False
    sig = data[:12]
    if sig.startswith(b"\xff\xd8\xff"):
        return True  # jpeg
    if sig.startswith(b"\x89PNG\r\n\x1a\n"):
        return True  # png
    if sig[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True  # webp
    if sig.startswith(b"GIF8"):
        return True  # gif
    return False


def douban_suggest(query: str, session: requests.Session):
    r = session.get(
        "https://book.douban.com/j/subject_suggest",
        params={"q": query},
        headers=headers_for(referer="https://book.douban.com/"),
        timeout=20,
    )
    if r.status_code != 200:
        raise Blocked(f"douban suggest HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError as e:
        raise Blocked(f"douban suggest non-JSON: {e}")
    if not isinstance(data, list) or not data:
        return []
    return data


def _cdn_candidates(pic_url: str):
    m = re.match(r"https?://(img\d+)\.doubanio\.com/", pic_url)
    if not m:
        return [pic_url]
    rest = pic_url.split(m.group(1) + ".doubanio.com", 1)[1]
    order = list(range(1, 10))
    random.shuffle(order)
    return [f"https://img{i}.doubanio.com{rest}" for i in order]


def download_cover(pic_url: str, session: requests.Session):
    candidates = _cdn_candidates(pic_url)
    for cand in candidates:
        url = re.sub(r"/s/public/", "/l/public/", cand)
        try:
            r = session.get(
                url,
                headers=headers_for(referer="https://book.douban.com/"),
                timeout=40,
            )
        except requests.exceptions.RequestException:
            continue
        if r.status_code == 200 and len(r.content) >= 2048 and _is_real_image(r.content):
            return r.content, ext_from_url(url, r.headers.get("Content-Type", ""))
    # 大图失败, 降级小图
    for cand in candidates:
        try:
            r = session.get(
                cand,
                headers=headers_for(referer="https://book.douban.com/"),
                timeout=40,
            )
        except requests.exceptions.RequestException:
            continue
        if r.status_code == 200 and len(r.content) >= 1024 and _is_real_image(r.content):
            return r.content, ext_from_url(cand, r.headers.get("Content-Type", ""))
    raise Blocked("cover download failed across CDN hosts")


def search_baidu_fallback(title: str, session: requests.Session):
    q = f"{title} 封面"
    try:
        r = session.get(
            "https://image.baidu.com/search/index",
            params={"tn": "baiduimage", "word": q},
            headers=headers_for(referer="https://image.baidu.com/"),
            timeout=20,
        )
    except requests.exceptions.RequestException:
        return None
    if r.status_code != 200:
        return None
    soup = BeautifulSoup(r.text, "html.parser")
    candidates = []
    for tag in soup.select("img"):
        for k in ("data-src", "data-original", "data-thumburl", "src"):
            v = tag.get(k)
            if v and v.startswith("http"):
                candidates.append(v)
    for m in re.finditer(r'"(?:objURL|firstURL|hoverURL|oriURL)"\s*:\s*"([^"]+)"', r.text):
        url = m.group(1).replace("\\/", "/")
        if url.startswith("http"):
            candidates.append(url)
    if not candidates:
        return None
    img_url = candidates[0]
    if img_url.startswith("//"):
        img_url = "https:" + img_url
    try:
        img_resp = session.get(
            unquote(img_url),
            headers=headers_for(referer="https://image.baidu.com/"),
            timeout=40,
        )
    except requests.exceptions.RequestException:
        return None
    if img_resp.status_code != 200 or not _is_real_image(img_resp.content):
        return None
    return img_resp.content, ext_from_url(unquote(img_url), img_resp.headers.get("Content-Type", ""))


def fetch_cover(title: str, session: requests.Session):
    """豆瓣优先, 失败切百度。返回 (content, ext)。"""
    try:
        items = douban_suggest(title, session)
        if not items:
            cleaned = re.sub(r"[（(].*?[)）]", "", title).strip()
            if cleaned and cleaned != title:
                items = douban_suggest(cleaned, session)
        if not items:
            raise NotFound(f"douban suggest empty for {title!r}")
        picked = None
        for it in items:
            if it.get("title", "") == title:
                picked = it
                break
        if not picked:
            for it in items:
                if title and title in it.get("title", ""):
                    picked = it
                    break
        if not picked:
            picked = items[0]
        return download_cover(picked["pic"], session)
    except (Blocked, NotFound):
        fb = search_baidu_fallback(title, session)
        if not fb:
            raise NotFound(f"both douban & baidu failed for {title!r}")
        return fb


def main() -> int:
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    books = data.get("books", [])
    if not books:
        sys.exit("[ERR] data.json 里没有 books")

    IMAGES_DIR.mkdir(exist_ok=True)
    session = make_session()

    ok = fail = skipped = 0
    for book in books:
        title = (book.get("title") or "").strip()
        if not title:
            continue
        if book.get("cover"):
            print(f"[跳过] 已有封面: {title}")
            skipped += 1
            continue
        try:
            content, ext = fetch_cover(title, session)
        except Exception as e:  # noqa: BLE001
            print(f"[失败] {title}: {type(e).__name__}: {e}")
            fail += 1
            continue
        base = safe_filename(title)
        target = IMAGES_DIR / f"{base}{ext}"
        i = 2
        while target.exists():
            target = IMAGES_DIR / f"{base}_{i}{ext}"
            i += 1
        target.write_bytes(content)
        book["cover"] = f"assets/covers/{target.name}"
        print(f"[成功] {title} -> {book['cover']} ({len(content) // 1024} KB)")
        ok += 1
        time.sleep(random.uniform(0.8, 1.5))

    DATA_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("=" * 50)
    print(f"完成: 成功 {ok} / 失败 {fail} / 跳过 {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
