"""Fixed 14-page Chinese layout: overflow fails instead of shrinking text."""
import hashlib
import os
import re
from pathlib import Path
from xml.sax.saxutils import escape

import fitz
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Frame, Paragraph, Spacer

from .models import Draft


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def visible_pages(d: Draft):
    pages = [[("每日精读", d.title), ("原文书名", d.originalTitle), ("作者", d.author),
              ("一句话价值", d.value), ("阅读时间", "约20分钟")],
             [("阅读地图", d.reading_map)] + [(str(i + 1), x.title) for i, x in enumerate(d.insights)]]
    for i, x in enumerate(d.insights, 1):
        pages.append([(f"洞见 {i} · {x.title}", x.judgment), ("为什么成立", x.mechanism),
                      ("适用边界", x.boundary), ("自检问题", x.question)])
        s = x.sop
        pages.append([(f"洞见 {i} · 例子与行动", "")]
                     + [(f"例子 {j + 1} [{e.type}]", e.text) for j, e in enumerate(x.examples)]
                     + [("SOP · 触发条件", s.trigger), ("所需输入", s.inputs)]
                     + [(f"步骤 {j + 1}", step) for j, step in enumerate(s.steps)]
                     + [("可检查输出", s.output), ("停止或升级条件", s.stop)])
    pages.append([("7天行动计划", "从一次小实验开始，记录输出与边界。")]
                 + [(f"第{i + 1}天", x) for i, x in enumerate(d.plan)])
    pages.append([("批判性阅读", d.criticism), ("版权与阅读边界", d.copyright)])
    return pages


def chinese_count(d):
    return len(re.findall(r"[\u3400-\u9fff]", "".join(a + b for p in visible_pages(d) for a, b in p)))


def render(d: Draft, output: Path):
    font_paths = [os.getenv("DAILY_BOOK_FONT", ""), "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
                  "C:/Windows/Fonts/simhei.ttf"]
    font = next((p for p in font_paths if p and Path(p).is_file()), None)
    if not font:
        raise RuntimeError("FONT_MISSING")
    pdfmetrics.registerFont(TTFont("BookCJK", font, subfontIndex=0))
    output.mkdir(parents=True, exist_ok=True)
    target = output / "book.pdf"
    canvas = Canvas(str(target), pagesize=A4)
    canvas.setTitle(d.title)
    canvas.setAuthor(d.author)
    style = ParagraphStyle("Body", fontName="BookCJK", fontSize=10.5, leading=15.5,
                           wordWrap="CJK", textColor=colors.HexColor("#252923"), alignment=TA_LEFT)
    label = ParagraphStyle("Label", parent=style, fontSize=12, leading=17,
                           textColor=colors.HexColor("#35604b"), spaceBefore=7, spaceAfter=3)
    width, height = A4
    for number, sections in enumerate(visible_pages(d), 1):
        canvas.setFillColor(colors.HexColor("#faf7ee"))
        canvas.rect(0, 0, width, height, fill=1, stroke=0)
        canvas.setFont("BookCJK", 9)
        canvas.setFillColor(colors.HexColor("#64715f"))
        canvas.drawString(20 * mm, height - 16 * mm, "每日精读 · 原创学习导读")
        canvas.drawRightString(width - 20 * mm, 14 * mm, f"{number} / 14")
        story = []
        for section_index, (heading, text) in enumerate(sections):
            title_style = ParagraphStyle("CoverTitle", parent=style, fontSize=23, leading=32, spaceAfter=15)
            story += [Paragraph(escape(heading), label)]
            if text:
                body_style = title_style if number == 1 and section_index == 0 else style
                story += [Paragraph(escape(text).replace("\n", "<br/>"), body_style), Spacer(1, 4)]
        frame = Frame(20 * mm, 22 * mm, width - 40 * mm, height - 46 * mm,
                      leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        frame.addFromList(story, canvas)
        if story:
            raise ValueError(f"PDF_PAGE_OVERFLOW:{number}")
        canvas.showPage()
    canvas.save()
    reader = PdfReader(str(target))
    if len(reader.pages) != 14 or not 50_000 <= target.stat().st_size <= 10_000_000:
        raise ValueError("PDF_SIZE_OR_PAGE_COUNT")
    text_pages = [page.extract_text() or "" for page in reader.pages]
    full = "\n".join(text_pages)
    if any(len(x.strip()) < 30 for x in text_pages):
        raise ValueError("PDF_EMPTY_PAGE")
    if not all(x in full for x in [d.title] + [i.title for i in d.insights]):
        raise ValueError("PDF_TEXT_EXTRACTION")
    if re.search(r"https?://|\[S\d+\]|参考资料", full):
        raise ValueError("PDF_READER_CITATIONS")
    doc = fitz.open(target)
    images = []
    for number, page in enumerate(doc, 1):
        path = output / f"page-{number:02}.png"
        page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6)).save(path)
        images.append(path)
    doc.close()
    return target, images, text_pages
