"""Run after npm run build: uv run --with playwright python tests/browser/monitor-concurrent-close.py.
Uses synthetic API responses in an isolated browser; never contacts a live xangi instance.
Set CHROMIUM_EXECUTABLE to use an existing Chromium installation.
"""

import asyncio
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

ROOT = Path(os.environ.get("MONITOR_ROOT", str(Path(__file__).resolve().parents[2])))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_EXECUTABLE"),
            args=["--no-sandbox"],
        )
        try:
            page = await browser.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.add_init_script(
                """window.streams=[];window.pull=async()=>{const parts=await Promise.all(['open','closed'].map(l=>fetch('/api/sessions?lifecycle='+l).then(r=>r.json())));const d={sessions:parts.flatMap(p=>p.sessions)};window.streams.forEach(s=>s.listeners.sessions?.({data:JSON.stringify(d)}))};window.EventSource=class{constructor(){this.listeners={};window.streams.push(this)}addEventListener(n,f){this.listeners[n]=f;if(n==='sessions')void window.pull()}close(){window.streams=window.streams.filter(s=>s!==this)}};window.notify=()=>{void window.pull()};"""
            )
            now = await page.evaluate("new Date().toISOString()")
            sessions = [
                {
                    "id": x,
                    "title": x,
                    "platform": "web",
                    "scope": "chat",
                    "contextKey": x,
                    "lifecycle": "open",
                    "createdAt": now,
                    "updatedAt": now,
                    "isActive": False,
                    "messageCount": 1,
                }
                for x in ["A", "B", "C"]
            ]
            post_release = asyncio.Event()
            snapshot_release = asyncio.Event()
            snapshot_started = asyncio.Event()
            posts = []
            hold = False

            async def route(r):
                nonlocal hold
                u = urlparse(r.request.url)
                path = u.path
                if path == "/api/sessions":
                    life = parse_qs(u.query).get("lifecycle", ["open"])[0]
                    data = json.dumps(
                        {
                            "sessions": [
                                dict(s) for s in sessions if s["lifecycle"] == life
                            ],
                            "meta": {"hasMore": False},
                        }
                    )
                    if hold:
                        snapshot_started.set()
                        await snapshot_release.wait()
                    await r.fulfill(content_type="application/json", body=data)
                    return
                if path.endswith(("/close", "/reopen")):
                    sid = path.split("/")[-2]
                    posts.append(path)
                    if sid == "A" and path.endswith("/close"):
                        await post_release.wait()
                    if sid == "C":
                        await r.fulfill(
                            status=409, json={"error": "実行中のSessionです"}
                        )
                        return
                    for s in sessions:
                        if s["id"] == sid:
                            s["lifecycle"] = (
                                "closed" if path.endswith("/close") else "open"
                            )
                    await r.fulfill(json={"ok": True})
                    return
                if path.startswith("/api/"):
                    await r.fulfill(json={})
                    return
                f = ROOT / "web/app" / path.removeprefix("/app/").lstrip("/")
                if not f.is_file():
                    f = ROOT / "web/app/index.html"
                await r.fulfill(
                    body=f.read_bytes(),
                    content_type=mimetypes.guess_type(str(f))[0]
                    or "application/octet-stream",
                )

            await page.route("**/*", route)
            await page.goto("http://monitor.test/monitor")
            a = page.get_by_role("button", name="Aを完了にする", exact=True)
            b = page.get_by_role("button", name="Bを完了にする", exact=True)
            await expect(a).to_be_enabled()
            hold = True
            await page.evaluate("window.notify()")
            await asyncio.wait_for(snapshot_started.wait(), timeout=10)
            await a.click()
            await expect(a).to_be_disabled()
            await expect(b).to_be_enabled()
            await b.click()
            await expect(
                page.get_by_role("button", name="Bを作業中へ戻す", exact=True)
            ).to_be_enabled()
            assert len(posts) == 2, posts
            post_release.set()
            await expect(
                page.get_by_role("button", name="Aを作業中へ戻す", exact=True)
            ).to_be_enabled()
            hold = False
            snapshot_release.set()
            await page.wait_for_timeout(300)
            await expect(
                page.get_by_role("button", name="Aを作業中へ戻す", exact=True)
            ).to_be_enabled()
            await expect(
                page.get_by_role("button", name="Bを作業中へ戻す", exact=True)
            ).to_be_enabled()
            await page.get_by_role("button", name="元に戻す", exact=True).click()
            await expect(a).to_be_enabled()
            await page.get_by_role("button", name="Cを完了にする", exact=True).click()
            await expect(page.get_by_role("alert")).to_be_visible()
            await expect(
                page.get_by_role("button", name="Cを完了にする", exact=True)
            ).to_be_enabled()
            await page.reload()
            await expect(a).to_be_enabled()
            await expect(
                page.get_by_role("button", name="Bを作業中へ戻す", exact=True)
            ).to_be_enabled()
            assert not errors, errors
            print(
                "PASS: concurrent close, per-card lock, stale snapshot, undo, failed close, reload"
            )
        finally:
            await browser.close()


asyncio.run(main())
