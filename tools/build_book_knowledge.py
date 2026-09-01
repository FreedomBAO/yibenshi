"""从 data.json 对应的 PDF 构建按页可引用的轻量知识库。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data.json"
OUTPUT_PATH = ROOT / "knowledge" / "books.json"
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 160


def normalize_text(text: str) -> str:
    text = text.replace("\u0000", " ").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_page(text: str) -> list[str]:
    if len(text) <= CHUNK_SIZE:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        if end < len(text):
            candidates = [
                text.rfind(mark, start + CHUNK_SIZE // 2, end)
                for mark in ("\n\n", "。", "！", "？", "；", "\n")
            ]
            boundary = max(candidates)
            if boundary > start:
                end = boundary + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return chunks


def local_pdf_path(book: dict) -> Path:
    source = book.get("pdf") or book.get("pdfUrl") or ""
    url_path = urlparse(source).path if "://" in source else source
    filename = Path(url_path).name
    if not filename:
        raise FileNotFoundError(f"《{book['title']}》没有 PDF 文件名")
    return ROOT / "assets" / "pdfs" / filename


def build_book(book: dict) -> dict:
    pdf_path = local_pdf_path(book)
    if not pdf_path.exists():
        raise FileNotFoundError(f"《{book['title']}》缺少 PDF：{pdf_path}")

    reader = PdfReader(str(pdf_path))
    chunks = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = normalize_text(page.extract_text() or "")
        for part_number, part in enumerate(split_page(text), start=1):
            chunks.append({"page": page_number, "part": part_number, "text": part})

    if not chunks:
        raise ValueError(f"《{book['title']}》未提取到任何文字")

    return {
        "id": book["id"],
        "title": book["title"],
        "author": book.get("author", ""),
        "description": book.get("description", ""),
        "highlights": book.get("highlights", []),
        "action": book.get("action", ""),
        "pdf": book.get("pdf") or book.get("pdfUrl", ""),
        "pageCount": len(reader.pages),
        "chunks": chunks,
    }


def main() -> None:
    books = json.loads(DATA_PATH.read_text(encoding="utf-8"))["books"]
    knowledge = {str(book["id"]): build_book(book) for book in books}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(knowledge, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    total_chunks = sum(len(book["chunks"]) for book in knowledge.values())
    print(
        f"已生成 {len(knowledge)} 本书、{total_chunks} 个文本片段："
        f"{OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size / 1024 / 1024:.2f} MB)"
    )


if __name__ == "__main__":
    main()
