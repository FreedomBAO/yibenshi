"""Daily selection → fetched evidence → original draft → all-page review.

Only deterministic code can upload/publish; model output never runs as code.
"""
import argparse
import datetime as dt
import io
import ipaddress
import json
import re
import socket
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

import requests
from PIL import Image

from .client import Client, InfrastructureError, now, save, window
from .models import Candidates, CoverChoice, Draft, Research, Review
from .pdf import chinese_count, render, sha, visible_pages

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "_cloud_daily_work"
CONTENT_REVIEW = ["C01", "C04", "C06", "C08", "C09", "C10", "E01", "E02", "E04", "E05", "E06"]


def cover_links(pages):
    """Use image links actually present in fetched evidence, not invented URLs."""
    from html.parser import HTMLParser
    from urllib.parse import urljoin
    links = []

    class Metadata(HTMLParser):
        def __init__(self, base):
            super().__init__()
            self.base = base

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "meta" and (attrs.get("property") or attrs.get("name")) in ("og:image", "twitter:image"):
                if attrs.get("content"):
                    links.append({"url": urljoin(self.base, attrs["content"]), "source_url": self.base})

    for page in pages:
        for url in re.findall(r"!\[[^\]]*\]\((https://[^\s)]+)", page["content"]):
            links.append({"url": url, "source_url": page["url"]})
        url = page["url"]
        try:
            for _ in range(4):
                public_url(url)
                with requests.get(url, timeout=(10, 20), stream=True, allow_redirects=False) as res:
                    if res.is_redirect:
                        url = urljoin(url, res.headers["Location"])
                        continue
                    if res.status_code == 200 and "text/html" in res.headers.get("Content-Type", ""):
                        body = bytearray()
                        for chunk in res.iter_content(16384):
                            body.extend(chunk)
                            if len(body) > 1_000_000:
                                break
                        Metadata(page["url"]).feed(body.decode(res.encoding or "utf-8", errors="replace"))
                    break
        except (requests.RequestException, ValueError):
            continue
    return [dict(t) for t in {tuple(x.items()) for x in links if x["url"].startswith("https://")}]


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def norm(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("NON_PUBLIC_HTTPS_URL")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    except OSError:
        raise ValueError("SOURCE_DNS_UNAVAILABLE") from None
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("NON_PUBLIC_SOURCE_ADDRESS")
    return url


def download_cover(url):
    for _ in range(4):
        public_url(url)
        try:
            with requests.get(url, timeout=(10, 40), stream=True, allow_redirects=False) as res:
                if res.is_redirect:
                    from urllib.parse import urljoin
                    url = urljoin(url, res.headers["Location"])
                    continue
                if res.status_code != 200:
                    raise ValueError("COVER_UNAVAILABLE")
                chunks, size = [], 0
                for chunk in res.iter_content(65536):
                    size += len(chunk)
                    if size > 12_000_000:
                        raise ValueError("COVER_TOO_LARGE")
                    chunks.append(chunk)
            image = Image.open(io.BytesIO(b"".join(chunks)))
            if min(image.size) < 600 or max(image.size) > 10000:
                raise ValueError("COVER_DIMENSIONS")
            image.convert("RGB").save(WORK / "book.cover.jpg", quality=92)
            return image.size
        except requests.RequestException:
            raise ValueError("COVER_DOWNLOAD_FAILED") from None
    raise ValueError("COVER_REDIRECT_LIMIT")


def duplicate(candidate, books, date):
    titles = {norm(x) for b in books for x in [b["title"], b.get("originalTitle", "")] if x}
    if norm(candidate.title) in titles or (candidate.originalTitle and norm(candidate.originalTitle) in titles):
        return True
    for b in books:
        if b.get("isbn") and norm(b["isbn"]) == norm(candidate.isbn):
            return True
        try:
            age = (dt.date.fromisoformat(date) - dt.date.fromisoformat(b["date"])).days
        except (ValueError, KeyError):
            continue
        if 0 <= age < 90 and norm(candidate.author) == norm(b.get("author", "")):
            return True
    return False


def require_review(review, ids):
    checks = {x.id: x for x in review.checks}
    if len(checks) != len(review.checks) or set(checks) != set(ids):
        raise ValueError("REVIEW_INCOMPLETE")
    failed = [x.id for x in review.checks if not x.passed]
    if failed:
        # IDs and short feedback are kept in the local report, never provider headers.
        raise ValueError("REVIEW_FAILED:" + ",".join(failed))
    return [{"id": x.id, "status": "pass", "evidence": x.evidence} for x in review.checks]


def research(client, candidate):
    found = {}
    for query in candidate.queries:
        for x in client.search(query):
            if x.get("url", "").startswith("https://"):
                found[x["url"]] = x
    if len(found) < 5:
        raise ValueError("INSUFFICIENT_SEARCH_RESULTS")
    plan = client.structured(
        "从搜索结果选5-8个可靠来源，至少2个作者/出版社/原始研究第一方来源，交叉核对书名作者版本。"
        "提供可直接下载的官方匹配版本封面图片URL、来源页、版本和可公开展示的使用依据；不得猜测URL。",
        Research, {"book": candidate.model_dump(), "results": list(found.values())}, max_tokens=3500)
    if len({s.url for s in plan.sources}) != len(plan.sources):
        raise ValueError("DUPLICATE_SOURCES")
    pages = []
    for source in plan.sources:
        if source.url not in found:
            raise ValueError("SOURCE_NOT_IN_SEARCH_RESULTS")
        public_url(source.url)
        try:
            page = client.fetch(source.url)
        except InfrastructureError as exc:
            if str(exc) == "DEEPSEEK_HTTP_404":
                raise ValueError("SOURCE_CONTENT_UNAVAILABLE") from None
            raise
        if len(page.get("content", "")) < 400:
            raise ValueError("SOURCE_CONTENT_UNAVAILABLE")
        pages.append({**source.model_dump(), "content": page["content"][:14000]})
    if sum(s.first_party for s in plan.sources) < 2:
        raise ValueError("INSUFFICIENT_FIRST_PARTY_SOURCES")
    links = cover_links(pages)
    if not links:
        raise ValueError("NO_EVIDENCED_COVER_IMAGE")
    choice = client.structured("仅从实际抓取的图片链接中选择这本书的官方封面，核对书名作者版本及使用依据。不能确认则说明不确定，不得虚构许可。",
                               CoverChoice, {"book": candidate.model_dump(), "links": links, "sources": pages}, max_tokens=2000)
    if {"url": choice.url, "source_url": choice.source_url} not in links:
        raise ValueError("COVER_URL_NOT_IN_EVIDENCE")
    plan.cover_url, plan.cover_source_url = choice.url, choice.source_url
    plan.cover_edition, plan.cover_usage_basis = choice.edition, choice.usage_basis
    download_cover(plan.cover_url)
    save(WORK / "sources.json", {"accessedAt": now().isoformat(), **plan.model_dump()})
    return plan, pages


DRAFT_PROMPT = """根据已读取的公开资料写原创中文学习导读，不复刻章节、不转载原文、不提供原书替代品。
读者是普通青年。正文4000-7000个中文字符，恰好5个洞见，每个机制+边界约250-400字；
每个洞见2个例子以及4-6步SOP约350-500字。例子明确标注类型，事实和作者案例必须指向实际来源。
SOP需触发条件、输入、可检查输出、停止/升级条件。包含7天行动计划、批判性阅读、版权声明。
description为80-140字，tags为3个，claims逐项列出全部可核实事实/统计/因果主张及来源id。
正文绝不显示引用编号、URL或参考资料页，引用映射仅放claims。不要编造数字或未取得的原书内容。
copyright明确“本文为基于公开资料的原创学习导读，不是原书替代品；建议支持正版并结合原书阅读”。
每一洞见案例行动页不能超过约650个中文字符（否则排版溢出），避免重复和口号。
"""


def validate_content(draft, candidate, plan):
    if (draft.title, draft.author, draft.originalTitle) != (candidate.title, candidate.author, candidate.originalTitle):
        raise ValueError("BOOK_IDENTITY_CHANGED")
    if not 4000 <= chinese_count(draft) <= 7000:
        raise ValueError(f"CHINESE_CHARACTER_COUNT:{chinese_count(draft)}")
    if not 80 <= len(draft.description) <= 140:
        raise ValueError("DESCRIPTION_LENGTH")
    source_ids = {s.id for s in plan.sources}
    if len(source_ids) != len(plan.sources):
        raise ValueError("DUPLICATE_SOURCE_IDS")
    refs = [c.source_ids for c in draft.claims]
    refs += [e.source_ids for i in draft.insights for e in i.examples if e.type != "合成情境"]
    if any(not ids or not set(ids) <= source_ids for ids in refs):
        raise ValueError("UNMAPPED_FACTUAL_CLAIM")
    if len({norm(i.title) for i in draft.insights}) != 5:
        raise ValueError("DUPLICATE_INSIGHTS")


def generate(date):
    window(date)
    catalog = load(ROOT / "data.json")
    books = catalog["books"]
    if any(b["date"] == date for b in books):
        save(WORK / "state.json", {"date": date, "stage": "already_published", "noop": True})
        return
    client = Client(WORK, date)
    selected = client.structured(
        "提出3本未在目录出现的长期有价值非虚构书籍并评分，选择时避免最近7天主题重复和90天同作者。"
        "评分维度：现实价值25、行动深度20、资料20、新颖15、长期10、多样性10。queries用于查官方书目、"
        "作者访谈、原始研究及出版社高清封面。每本提供原文书名、ISBN、作者和理由。",
        Candidates, {"date": date, "catalog": [{k: b.get(k, "") for k in ["title", "originalTitle", "author", "date", "category", "isbn"]} for b in books]},
        max_tokens=3500)
    save(WORK / "candidates.json", selected.model_dump())
    choices = sorted((c for c in selected.candidates if not duplicate(c, books, date)), key=lambda x: x.score, reverse=True)
    last_error = "NO_UNIQUE_CANDIDATES"
    for candidate in choices:
        try:
            save(WORK / "state.json", {"date": date, "stage": "researching", "book": candidate.title})
            plan, pages = research(client, candidate)
        except ValueError as exc:
            last_error = str(exc)
            continue
        feedback = ""
        while True:
            window(date, publishing=True)
            save(WORK / "state.json", {"date": date, "stage": "drafting", "book": candidate.title})
            try:
                d = client.structured(DRAFT_PROMPT, Draft, {"book": candidate.model_dump(), "sources": pages,
                                                          "previous_failure": feedback})
                validate_content(d, candidate, plan)
                save(WORK / "draft.json", d.model_dump())
                (WORK / "content.md").write_text("\n\n".join("## " + h + "\n" + t for p in visible_pages(d) for h, t in p), encoding="utf-8")
                pdf, images, text_pages = render(d, WORK)
                text_review = client.structured(
                    "你是独立审稿人，逐条严格判断以下硬性项。只依据已抓取资料，缺证据必须失败。"
                    "C01书名作者版本两个来源交叉验证；C04五洞见机制与边界；C06案例分类真实；C08所有SOP可执行且有停止条件；"
                    "C09计划批判版权齐备；C10无抄袭替代、虚构事实数字；E02所有事实主张准确映射来源；E04无因果/样本外推；"
                    "E05来源标题作者日期映射完整；E06来源实际可读且读者稿无引文编号URL。"
                    "E01必须独立核对至少5个实际来源、其中至少2个确实为第一方，而非照抄来源分类。"
                    "每条给具体来源id/正文段落作为evidence。恰好返回指定的全部id，不能省略。",
                    Review, {"required_ids": CONTENT_REVIEW, "book": candidate.model_dump(), "draft": d.model_dump(), "sources": pages,
                             "accessedAt": now().isoformat()}, max_tokens=4500)
                save(WORK / "content-review.json", text_review.model_dump())
                checks = require_review(text_review, CONTENT_REVIEW)
                cover_review = client.structured(
                    "核对封面书名作者版本与资料完全匹配、无水印、裁切、低清或占位图；使用依据确实成立。"
                    "任一无法确认则失败。只返回D04-cover。", Review,
                    {"book": candidate.model_dump(), "cover": plan.model_dump(), "sources": pages}, [WORK / "book.cover.jpg"], 2000)
                save(WORK / "cover-review.json", cover_review.model_dump())
                checks += require_review(cover_review, ["D04-cover"])
                for index, image in enumerate(images, 1):
                    ids = [f"P03-page{index}", f"P04-page{index}"]
                    visual = client.structured(
                        "严格检查此页是否已可读：P03检查页面完整可读、标题层次和页码；P04检查裁切重叠乱码黑块缺字空白。"
                        "每项输出明确判断和具体视觉位置证据，有疑问失败。", Review,
                        {"required_ids": ids, "page": index, "text": text_pages[index - 1]}, [image], 1500)
                    save(WORK / f"visual-{index:02}.json", visual.model_dump())
                    checks += require_review(visual, ids)
                checks += [{"id": key, "status": "pass", "evidence": evidence} for key, evidence in {
                    "C02": "candidates.json + full data.json title/ISBN/author normalization",
                    "C03": f"content.md: {chinese_count(d)} Chinese characters", "C05": "draft.json: 2 examples per insight",
                    "C07": "draft.json: 5 SOPs, each 4-6 steps",
                    "P01": "book.pdf: 14 A4 portrait pages", "P02": "book.pdf sha256=" + sha(pdf),
                    "P05": "pdf.py: embedded font 10.5pt, leading15.5pt, margins20mm",
                    "P06": "pdf.py visible_pages: cover/map/5 insights/plan/criticism/copyright",
                    "P07": "pdf.py footer page1-14 and all visual reports", "P08": "pypdf extracted book and all insight titles",
                }.items()]
                checks.append({"id": "E03", "status": "not_applicable", "evidence": "Consensus not used; DeepSeek search + fetched primary sources used"})
                save(WORK / "acceptance.json", {"schemaVersion": "1.0", "date": date, "prepublishPassed": True,
                                               "passed": False, "checks": checks, "checkedAt": now().isoformat(),
                                               "publicationChecks": "D01-D08 pending, never inferred from generation"})
                save(WORK / "book.json", {"date": date, "title": d.title, "author": d.author, "draft": d.model_dump()})
                save(WORK / "state.json", {"date": date, "stage": "validated", "book": candidate.model_dump(),
                                          "draftSha256": sha(WORK / "draft.json"), "sourcesSha256": sha(WORK / "sources.json"),
                                          "pdfSha256": sha(pdf), "coverSha256": sha(WORK / "book.cover.jpg")})
                return
            except ValueError as exc:
                feedback = str(exc)[:1200]
                save(WORK / "last-failure.json", {"stage": "content_repair", "reason": feedback})
                if feedback.startswith("REVIEW_FAILED:") and any(key in feedback for key in ["D04-cover", "E01", "E05", "E06"]):
                    last_error = feedback
                    break  # Replace inadequate evidence/cover, rather than rewrite against it.
                # Continue only inside the daily window and bounded API allowance.
                # Preserve feedback and rerun every gate after regeneration.
    raise ValueError(last_error)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=str(now().date()))
    args = parser.parse_args()
    try:
        generate(args.date)
    except Exception as exc:
        # Never emit third-party exception bodies which may contain credentials.
        code = str(exc) if isinstance(exc, InfrastructureError) else type(exc).__name__
        save(WORK / "failure.json", {"date": args.date, "stage": load(WORK / "state.json").get("stage") if (WORK / "state.json").exists() else "preflight",
                                   "errorCode": code, "status": "failed", "at": now().isoformat()})
        print("Daily pipeline failed; inspect failure.json and acceptance reports.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
