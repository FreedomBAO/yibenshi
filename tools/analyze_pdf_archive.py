"""Inspect a ZIP of book-report PDFs without extracting files to disk."""

from __future__ import annotations

import argparse
import io
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path

from pypdf import PdfReader


DATE_PREFIX = re.compile(r"^(?P<date>\d{6}|\d{8})[_-]")


def title_from_filename(filename: str) -> str:
    stem = Path(filename).stem.strip()
    stem = DATE_PREFIX.sub("", stem)
    stem = re.sub(r"[-_]?报告$", "", stem).strip(" _-")
    return stem


def date_from_filename(filename: str) -> str:
    match = DATE_PREFIX.match(Path(filename).stem)
    if not match:
        return ""
    raw = match.group("date")
    fmt = "%Y%m%d" if len(raw) == 8 else "%y%m%d"
    try:
        return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def clean_text(text: str) -> str:
    text = text.replace("\u0000", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def inspect_pdf(data: bytes, max_pages: int) -> dict:
    reader = PdfReader(io.BytesIO(data))
    metadata = reader.metadata or {}
    pages = []
    for page in reader.pages[:max_pages]:
        pages.append(page.extract_text() or "")
    return {
        "pageCount": len(reader.pages),
        "metadataTitle": str(metadata.get("/Title", "") or "").strip(),
        "metadataAuthor": str(metadata.get("/Author", "") or "").strip(),
        "sampleText": clean_text("\n".join(pages)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--pages", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    records = []
    with zipfile.ZipFile(args.archive) as archive:
        for info in archive.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".pdf"):
                continue
            record = {
                "filename": info.filename,
                "title": title_from_filename(info.filename),
                "date": date_from_filename(info.filename),
                "size": info.file_size,
            }
            try:
                record.update(inspect_pdf(archive.read(info), args.pages))
            except Exception as error:  # one bad PDF must not stop the catalog
                record["error"] = f"{type(error).__name__}: {error}"
            records.append(record)

    payload = json.dumps(records, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
