"""Build data.json book records from structured PDF reports inside a ZIP."""

from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import zipfile
from datetime import datetime
from pathlib import Path

from pypdf import PdfReader


DATE_PREFIX = re.compile(r"^(?P<date>\d{6}|\d{8})[_-]")
STOP_FIELDS = (
    "出版年份", "出版社", "出版时间", "页数", "豆瓣评分", "核心主题", "核心定位",
    "书籍类型", "类型", "标签", "一句话", "内容地图", "知识点", "目录",
)

CATEGORY_TITLES = {
    "沟通与关系": {"非暴力沟通", "关键对话", "影响力", "被讨厌的勇气"},
    "金融与经济": {"穷查理宝典", "卧底经济学", "金钱心理学", "稀缺", "黑天鹅", "反脆弱", "纳瓦尔宝典"},
    "商业与创新": {"创新者的窘境", "从零到一", "创业维艰", "精益创业", "定位", "第二曲线", "黑客与画家"},
    "科技与未来": {"技术的本质", "失控", "未来简史"},
    "历史与文明": {"人类简史", "枪炮病菌与钢铁", "自私的基因", "孙子兵法"},
    "哲学与思辨": {"苏菲的世界", "有限与无限的游戏", "活出生命的意义", "当下的力量", "幸福的方法", "智识分子"},
    "学习方法": {"学会提问", "学习之道", "刻意练习", "金字塔原理", "打造第二大脑"},
    "决策与系统": {"策略思维", "原则", "清单革命", "超预测", "模型思考者", "系统之美", "助推", "噪声", "熵减法则"},
    "认知与心理": {"思考快与慢", "思考，快与慢", "认知觉醒", "心流", "自控力", "怪诞行为学", "清醒思考的艺术", "设计心理学"},
}

KEYWORD_TAGS = {
    "习惯": "习惯养成", "时间": "时间管理", "学习": "学习方法", "认知": "认知升级",
    "思考": "思维模型", "心理": "心理学", "决策": "决策方法", "系统": "系统思维",
    "创新": "创新", "创业": "创业", "经济": "经济学", "金钱": "财富观",
    "沟通": "沟通", "对话": "沟通", "历史": "历史", "未来": "未来趋势",
    "技术": "科技", "生命": "生命意义", "幸福": "幸福", "设计": "设计",
}

AUTHOR_OVERRIDES = {
    "穷查理宝典": "彼得·考夫曼 编",
    "刻意练习": "安德斯·艾利克森 / 罗伯特·普尔",
    "策略思维": "阿维纳什·K·迪克西特 / 巴里·J·奈尔伯夫",
    "枪炮病菌与钢铁": "贾雷德·戴蒙德",
    "关键对话": "科里·帕特森 / 约瑟夫·格雷尼 / 罗恩·麦克米兰 / 艾尔·史威茨勒",
    "噪声": "丹尼尔·卡尼曼 / 奥利维耶·西博尼 / 卡斯·桑斯坦",
    "助推": "理查德·塞勒 / 卡斯·桑斯坦",
    "黑客与画家": "保罗·格雷厄姆",
    "技术的本质": "W·布莱恩·阿瑟",
    "熵减法则": "何圣君",
    "孙子兵法": "孙武",
    "清醒思考的艺术": "罗尔夫·多贝里",
}

CATEGORY_OVERRIDES = {
    "把时间当作朋友": "个人成长",
    "从一到无穷大": "学习方法",
    "熵减法则": "个人成长",
    "跃迁": "个人成长",
    "高效能人士的七个习惯": "个人成长",
}


def title_from_filename(filename: str) -> str:
    stem = Path(filename).stem.strip()
    stem = DATE_PREFIX.sub("", stem)
    return re.sub(r"[-_]?报告$", "", stem).strip(" _-")


def date_from_filename(filename: str) -> str:
    match = DATE_PREFIX.match(Path(filename).stem)
    if not match:
        return ""
    raw = match.group("date")
    try:
        return datetime.strptime(raw, "%Y%m%d" if len(raw) == 8 else "%y%m%d").strftime("%Y-%m-%d")
    except ValueError:
        return ""


def canonical_title(title: str) -> str:
    return re.sub(r"[\s\W_]+", "", title, flags=re.UNICODE).lower()


def clean_text(text: str) -> str:
    text = text.replace("\u0000", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_text(data: bytes) -> tuple[str, int]:
    reader = PdfReader(io.BytesIO(data))
    pages = [(page.extract_text() or "") for page in reader.pages]
    return clean_text("\n".join(pages)), len(reader.pages)


def after_label(text: str, labels: list[str], limit: int = 500) -> str:
    for label in labels:
        match = re.search(re.escape(label) + r"\s*[：:]?\s*", text, re.IGNORECASE)
        if not match:
            continue
        value = text[match.end():match.end() + limit]
        stops = "|".join(re.escape(item) for item in STOP_FIELDS if item != label)
        value = re.split(r"\n\s*\n|" + stops, value, maxsplit=1)[0]
        return value.strip(" \n：:-—*#")
    return ""


def trim_text(value: str, maximum: int) -> str:
    value = re.sub(r"[#*_`>|]+", "", value)
    value = re.sub(r"\s+", " ", value).strip(" ，,。;；:-—")
    if len(value) <= maximum:
        return value
    cut = value[:maximum]
    sentence = max(cut.rfind("。"), cut.rfind("；"), cut.rfind("！"))
    return cut[:sentence + 1] if sentence > maximum // 2 else cut.rstrip() + "…"


def extract_author(text: str) -> str:
    head = text[:5000]
    match = re.search(r"(?:作者|编者)\s*[：:]?\s*", head)
    author = ""
    if match:
        tail = head[match.end():match.end() + 180]
        stops = r"\n|" + "|".join(re.escape(item) for item in STOP_FIELDS)
        author = re.split(stops, tail, maxsplit=1)[0]
    if not author:
        fallback = re.search(r"([A-Z][A-Za-z.\s]{3,50}\s+编)(?=\s|\n|$)", head)
        author = fallback.group(1) if fallback else "待补充"
    author = trim_text(author, 80)
    if re.search(r"[\u4e00-\u9fff]", author):
        author = re.sub(r"[（(][^）)]*[A-Za-z][^）)]*[）)]", "", author).strip()
    return author or "待补充"


def extract_original_title(text: str, title: str) -> str:
    head = text[:2500]
    pattern = re.escape(title) + r"[^\n]{0,12}[（(]([A-Za-z][^）)\n]{2,120})[）)]"
    match = re.search(pattern, head, re.IGNORECASE)
    return trim_text(match.group(1), 100) if match else ""


def extract_highlights(text: str) -> list[str]:
    candidates = []
    patterns = [
        r"知识点\s*\d+\s*[：:]?\s*([^\n]{5,100})",
        r"(?:^|\n)\s*\d+[.、]\s*([^\n]{5,100})",
        r"(?:├──|└──)\s*(?:\d+[.、]\s*)?([^\n│]{5,90})",
        r"(?:^|\n)#{2,3}\s*([^\n]{5,90})",
    ]
    for pattern in patterns:
        candidates.extend(re.findall(pattern, text[:14000], re.MULTILINE))
    output = []
    for item in candidates:
        item = trim_text(item, 72)
        item = re.sub(r"^[一二三四五六七八九十]+[、.：:]\s*", "", item)
        if len(item) < 5 or any(word in item for word in ("目录", "书籍信息", "知识点总数", "每日认知")):
            continue
        key = canonical_title(item)
        if key and all(canonical_title(existing) != key for existing in output):
            output.append(item)
        if len(output) == 5:
            break
    return output


def extract_description(text: str, title: str, highlights: list[str]) -> str:
    theme = after_label(text[:7000], ["一句话推荐", "核心主题一句话概括", "一句话核心", "一句话总结", "核心定位"], 650)
    intro = after_label(text[:12000], ["书籍简介", "内容简介", "为什么推荐这本书", "为什么今天推荐这本书"], 900)
    pieces = [trim_text(item, 240) for item in (theme, intro) if len(trim_text(item, 240)) >= 15]
    description = " ".join(dict.fromkeys(pieces))
    if not description and highlights:
        description = f"《{title}》围绕" + "、".join(highlights[:3]) + "展开，系统梳理核心观点及其在现实生活中的应用。"
    if not description:
        description = f"《{title}》从核心概念、思维框架与实践方法三个层面展开，帮助读者建立可复用的认知与行动体系。"
    if len(description) < 110 and highlights:
        description += " 全书重点讨论" + "、".join(highlights[:3]) + "，并给出可用于现实决策与日常实践的方法。"
    if len(description) < 110:
        description += f" 这份精读将《{title}》的关键思想整理为容易理解、可以复盘并能够立即用于工作与生活的行动框架。"
    return trim_text(description, 360)


def extract_action(text: str, title: str, highlights: list[str]) -> str:
    action = after_label(text, ["今日行动", "行动建议", "行动清单", "实践清单", "可执行建议"], 700)
    action = trim_text(action, 180)
    if len(action) >= 12:
        return action
    focus = highlights[0] if highlights else "一个最有启发的观点"
    return f"从《{title}》中选择“{focus}”，结合当前生活或工作写下一个今天就能完成的小行动，并在一周后复盘结果。"


def classify(title: str, text: str) -> str:
    if title in CATEGORY_OVERRIDES:
        return CATEGORY_OVERRIDES[title]
    for category, titles in CATEGORY_TITLES.items():
        if title in titles:
            return category
    sample = title + " " + text[:1800]
    keyword_categories = [
        ("沟通与关系", ("沟通", "人际", "关系", "对话")),
        ("商业与创新", ("商业", "创业", "创新", "产品")),
        ("金融与经济", ("经济", "投资", "财富", "金钱")),
        ("科技与未来", ("科技", "技术", "人工智能", "未来")),
        ("历史与文明", ("历史", "文明", "进化")),
        ("学习方法", ("学习", "提问", "记忆", "知识管理")),
        ("决策与系统", ("决策", "策略", "系统", "模型")),
        ("哲学与思辨", ("哲学", "意义", "存在", "幸福")),
    ]
    for category, keywords in keyword_categories:
        if any(keyword in sample for keyword in keywords):
            return category
    return "个人成长"


def build_tags(title: str, text: str, category: str) -> list[str]:
    tags = [category.replace("与", "")]
    tags.extend(re.findall(r"#([^#\s，,。]{2,12})", text[:3000]))
    sample = title + text[:3000]
    for keyword, tag in KEYWORD_TAGS.items():
        if keyword in sample:
            tags.append(tag)
    output = []
    for tag in tags:
        tag = trim_text(tag, 12)
        if tag and tag not in output:
            output.append(tag)
        if len(output) == 5:
            break
    while len(output) < 3:
        fallback = ("经典阅读", "方法论", "个人成长")[len(output) % 3]
        if fallback not in output:
            output.append(fallback)
    return output


def extract_rating(text: str) -> str:
    match = re.search(r"豆瓣评分\s*[：:]?\s*(\d(?:\.\d)?)", text[:5000])
    return match.group(1) if match else "8.5"


def load_base(ref: str | None, path: Path | None) -> dict:
    if ref:
        raw = subprocess.check_output(["git", "show", ref], text=True, encoding="utf-8")
        return json.loads(raw)
    if path:
        return json.loads(path.read_text(encoding="utf-8"))
    return {"books": []}


def choose_unique_pdfs(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    selected = {}
    for info in archive.infolist():
        if info.is_dir() or not info.filename.lower().endswith(".pdf"):
            continue
        title = title_from_filename(info.filename)
        key = canonical_title(title)
        date_score = date_from_filename(info.filename).replace("-", "")
        score = (date_score or "00000000", info.file_size)
        if key not in selected or score > selected[key][0]:
            selected[key] = (score, info)
    return [item[1] for item in sorted(selected.values(), key=lambda item: (date_from_filename(item[1].filename), item[1].filename))]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--base-ref")
    parser.add_argument("--base-file", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    data = load_base(args.base_ref, args.base_file)
    books = data.get("books", [])
    existing = {canonical_title(book.get("title", "")): book for book in books}
    next_id = max((int(book.get("id", 0)) for book in books), default=0) + 1
    report = []

    with zipfile.ZipFile(args.archive) as archive:
        for info in choose_unique_pdfs(archive):
            title = title_from_filename(info.filename)
            key = canonical_title(title)
            if key in existing:
                report.append({"filename": info.filename, "title": title, "status": "merged-existing", "id": existing[key]["id"]})
                continue
            text, pages = extract_text(archive.read(info))
            highlights = extract_highlights(text)
            while len(highlights) < 3:
                fallback = (
                    f"理解《{title}》提出的核心问题与基本框架",
                    "把抽象观点转化为可观察、可执行的现实方法",
                    "通过复盘与实践形成适合自己的长期行动体系",
                )[len(highlights)]
                highlights.append(fallback)
            category = classify(title, text)
            book = {
                "id": next_id,
                "date": date_from_filename(info.filename) or datetime.now().strftime("%Y-%m-%d"),
                "title": title,
                "originalTitle": extract_original_title(text, title),
                "author": AUTHOR_OVERRIDES.get(title, extract_author(text)),
                "description": extract_description(text, title, highlights),
                "tags": build_tags(title, text, category),
                "highlights": highlights[:5],
                "action": extract_action(text, title, highlights),
                "duration": "",
                "rating": extract_rating(text),
                "category": category,
                "cover": "",
                "pdf": "",
                "pdfUrl": "",
            }
            books.append(book)
            existing[key] = book
            report.append({
                "filename": info.filename,
                "title": title,
                "status": "added",
                "id": next_id,
                "author": book["author"],
                "pages": pages,
            })
            next_id += 1

    args.output.write_text(json.dumps({"books": books}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
