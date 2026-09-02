import base64
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "tools" / "upload_daily_book.py"
SPEC = importlib.util.spec_from_file_location("upload_daily_book", SCRIPT_PATH)
uploader = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(uploader)


def make_pdf(path: Path) -> None:
    content = bytearray(b" " * (55 * 1024))
    content[:9] = b"%PDF-1.7\n"
    content[-7:] = b"\n%%EOF\n"
    path.write_bytes(content)


def valid_metadata(title: str = "底层逻辑") -> dict:
    return {
        "book_name": title,
        "book_name_en": "Underlying Logic",
        "author": "刘润",
        "intro": "这是一本帮助普通读者理解复杂问题、建立判断框架并把核心知识转化为可执行行动的精读报告。",
        "tags": ["认知", "思维模型", "方法论"],
        "highlights": ["从基本事实开始判断", "区分事实观点和立场", "用行动结果校正模型"],
        "action_advice": "选择今天的一项判断，分别写下事实、观点和立场，再决定下一步行动。",
        "category": "认知提升",
        "read_minutes": 20,
        "cover": "",
    }


class UploadDailyBookTests(unittest.TestCase):
    def test_selects_latest_complete_pair(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            make_pdf(folder / "older.pdf")
            (folder / "older.json").write_text(json.dumps(valid_metadata()), encoding="utf-8")
            make_pdf(folder / "newer-without-json.pdf")

            pdf_path, json_path = uploader.find_pdf_json_pair(folder)
            self.assertEqual(pdf_path.name, "older.pdf")
            self.assertEqual(json_path.name, "older.json")

    def test_rejects_invalid_highlights(self):
        metadata = valid_metadata()
        metadata["highlights"] = ["只有一条"]
        with self.assertRaisesRegex(uploader.UploadError, "highlights"):
            uploader.validate_metadata(metadata)

    def test_builds_base64_payload_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            pdf_path = folder / "底层逻辑.pdf"
            json_path = folder / "底层逻辑.json"
            make_pdf(pdf_path)
            json_path.write_text(json.dumps(valid_metadata(), ensure_ascii=False), encoding="utf-8")

            payload, pdf_hash = uploader.build_payload(pdf_path, json_path)
            self.assertEqual(payload["file_name"], "底层逻辑.pdf")
            self.assertTrue(base64.b64decode(payload["file_base64"]).startswith(b"%PDF-"))
            self.assertEqual(len(pdf_hash), 64)

    def test_receipt_matches_only_same_pdf(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "book.uploaded.json"
            path.write_text(json.dumps({"ok": True, "pdf_sha256": "abc"}), encoding="utf-8")
            self.assertIsNotNone(uploader.matching_receipt(path, "abc"))
            self.assertIsNone(uploader.matching_receipt(path, "different"))

    def test_cleanup_local_artifacts_preserves_final_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            pdf_path = folder / "底层逻辑.pdf"
            json_path = folder / "底层逻辑.json"
            make_pdf(pdf_path)
            json_path.write_text(json.dumps(valid_metadata()), encoding="utf-8")
            artifacts = [
                folder / "底层逻辑.pdf.tmp",
                folder / "底层逻辑.pdf.bak",
                folder / "底层逻辑.json.tmp",
                folder / "底层逻辑.json.bak",
                folder / ".build_底层逻辑.html",
            ]
            for artifact in artifacts:
                artifact.write_text("temporary", encoding="utf-8")
            unrelated = folder / "另一本书.pdf.tmp"
            unrelated.write_text("keep", encoding="utf-8")

            removed = uploader.cleanup_local_artifacts(pdf_path, json_path)
            self.assertEqual(set(removed), {path.name for path in artifacts})
            self.assertTrue(pdf_path.exists())
            self.assertTrue(json_path.exists())
            self.assertTrue(unrelated.exists())

    def test_verify_uploaded_pdf_checks_type_size_and_hash(self):
        content = b"%PDF-1.7\ncontent\n%%EOF\n"

        class Response:
            headers = {"Content-Type": "application/pdf"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _limit):
                return content

        uploader.verify_uploaded_pdf(
            "https://blob.example/book.pdf",
            hashlib.sha256(content).hexdigest(),
            len(content),
            opener=lambda *_args, **_kwargs: Response(),
        )

        with self.assertRaisesRegex(uploader.UploadError, "SHA-256"):
            uploader.verify_uploaded_pdf(
                "https://blob.example/book.pdf",
                "0" * 64,
                len(content),
                opener=lambda *_args, **_kwargs: Response(),
            )


if __name__ == "__main__":
    unittest.main()
