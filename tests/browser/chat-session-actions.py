"""Exercise compact mobile session operations using isolated API fixtures. Build first."""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(os.environ.get('WEB_BUILD', Path(__file__).resolve().parents[2] / 'web/app'))
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/chat-session-actions'))
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])
    try:
        for width in [1280, 768, 430, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=width <= 768)
            sessions = [dict(id=f's{i}', title=f'会話{i} 長い会話名の表示と操作を確認', platform='web' if i % 2 == 0 else 'discord',
                             updatedAt='2026-11-03T00:00:00Z', isActive=i == 0, lifecycle='closed' if i == 2 else 'open') for i in range(20)]
            errors, writes = [], []
            def route(r):
                path = urlparse(r.request.url).path
                if path.endswith('/stream'): r.fulfill(content_type='text/event-stream', body=': fixture\n\n'); return
                if path == '/api/config': data = {'allowedBackends': []}
                elif path == '/api/agents': data = {'agents': []}
                elif path == '/api/teams': data = {'teams': []}
                elif path == '/api/projects': data = {'projects': []}
                elif path == '/api/sessions': data = {'sessions': sessions, 'meta': {'hasMore': False}}
                elif path.endswith('/turn-history'): data = {'history': []}
                elif path.startswith('/api/sessions/') and r.request.method != 'GET':
                    writes.append((path, r.request.method))
                    if path.endswith('/stop'): sessions[0]['isActive'] = False
                    if path.endswith('/close'): next(s for s in sessions if s['id'] == path.split('/')[3])['lifecycle'] = 'closed'
                    data = {'ok': True}
                elif path.startswith('/api/sessions/'):
                    data = dict(next((s for s in sessions if s['id'] == path.split('/')[3]), sessions[0]), messages=[], hasMore=False)
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / (path.removeprefix('/app/').lstrip('/') if path.startswith('/app/') else 'index.html')
                    r.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page(); page.set_default_timeout(8000)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto('http://fixture.test/', wait_until='domcontentloaded')
            def sidebar():
                if width <= 768 and 'open' not in page.locator('.sidebar').get_attribute('class').split():
                    page.get_by_role('button', name='サイドバーを開く', exact=True).click()
            sidebar(); rows = page.locator('.session-row'); expect(rows).to_have_count(20)
            row = rows.first
            height = row.bounding_box()['height']
            page.screenshot(path=str(out / f'list-{width}.png'), animations='disabled')
            print(f'MEASURE width={width}: row={height}px', flush=True)
            if os.environ.get('MEASURE_ONLY'):
                context.close(); continue
            if width <= 768:
                assert height <= 60, height
                trigger = row.locator('.session-actions-trigger')
                expect(row.locator('.session-actions')).not_to_be_visible()
                trigger.tap(); expect(trigger).to_have_attribute('aria-expanded', 'true')
                expect(row.get_by_role('button', name='停止', exact=True)).to_be_visible()
                expect(row.get_by_role('button', name='Projectへ移動', exact=True)).to_be_disabled()
                page.screenshot(path=str(out / f'menu-{width}.png'), animations='disabled')
                row.get_by_role('button', name='停止', exact=True).tap()
                expect(trigger).to_have_attribute('aria-expanded', 'false')
                assert ('/api/sessions/s0/stop', 'POST') in writes
                trigger.tap(); row.get_by_role('button', name='Projectへ移動', exact=True).tap()
                expect(page.get_by_role('dialog')).to_be_visible()
                page.get_by_role('dialog').get_by_role('button', name='キャンセル', exact=True).click()
                trigger.tap(); row.get_by_role('button', name='削除', exact=True).tap()
                expect(page.get_by_role('dialog')).to_be_visible()
                page.get_by_role('dialog').get_by_role('button', name='キャンセル', exact=True).click()
                assert not any(method == 'DELETE' for _, method in writes)
                trigger.tap(); row.get_by_role('button', name='完了にする', exact=True).tap()
                expect(row).to_contain_text('完了')
                trigger.tap(); page.keyboard.press('Escape'); expect(trigger).to_be_focused()
                expect(trigger).to_have_attribute('aria-expanded', 'false')
                trigger.tap(); page.get_by_placeholder('会話を検索').click()
                expect(trigger).to_have_attribute('aria-expanded', 'false')
                # Opening another menu closes the first, without changing list geometry.
                trigger.tap(); rows.nth(5).locator('.session-actions-trigger').tap()
                expect(trigger).to_have_attribute('aria-expanded', 'false')
                expect(row).to_have_css('min-height', '57px')
                # Last row opens upwards and keeps every operation reachable above footer.
                last = rows.last; last.scroll_into_view_if_needed()
                last.locator('.session-actions-trigger').tap()
                box = last.locator('.session-actions').bounding_box()
                scroll = page.locator('.sidebar-scroll').bounding_box()
                assert box['y'] >= scroll['y'] - 1 and box['y'] + box['height'] <= scroll['y'] + scroll['height'] + 1, (box, scroll)
                for b in last.locator('.session-actions button').all():
                    bb = b.bounding_box(); assert bb['width'] >= 44 and bb['height'] >= 44
                page.screenshot(path=str(out / f'last-menu-{width}.png'), animations='disabled')
                last.get_by_role('button', name=sessions[-1]['title']+'を別ペインで開く', exact=True).tap()
                expect(page.locator('.pane')).to_have_count(2)
                expect(page.locator('.sidebar')).not_to_be_in_viewport()
                sidebar(); rows.first.locator('.session-main').tap()
                expect(page).to_have_url('http://fixture.test/chat/s0')
            else:
                expect(row.locator('.session-actions-trigger')).not_to_be_visible()
                row.hover(); row.get_by_role('button', name='削除', exact=True).click()
                expect(page.get_by_role('dialog')).to_be_visible()
                page.get_by_role('dialog').get_by_role('button', name='キャンセル', exact=True).click()
            assert not errors, errors
            print(f'PASS width={width}: operations, cancel, keyboard, outside close, boundary, pane', flush=True)
            context.close()
    finally:
        browser.close()
