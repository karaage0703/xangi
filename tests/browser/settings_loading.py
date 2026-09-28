"""Verify progressive settings loading against built assets and isolated APIs."""
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / "web/app"
runtime = {
    "backend": {"enabled": True, "value": {"backend": "codex"}, "options": ["codex"], "applyMode": "next-turn"},
    "replySuggestions": {"enabled": True, "value": "inherit", "effective": {"web": True, "discord": True, "slack": True}, "applyMode": "immediate"},
    "respondToBots": {"enabled": True, "value": False, "applyMode": "immediate"},
}
connections = {"groups": [], "backends": [{"id": "codex", "label": "Codex", "installed": True, "version": "test-version", "state": "logged-in", "apiKeyConfigured": False, "updateSupported": True}]}
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/snap/bin/chromium", headless=True, args=["--no-sandbox"])
    try:
        for width in [1280, 390]:
            context = browser.new_context(viewport={"width": width, "height": 1000})
            pending, saved, errors = [], [], []
            def route(r):
                path = urlparse(r.request.url).path
                if path == "/api/connection-settings":
                    pending.append(r)
                    return
                if path == "/api/runtime-settings":
                    if r.request.method == "POST":
                        saved.append(r.request.post_data_json)
                        data = {"message": "保存しました", "settings": runtime}
                    else:
                        data = runtime
                elif path == "/api/startup-settings":
                    data = {"groups": [{"id": "test", "label": "起動設定テスト", "settings": []}]}
                elif path == "/api/runtime-settings/channels":
                    data = {"status": "disabled", "channels": []}
                elif path == "/api/models":
                    data = {"status": "available", "models": [{"id": "test-model"}], "supportedEfforts": []}
                elif path == "/api/workspaces": data = {"workspaces": []}
                elif path == "/api/agents": data = {"agents": []}
                elif path == "/api/sessions/stream":
                    r.fulfill(content_type="text/event-stream", body=": ready\n\n")
                    return
                elif path.startswith("/api/"): data = {}
                else:
                    file = root / ("index.html" if path == "/settings" else path.removeprefix("/app/"))
                    r.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(file.name)[0] or "application/octet-stream")
                    return
                r.fulfill(json=data)
            context.route("**/*", route)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto("http://settings.test/settings", wait_until="domcontentloaded")
            expect(page.get_by_role("heading", name="AIの既定", exact=True)).to_be_visible()
            expect(page.get_by_text("接続と認証状態を確認しています…", exact=True)).to_be_visible()
            expect(page.get_by_role("heading", name="起動設定テストの起動設定", exact=True)).to_be_attached()
            expect(page.locator("#respond-bots-setting")).to_be_enabled()
            page.locator("#respond-bots-setting").select_option("on")
            expect(page.get_by_text("保存しました", exact=True)).to_be_visible()
            assert saved and pending
            pending.pop(0).fulfill(status=500, json={"error": "test failure"})
            expect(page.get_by_role("alert")).to_contain_text("接続と認証状態を取得できませんでした")
            expect(page.locator("#respond-bots-setting")).to_be_enabled()
            page.get_by_role("button", name="再読み込み", exact=True).click()
            expect(page.get_by_text("接続と認証状態を確認しています…", exact=True)).to_be_visible()
            # Allow the retried request to reach the mock, without a wall-clock sleep.
            page.wait_for_function("document.querySelector('[role=alert]') === null")
            assert pending
            pending.pop(0).fulfill(json=connections)
            expect(page.get_by_text("test-version", exact=True)).to_be_visible()
            expect(page.get_by_text("接続と認証状態を確認しています…", exact=True)).not_to_be_visible()
            assert not errors, errors
            print(json.dumps({"width": width, "pending_save": True, "failure_isolated": True, "retry_success": True}))
            context.close()
    finally:
        browser.close()
