"""Exercise compact source visibility with isolated API fixtures after npm run build.
Run: uv run --with playwright python tests/browser/chat-source-visibility.py
"""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/chat-source-visibility'))
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=width < 768)
            sessions = [dict(id=name, title=name, platform=platform, scope=scope,
                             updatedAt='2026-11-03T00:00:00Z', isActive=False)
                        for name, platform, scope in [('Discord fixture', 'discord', 'interactive'),
                                                     ('Web fixture', 'web', 'interactive'),
                                                     ('Web schedule', 'web', 'scheduler'),
                                                     ('Discord schedule', 'discord', 'scheduler'),
                                                     ('Telegram fixture', 'telegram', 'interactive')]]
            errors = []
            def route(r):
                path = urlparse(r.request.url).path
                if path.endswith('/stream'):
                    r.fulfill(content_type='text/event-stream', body='event: sessions\ndata: '+json.dumps({'sessions': sessions})+'\n\n'); return
                if path == '/api/config': data = {'allowedBackends': []}
                elif path == '/api/agents': data = {'agents': []}
                elif path == '/api/teams': data = {'teams': []}
                elif path == '/api/projects': data = {'projects': [{'id': 'p', 'name': 'Project fixture'}]}
                elif path == '/api/sessions':
                    query = parse_qs(urlparse(r.request.url).query)
                    items = sessions if not query.get('offset') or query['offset'] == ['0'] else [dict(sessions[1], id='older', title='Older web')]
                    if query.get('q'): items = [s for s in items if query['q'][0] in s['title']]
                    data = {'sessions': items, 'meta': {'hasMore': not query.get('offset') or query['offset'] == ['0'], 'nextOffset': 100}}
                elif path.endswith('/turn-history'): data = {'history': []}
                elif path.startswith('/api/sessions/'):
                    data = dict(sessions[1], messages=[], hasMore=False)
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / (path.removeprefix('/app/').lstrip('/') if path.startswith('/app/') else 'index.html')
                    r.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("""
                window.__sessionStreams = [];
                window.EventSource = class extends EventTarget {
                    constructor(url) { super(); this.url = url; window.__sessionStreams.push(this); }
                    close() {}
                };
            """)
            page.goto('http://fixture.test/', wait_until='domcontentloaded')
            def sidebar():
                if width <= 768 and 'open' not in page.locator('.sidebar').get_attribute('class').split():
                    page.get_by_role('button', name='サイドバーを開く', exact=True).click()
            sidebar()
            rows = page.locator('.session-row')
            expect(rows).to_have_count(3)
            settings = page.locator('.session-source-settings')
            summary = settings.locator('summary')
            summary.focus()
            page.keyboard.press('Enter')
            assert settings.get_attribute('open') == ''
            page.get_by_role('checkbox', name='Chat', exact=True).focus()
            page.keyboard.press('Space')
            expect(rows).to_have_count(1)
            page.keyboard.press('Space')
            expect(rows).to_have_count(3)
            page.keyboard.press('Escape')
            def menu():
                if not settings.get_attribute('open') == '': summary.click()
            heading_height = page.locator('.sidebar-conversation-heading').bounding_box()['height']
            page.screenshot(path=str(out / f'closed-{width}.png'))
            menu()
            # Click/tap the label text rather than the input: a null-relatedTarget
            # blur on the label used to close details before checkbox activation.
            label = settings.locator('label').filter(has_text='自動実行')
            if width < 768: label.tap()
            else: label.click()
            expect(rows).to_have_count(5)
            expect(page.get_by_role('checkbox', name='自動実行', exact=True)).to_be_checked()
            page.reload(wait_until='domcontentloaded'); sidebar(); menu()
            expect(rows).to_have_count(5)
            if width < 768: label.tap()
            else: label.click()
            expect(rows).to_have_count(3)
            page.get_by_role('checkbox', name='Chat', exact=True).uncheck()
            expect(rows).to_have_count(1)
            assert page.locator('.sidebar-conversation-heading').bounding_box()['height'] == heading_height
            page.screenshot(path=str(out / f'open-{width}.png'))
            page.get_by_role('checkbox', name='Web', exact=True).focus()
            page.keyboard.press('Escape')
            expect(summary).to_be_focused()
            assert settings.get_attribute('open') is None
            # Opening a pane survives hiding its source.
            page.locator('.session-main').click()
            sidebar(); menu()
            page.get_by_role('checkbox', name='Web', exact=True).uncheck()
            expect(rows).to_have_count(0)
            expect(page.locator('.session-source-empty')).to_contain_text('すべて非表示')
            expect(page.locator('.pane-title').first).to_contain_text('Web fixture')
            page.reload(wait_until='domcontentloaded'); sidebar()
            expect(rows).to_have_count(0)
            menu(); page.get_by_role('checkbox', name='Web', exact=True).check()
            expect(rows).to_have_count(1)
            summary.click()
            page.get_by_role('button', name='さらに読み込む', exact=True).click()
            expect(rows).to_have_count(2)
            # Incoming snapshots also keep Chat and Schedule hidden.
            page.evaluate("sessions => window.__sessionStreams.at(-1).dispatchEvent(new MessageEvent('sessions', {data: JSON.stringify({sessions})}))", sessions)
            expect(rows).to_have_count(2)
            page.get_by_placeholder('会話を検索').fill('schedule')
            expect(rows).to_have_count(0)
            page.get_by_placeholder('会話を検索').fill('')
            expect(rows).to_have_count(1)
            page.get_by_role('button', name='Project fixture', exact=True).click()
            expect(rows).to_have_count(1)
            menu(); page.get_by_role('checkbox', name='自動実行', exact=True).check()
            expect(rows).to_have_count(3)
            page.get_by_role('checkbox', name='Chat', exact=True).check()
            expect(rows).to_have_count(5)
            box = settings.locator('fieldset').bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= width
            page.screenshot(path=str(out / f'restored-{width}.png'))
            assert not errors, errors
            print(f'PASS width={width}: types, all hidden, restore, persistence, pane, pagination, SSE, search, project, Escape, menu bounds')
            context.close()
    finally:
        browser.close()
