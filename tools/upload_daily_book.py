"""Upload the newest local daily-book PDF/JSON pair to the Vercel ingest API."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_PDF_DIR = Path.home() / "Documents" / "DailyBooks" / "pdf"
DEFAULT_ENDPOINT = "https://dailybooks-three.vercel.app/api/coze-ingest"
MIN_PDF_BYTES = 50 * 1024
MAX_PDF_BYTES = 10 * 1024 * 1024


class UploadError(RuntimeError):
    """A safe, user-facing upload failure."""


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def find_pdf_json_pair(pdf_dir: Path, explicit_pdf: Path | None = None) -> tuple[Path, Path]:
    if not pdf_dir.is_dir():
        raise UploadError(f"输出目录不存在：{pdf_dir}")

    if explicit_pdf is not None:
        pdf_path = explicit_pdf.resolve()
        if not pdf_path.is_file() or pdf_path.suffix.lower() != ".pdf":
            raise UploadError(f"PDF 文件不存在或扩展名错误：{pdf_path}")
        json_path = pdf_path.with_suffix(".json")
        if not json_path.is_file():
            raise UploadError(f"缺少同名 JSON：{json_path}")
        return pdf_path, json_path

    candidates = sorted(
        pdf_dir.glob("*.pdf"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for pdf_path in candidates:
        json_path = pdf_path.with_suffix(".json")
        if json_path.is_file():
            return pdf_path.resolve(), json_path.resolve()
    raise UploadError(f"没有找到同名的 PDF/JSON 文件对：{pdf_dir}")


def require_string(data: dict[str, Any], key: str, minimum: int, maximum: int, errors: list[str]) -> str:
    value = data.get(key)
    text = value.strip() if isinstance(value, str) else ""
    if not minimum <= len(text) <= maximum:
        errors.append(f"{key} 长度必须在 {minimum}-{maximum} 个字符之间")
    return text


def require_string_array(
    data: dict[str, Any],
    key: str,
    minimum: int,
    maximum: int,
    item_maximum: int,
    errors: list[str],
) -> list[str]:
    value = data.get(key)
    if not isinstance(value, list):
        errors.append(f"{key} 必须是字符串数组")
        return []
    items = [item.strip() if isinstance(item, str) else "" for item in value]
    if not minimum <= len(items) <= maximum:
        errors.append(f"{key} 必须包含 {minimum}-{maximum} 项")
    if any(not item or len(item) > item_maximum for item in items):
        errors.append(f"{key} 每一项必须是 1-{item_maximum} 个字符的非空字符串")
    return items


def validate_metadata(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise UploadError("JSON 顶层必须是对象")

    errors: list[str] = []
    metadata = {
        "book_name": require_string(data, "book_name", 1, 100, errors),
        "book_name_en": str(data.get("book_name_en") or "").strip()[:160],
        "author": require_string(data, "author", 1, 100, errors),
        "intro": require_string(data, "intro", 40, 1000, errors),
        "tags": require_string_array(data, "tags", 2, 5, 20, errors),
        "highlights": require_string_array(data, "highlights", 3, 3, 120, errors),
        "action_advice": require_string(data, "action_advice", 10, 500, errors),
        "category": require_string(data, "category", 1, 30, errors),
        "cover": str(data.get("cover") or "").strip(),
    }

    read_minutes = data.get("read_minutes")
    if isinstance(read_minutes, bool) or not isinstance(read_minutes, int) or not 5 <= read_minutes <= 120:
        errors.append("read_minutes 必须是 5-120 之间的整数")
    metadata["read_minutes"] = read_minutes

    cover = metadata["cover"]
    if cover and not cover.startswith(("https://", "http://")):
        errors.append("cover 必须是 http(s) URL 或空字符串")

    if errors:
        raise UploadError("JSON 校验失败：\n- " + "\n- ".join(errors))
    return metadata


def read_and_validate_pdf(path: Path) -> bytes:
    content = path.read_bytes()
    if not MIN_PDF_BYTES <= len(content) <= MAX_PDF_BYTES:
        raise UploadError(f"PDF 大小必须在 {MIN_PDF_BYTES}-{MAX_PDF_BYTES} 字节之间")
    if not content.startswith(b"%PDF-"):
        raise UploadError("文件头不是有效的 PDF")
    if b"%%EOF" not in content[-4096:]:
        raise UploadError("PDF 缺少结束标记，文件可能尚未写完")
    return content


def build_payload(pdf_path: Path, json_path: Path) -> tuple[dict[str, Any], str]:
    try:
        raw_metadata = json.loads(json_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise UploadError(f"无法读取 JSON：{error}") from error

    metadata = validate_metadata(raw_metadata)
    pdf = read_and_validate_pdf(pdf_path)
    pdf_hash = hashlib.sha256(pdf).hexdigest()
    return {
        "file_base64": base64.b64encode(pdf).decode("ascii"),
        "file_name": pdf_path.name,
        **metadata,
    }, pdf_hash


def post_payload(endpoint: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "daily-book-local-uploader/1.0",
        },
    )
    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            detail = {"error": f"HTTP {error.code}"}
        message = detail.get("error", f"HTTP {error.code}")
        details = detail.get("details")
        if isinstance(details, list) and details:
            message += "：" + "；".join(str(item) for item in details)
        raise UploadError(message) from error
    except (URLError, TimeoutError) as error:
        raise UploadError(f"无法连接接收接口：{error}") from error

    if not isinstance(result, dict) or not result.get("ok"):
        raise UploadError("接收接口未返回成功结果")
    return result


def receipt_path(pdf_path: Path) -> Path:
    return pdf_path.with_suffix(".uploaded.json")


def matching_receipt(path: Path, pdf_hash: str) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return receipt if receipt.get("pdf_sha256") == pdf_hash and receipt.get("ok") is True else None


def save_receipt(path: Path, result: dict[str, Any], pdf_hash: str) -> None:
    job = result.get("job") if isinstance(result.get("job"), dict) else {}
    safe_receipt = {
        "ok": True,
        "duplicate": bool(result.get("duplicate")),
        "pdf_sha256": pdf_hash,
        "job_id": job.get("jobId"),
        "status": job.get("status"),
        "business_date": job.get("businessDate"),
        "pdf_url": (job.get("pdf") or {}).get("url") if isinstance(job.get("pdf"), dict) else None,
        "manifest_url": result.get("manifestUrl"),
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(safe_receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="上传最新的每日精读 PDF/JSON 文件对")
    parser.add_argument("--pdf-dir", type=Path, default=DEFAULT_PDF_DIR, help="PDF/JSON 输出目录")
    parser.add_argument("--pdf", type=Path, help="指定某个 PDF；默认选择最新的完整文件对")
    parser.add_argument("--endpoint", default=None, help="覆盖接收接口 URL")
    parser.add_argument("--dry-run", action="store_true", help="只校验，不上传")
    parser.add_argument("--force", action="store_true", help="忽略已有上传回执，再次调用接口")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = Path(__file__).resolve().parents[1]
    env_file = load_env_file(repo_root / ".env.local")
    endpoint = args.endpoint or os.environ.get("COZE_INGEST_URL") or DEFAULT_ENDPOINT
    token = os.environ.get("COZE_INGEST_TOKEN") or env_file.get("COZE_INGEST_TOKEN", "")

    try:
        pdf_path, json_path = find_pdf_json_pair(args.pdf_dir.resolve(), args.pdf)
        payload, pdf_hash = build_payload(pdf_path, json_path)
        existing = matching_receipt(receipt_path(pdf_path), pdf_hash)
        if existing and not args.force:
            print(json.dumps({"ok": True, "skipped": True, "reason": "already_uploaded", **existing}, ensure_ascii=False))
            return 0
        if args.dry_run:
            print(json.dumps({
                "ok": True,
                "dry_run": True,
                "pdf": str(pdf_path),
                "json": str(json_path),
                "pdf_bytes": len(base64.b64decode(payload["file_base64"])),
                "book_name": payload["book_name"],
            }, ensure_ascii=False))
            return 0
        if not token:
            raise UploadError("缺少 COZE_INGEST_TOKEN，请配置项目根目录 .env.local")

        result = post_payload(endpoint, token, payload)
        save_receipt(receipt_path(pdf_path), result, pdf_hash)
        job = result.get("job", {})
        print(json.dumps({
            "ok": True,
            "duplicate": bool(result.get("duplicate")),
            "job_id": job.get("jobId"),
            "status": job.get("status"),
            "pdf_url": (job.get("pdf") or {}).get("url"),
        }, ensure_ascii=False))
        return 0
    except UploadError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
