"""Catalog preparation and actual production verification, never a model verdict."""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

from .client import InfrastructureError, now, save, window
from .models import Draft
from .pdf import sha
from .pipeline import ROOT, WORK, load

SITE = "https://dailybooks-three.vercel.app"


def preflight(publish=False):
    names = ["DEEPSEEK_API_KEY"] + (["BLOB_READ_WRITE_TOKEN", "VERCEL_DEPLOY_HOOK", "GITHUB_TOKEN"] if publish else [])
    missing = [key for key in names if not os.getenv(key)]
    if missing:
        raise InfrastructureError("MISSING_CONFIGURATION:" + ",".join(missing))


def catalog():
    state, acceptance, receipt = [load(WORK / p) for p in ["state.json", "acceptance.json", "upload.json"]]
    window(state["date"], publishing=True)
    if state.get("fixture") or state["stage"] != "validated" or not acceptance["prepublishPassed"]:
        raise InfrastructureError("NOT_ACCEPTED")
    if receipt.get("date") != state["date"]:
        raise InfrastructureError("UPLOAD_DATE_MISMATCH")
    for kind, file in [("pdf", "book.pdf"), ("cover", "book.cover.jpg")]:
        if state[kind + "Sha256"] != sha(WORK / file) or receipt[kind]["sha256"] != sha(WORK / file):
            raise InfrastructureError("FILE_CHANGED_AFTER_ACCEPTANCE")
    if sha(WORK / "draft.json") != state["draftSha256"] or sha(WORK / "sources.json") != state["sourcesSha256"]:
        raise InfrastructureError("SOURCE_CHANGED_AFTER_ACCEPTANCE")
    d = Draft.model_validate(load(WORK / "draft.json"))
    data = load(ROOT / "data.json")
    if any(b["date"] == state["date"] for b in data["books"]):
        raise InfrastructureError("DATE_ALREADY_PUBLISHED")
    book = {"id": max(int(b["id"]) for b in data["books"]) + 1, "date": state["date"],
            **{key: getattr(d, key) for key in ["title", "originalTitle", "author", "description", "tags", "category"]},
            "highlights": [i.judgment for i in d.insights[:3]], "action": d.plan[0], "duration": "20分钟", "rating": "",
            "audio": "", "audioUrl": "", "pdf": receipt["pdf"]["url"], "pdfUrl": receipt["pdf"]["url"], "cover": receipt["cover"]["url"]}
    previous_catalog_sha = sha(ROOT / "data.json")
    previous_knowledge_sha = sha(ROOT / "knowledge/books.json")
    data["books"].insert(0, book)
    save(WORK / "book.json", book)
    save(ROOT / "data.json", data)
    subprocess.run([sys.executable, str(ROOT / "tools/build_book_knowledge.py"), "--book-id", str(book["id"]), "--pdf", str(WORK / "book.pdf")], check=True)
    knowledge = load(ROOT / "knowledge/books.json")
    if not knowledge[str(book["id"])]["chunks"] or len(knowledge) < len(data["books"]):
        raise InfrastructureError("KNOWLEDGE_NOT_COMPLETE")
    save(WORK / "release.json", {"book": book, "catalogSha256": sha(ROOT / "data.json"),
                                 "previousCatalogSha256": previous_catalog_sha, "previousKnowledgeSha256": previous_knowledge_sha,
                                 "knowledgeSha256": sha(ROOT / "knowledge/books.json")})
    acceptance["checks"] += [{"id": key, "status": "pass", "evidence": evidence} for key, evidence in {
        "D01": "data.json parsed and generated with existing contract", "D02": "unique date/id, inserted at index0",
        "D03": "upload.json: remote PDF hash/content-type matched", "D04": "cover-review.json + upload.json hash and dimensions",
        "D05": "tools/build_book_knowledge.py incremental build with accepted local PDF; history preserved",
    }.items()]
    save(WORK / "acceptance.json", acceptance)


def deploy_hook(rollback=False):
    state = load(WORK / "state.json")
    window(state["date"], publishing=not rollback)
    response = requests.post(os.environ["VERCEL_DEPLOY_HOOK"], timeout=40)
    if response.status_code not in (200, 201):
        raise InfrastructureError("DEPLOY_HOOK_FAILED")
    # Store the non-secret job id only; never store the deploy hook URL.
    save(WORK / "deployment.json", {"jobId": response.json().get("job", {}).get("id"), "requestedAt": now().isoformat()})


def verify():
    release = load(WORK / "release.json")
    book = release["book"]
    ready = False
    for attempt in range(48):
        try:
            catalog_response = requests.get(SITE + f"/data.json?cloud={int(time.time())}", timeout=30)
            if catalog_response.ok and __import__("hashlib").sha256(catalog_response.content).hexdigest() == release["catalogSha256"]:
                ready = True
                break
        except requests.RequestException:
            pass
        time.sleep(15)
    if not ready:
        raise InfrastructureError("PRODUCTION_CATALOG_NOT_READY")
    knowledge = requests.get(SITE + f"/knowledge/books.json?cloud={int(time.time())}", timeout=40)
    if not knowledge.ok or __import__("hashlib").sha256(knowledge.content).hexdigest() != release["knowledgeSha256"]:
        raise InfrastructureError("PRODUCTION_KNOWLEDGE_MISMATCH")
    for path in ["/", "/library.html"]:
        if requests.get(SITE + path, timeout=30).status_code != 200:
            raise InfrastructureError("PRODUCTION_PAGE_FAILED")
    receipt = load(WORK / "upload.json")
    import hashlib
    for kind in ["pdf", "cover"]:
        response = requests.get(receipt[kind]["url"], timeout=40)
        if not response.ok or hashlib.sha256(response.content).hexdigest() != receipt[kind]["sha256"]:
            raise InfrastructureError("PRODUCTION_ASSET_MISMATCH")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(SITE + "/library.html", wait_until="networkidle")
        page.locator("#archiveCount").filter(has_text=f"{len(load(ROOT / 'data.json')['books'])}").wait_for(timeout=30000)
        page.get_by_text(book["title"], exact=True).first.wait_for(timeout=10000)
        page.screenshot(path=str(WORK / "production.png"), full_page=True)
        if errors:
            raise InfrastructureError("PRODUCTION_BROWSER_ERROR")
        browser.close()
    # One real request proves the newly deployed API can retrieve this book.
    answer = requests.post(SITE + "/api/companion", json={"bookId": book["id"], "question": "请用一句话说明本书的一个核心洞见。", "history": []}, timeout=90)
    if answer.status_code != 200 or len(answer.text) < 30 or '"error"' in answer.text:
        raise InfrastructureError("PRODUCTION_RAG_FAILED")
    acceptance = load(WORK / "acceptance.json")
    acceptance["checks"] += [{"id": key, "status": "pass", "evidence": evidence} for key, evidence in {
        "D06": "production data.json and knowledge bytes match release.json hashes",
        "D07": "production.png, homepage/library200, assets hashes, companion bookId request200",
        "D08": "state.json, deployment.json, release.json, usage.json and GitHub run URL",
    }.items()]
    acceptance["passed"] = True
    acceptance["publicationChecks"] = "D01-D08 passed"
    save(WORK / "acceptance.json", acceptance)
    state = load(WORK / "state.json")
    state.update(stage="succeeded", finishedAt=now().isoformat(), runUrl=os.getenv("GITHUB_SERVER_URL", "") + "/" + os.getenv("GITHUB_REPOSITORY", "") + "/actions/runs/" + os.getenv("GITHUB_RUN_ID", ""))
    save(WORK / "state.json", state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["preflight", "catalog", "deploy", "verify", "window"])
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "preflight":
            preflight(args.publish)
        elif args.command == "window":
            window(load(WORK / "state.json")["date"], publishing=not args.rollback)
        elif args.command == "deploy":
            deploy_hook(args.rollback)
        else:
            {"catalog": catalog, "deploy": deploy_hook, "verify": verify}[args.command]()
    except Exception as exc:
        code = str(exc) if isinstance(exc, InfrastructureError) else type(exc).__name__
        save(WORK / "release-failure.json", {"stage": args.command, "status": "failed", "errorCode": code, "at": now().isoformat()})
        print("Release stopped; see release-failure.json and reports.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
