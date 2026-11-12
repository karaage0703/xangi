"""Build first; uv run --with playwright python tests/browser/chat-reopen.py.
Isolated API fixtures: no live conversations or AI calls.
"""
import asyncio
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/chat-reopen'))


async def exercise(browser, width):
    context = await browser.new_context(viewport={'width': width, 'height': 900})
    page = await context.new_page()
    page.set_default_timeout(5000)
    await page.add_init_script('window.EventSource=class{addEventListener(){} close(){}}')
    errors, posts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    sessions = {
        sid: dict(id=sid, title=sid, platform='web', lifecycle='open', isActive=False, contextKey=f'webchat:{sid}',
                  canReopen=True, scope='chat', updatedAt='2026-11-12T08:00:00Z')
        for sid in ['A', 'B', 'secret_test', 'scheduled', 'linked']
    }
    sessions['secret_test']['canReopen'] = False
    sessions['scheduled'].update(scope='scheduler', canReopen=False)
    sessions['linked'].update(platform='discord', linkedChannel=True)
    fail_reopen = 0
    hide_list = False
    detail_reads = 0
    hold_reopen = False
    release = asyncio.Event()

    async def route(r):
        nonlocal detail_reads
        path = urlparse(r.request.url).path
        if r.request.method not in ('GET', 'HEAD'):
            posts.append((path, r.request.post_data_json))
        if path.endswith(('/close', '/reopen')):
            sid = path.split('/')[-2]
            if path.endswith('/reopen'):
                if hold_reopen:
                    await release.wait()
                if fail_reopen:
                    await r.fulfill(status=fail_reopen, json={'error': '別の会話が作業中です' if fail_reopen == 409 else 'session not found'})
                    return
            sessions[sid]['lifecycle'] = 'closed' if path.endswith('/close') else 'open'
            await r.fulfill(json={'ok': True})
            return
        if path == '/api/sessions':
            data = {'sessions': [] if hide_list else list(sessions.values()), 'meta': {'hasMore': False}}
        elif path.endswith('/turn-history'):
            data = {'history': []}
        elif path.startswith('/api/sessions/') and path.count('/') == 3:
            detail_reads += 1
            data = dict(sessions[path.split('/')[-1]], messages=[dict(id='m1', role='user', content='保存済みの履歴')])
        elif path.startswith('/api/'):
            data = {'agents': [], 'teams': [], 'projects': [], 'commands': [], 'skills': [], 'models': [], 'backends': []}
        else:
            f = ROOT / 'web/app' / path.removeprefix('/app/').lstrip('/')
            if not f.is_file():
                f = ROOT / 'web/app/index.html'
            await r.fulfill(body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
            return
        await r.fulfill(json=data)

    await page.route('**/*', route)
    await page.goto('http://chat.test/chat/A')
    await expect(page.get_by_text('保存済みの履歴', exact=True)).to_be_visible()
    await page.screenshot(path=str(OUT / f'{width}-before.png'))
    await page.get_by_role('button', name='完了して閉じる', exact=True).click()
    undo = page.get_by_role('button', name='元に戻す', exact=True)
    await expect(undo).to_be_visible()
    await expect(undo).to_be_focused()
    await page.screenshot(path=str(OUT / f'{width}-undo.png'))
    hide_list = True  # Undo must work even when the target is absent from the list.
    await undo.press('Enter')
    await expect(page.locator('.pane textarea')).to_be_enabled()
    await expect(page.get_by_text('保存済みの履歴', exact=True)).to_be_visible()
    assert sessions['A']['lifecycle'] == 'open'
    assert posts[:2] == [('/api/sessions/A/close', {'force': False}), ('/api/sessions/A/reopen', None)], posts

    # Reopen later, with no list entry. Two panes must both reload their detail.
    sessions['A']['lifecycle'] = 'closed'
    await page.reload()
    if width > 768:
        hide_list = False
        await page.reload()
        row = page.locator('.session-row').filter(has=page.get_by_text('A', exact=True)).first
        await row.hover()
        await row.get_by_role('button', name='Aを別ペインで開く', exact=True).click()
        await expect(page.locator('.pane')).to_have_count(2)
    reopen = page.get_by_role('button', name='作業中に戻す', exact=True).last
    await expect(reopen).to_be_visible()
    await page.screenshot(path=str(OUT / f'{width}-closed.png'))
    fail_reopen = 409
    await reopen.click()
    await expect(page.get_by_role('alert').filter(has_text='別の会話が作業中です')).to_be_visible()
    assert sessions['A']['lifecycle'] == 'closed'
    fail_reopen = 404
    await reopen.click()
    await expect(page.get_by_role('alert').filter(has_text='session not found')).to_be_visible()
    fail_reopen = 0
    hold_reopen = True
    before = len(posts)
    await reopen.click()
    await expect(reopen).to_be_disabled()
    await page.wait_for_timeout(100)
    assert len(posts) == before + 1
    release.set()
    await expect(reopen).to_have_count(0)
    assert all(s['lifecycle'] == 'open' for sid, s in sessions.items() if sid == 'A')
    for textarea in await page.locator('.pane textarea').all():
        await expect(textarea).to_be_enabled()
    await page.screenshot(path=str(OUT / f'{width}-reopened.png'))

    # Complete from the sidebar, retaining the open pane, then undo.
    hide_list = False
    await page.goto('http://chat.test/chat/B')
    await expect(page.get_by_text('保存済みの履歴', exact=True)).to_be_visible()
    if width <= 768:
        await page.get_by_role('button', name='サイドバーを開く', exact=True).click()
    row = page.locator('.session-row').filter(has=page.get_by_text('B', exact=True)).first
    if width <= 768:
        await row.locator('.session-actions-trigger').click()
    else:
        await row.hover()
    await row.get_by_role('button', name='完了にする', exact=True).click()
    await expect(page.get_by_role('button', name='元に戻す', exact=True)).to_be_visible()
    await expect(page.locator('.pane textarea')).to_be_disabled()
    await page.get_by_role('button', name='元に戻す', exact=True).click()
    await expect(page.locator('.pane textarea')).to_be_enabled()
    assert sessions['B']['lifecycle'] == 'open'

    # Running conversations still require explicit interruption confirmation.
    await expect(page.get_by_role('button', name='元に戻す', exact=True)).to_have_count(0)
    await expect(page.get_by_role('button', name='完了して閉じる', exact=True)).to_be_enabled()
    sessions['B']['isActive'] = True
    hide_list = True
    await page.reload()
    await expect(page.get_by_text('保存済みの履歴', exact=True)).to_be_visible()
    await page.get_by_role('button', name='完了して閉じる', exact=True).click()
    await expect(page.get_by_role('dialog')).to_be_visible()
    previous = len(posts)
    await page.get_by_role('button', name='中断して完了', exact=True).click()
    await expect(page.get_by_role('button', name='元に戻す', exact=True)).to_be_visible()
    assert posts[previous] == ('/api/sessions/B/close', {'force': True})
    sessions['B']['isActive'] = False
    await page.get_by_role('button', name='元に戻す', exact=True).click()
    await expect(page.locator('.pane textarea')).to_be_enabled()
    assert sessions['B']['lifecycle'] == 'open'

    # Linked Project conversations also expose reopen; exclusions never do.
    for sid in ['linked', 'scheduled', 'secret_test']:
        sessions[sid]['lifecycle'] = 'closed'
        await page.goto(f'http://chat.test/chat/{sid}')
        await expect(page.get_by_text('保存済みの履歴', exact=True)).to_be_visible()
        button = page.get_by_role('button', name='作業中に戻す', exact=True)
        if sid == 'linked':
            await expect(button).to_be_visible()
            await button.click()
            await expect(button).to_have_count(0)
        else:
            await expect(button).to_have_count(0)
    sessions['secret_test']['lifecycle'] = 'open'
    await page.reload()
    await page.get_by_role('button', name='終了して破棄', exact=True).click()
    await expect(page.get_by_role('button', name='元に戻す', exact=True)).to_have_count(0)
    assert not any('/resume' in p or p == '/api/chat' for p, _ in posts), posts
    assert not errors, errors
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    print(f'PASS {width}px: header/sidebar/forced Undo, list-independent reopen, 409/404, pending guard, linked Project, exclusions; detail reads={detail_reads}', flush=True)
    await context.close()


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        try:
            for width in [1280, 375, 320]:
                await exercise(browser, width)
        finally:
            await browser.close()


asyncio.run(main())
