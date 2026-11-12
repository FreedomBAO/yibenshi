import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.cloud_daily.client import Client, InfrastructureError, TZ, window
from tools.cloud_daily.models import Candidate, Review
from tools.cloud_daily.pdf import render, chinese_count
from tools.cloud_daily.pipeline import duplicate, public_url, require_review
from tools.cloud_daily.selfcheck import fixture
from tools.cloud_daily.release import catalog, preflight
from tools import build_book_knowledge
from tools.cloud_daily.client import save


class DailyBookTests(unittest.TestCase):
    def test_missing_secrets_fail_before_paid_generation(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(InfrastructureError, "MISSING_CONFIGURATION"):
                preflight(True)

    def test_budget_is_checked_before_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "test-only", "DAILY_BOOK_MAX_USD": "0.01"}):
            client = Client(directory, "2026-11-12")
            with patch("tools.cloud_daily.client.now", return_value=dt.datetime(2026, 11, 12, 2, tzinfo=TZ)), patch("requests.post") as post:
                with self.assertRaisesRegex(InfrastructureError, "DAILY_COST_LIMIT_REACHED"):
                    client.request("/chat/completions", {}, .02)
                post.assert_not_called()

    def test_authentication_error_is_not_content_repair_or_logged_secret(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "test-secret-never-in-artifact"}):
            client = Client(directory, "2026-11-12")
            with patch("tools.cloud_daily.client.now", return_value=dt.datetime(2026, 11, 12, 2, tzinfo=TZ)), patch("requests.post") as post:
                post.return_value.status_code = 401
                with self.assertRaisesRegex(InfrastructureError, "DEEPSEEK_HTTP_401"):
                    client.request("/chat/completions", {}, .001)
            self.assertNotIn("test-secret", (Path(directory) / "usage.json").read_text())

    def test_offline_fixture_cannot_be_published(self):
        with patch("tools.cloud_daily.release.load", side_effect=[
            {"fixture": True, "date": "2026-11-12", "stage": "validated"}, {"prepublishPassed": True}, {}]), patch("tools.cloud_daily.release.window"):
            with self.assertRaisesRegex(InfrastructureError, "NOT_ACCEPTED"):
                catalog()

    def test_incremental_knowledge_preserves_historical_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, _, _ = render(fixture(), root / "pdf")
            data = root / "data.json"
            output = root / "knowledge.json"
            old = {"id": 7, "title": "旧书", "chunks": [{"page": 1, "text": "历史内容", "part": 1}]}
            save(data, {"books": [{"id": 7, "title": "旧书"}, {"id": 8, "title": fixture().title, "pdf": "https://example.com/book.pdf"}]})
            save(output, {"7": old})
            with patch.object(build_book_knowledge, "DATA_PATH", data), patch.object(build_book_knowledge, "OUTPUT_PATH", output), patch("sys.argv", ["build", "--book-id", "8", "--pdf", str(pdf)]):
                build_book_knowledge.main()
            import json
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["7"], old)
            self.assertEqual(result["8"]["pageCount"], 14)
            self.assertIn(fixture().title, result["8"]["chunks"][0]["text"])

    def test_window_and_publish_buffer(self):
        for hour, minute, allowed, publishing in [(2, 0, True, False), (1, 59, False, False),
                (7, 39, True, True), (7, 40, False, True), (7, 59, True, False), (8, 0, False, False)]:
            with patch("tools.cloud_daily.client.now", return_value=dt.datetime(2026, 11, 12, hour, minute, tzinfo=TZ)):
                if allowed:
                    window("2026-11-12", publishing)
                else:
                    with self.assertRaises(InfrastructureError):
                        window("2026-11-12", publishing)

    def test_previous_date_is_not_replayed(self):
        with patch("tools.cloud_daily.client.now", return_value=dt.datetime(2026, 11, 13, 2, tzinfo=TZ)):
            with self.assertRaises(InfrastructureError):
                window("2026-11-12")

    def test_title_normalization_and_author_cooldown(self):
        candidate = Candidate(title="书名", originalTitle="Test Book", author="作者", isbn="123", category="心理", score=80,
                              reason="来源与行动性充分", queries=["官方书目", "原始研究"])
        self.assertTrue(duplicate(candidate, [{"title": "别名", "originalTitle": "TEST  BOOK", "author": "别人", "date": "2020-01-01"}], "2026-11-12"))
        self.assertTrue(duplicate(candidate, [{"title": "另一本", "author": "作者", "date": "2026-11-01"}], "2026-11-12"))
        self.assertFalse(duplicate(candidate, [{"title": "另一本", "author": "作者", "date": "2020-01-01"}], "2026-11-12"))

    def test_missing_failed_or_duplicate_reviews_block_publication(self):
        good = {"id": "C01", "passed": True, "evidence": "sources.json source S1 and S2 verified"}
        bad = {**good, "passed": False}
        for items in [[], [bad], [good, good]]:
            with self.assertRaises(ValueError):
                require_review(Review(checks=items), ["C01"])
        self.assertEqual(require_review(Review(checks=[good]), ["C01"])[0]["status"], "pass")

    def test_private_addresses_and_embedded_credentials_rejected(self):
        for url in ["file:///secret", "http://example.com/a", "https://user:pass@example.com/image"]:
            with self.assertRaises(ValueError):
                public_url(url)
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(ValueError):
                public_url("https://example.com/image")

    def test_real_chinese_pdf_renders_every_page(self):
        d = fixture()
        self.assertGreater(chinese_count(d), 4000)
        with tempfile.TemporaryDirectory() as directory:
            pdf, images, pages = render(d, Path(directory))
            self.assertEqual(len(images), 14)
            self.assertTrue(all(p.is_file() and p.stat().st_size > 1000 for p in images))
            self.assertTrue(all(len(p) > 30 for p in pages))
            self.assertIn(d.title, pages[0])

    def test_layout_overflow_fails_instead_of_silently_dropping_text(self):
        d = fixture()
        d.insights[0].mechanism *= 10
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "PDF_PAGE_OVERFLOW"):
                render(d, Path(directory))


if __name__ == "__main__":
    unittest.main()
