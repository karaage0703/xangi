"""Build first; run with uv run --with playwright python tests/browser/chat-sidebar-resize.py.
Uses synthetic API fixtures and never connects to a running xangi instance.
"""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/chat-sidebar-resize'))
out.mkdir(parents=True, exist_ok=True)
key = 'xangi-chat-sidebar-width'
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    errors = []
    def route(r):
        path = urlparse(r.request.url).path
        if path.endswith('/stream'):
            r.fulfill(content_type='text/event-stream', body='event: sessions\ndata: {"sessions":[]}\n\n')
            return
        if path == '/api/config': data = {'uploadAccept': None, 'uploadMaxBytes': 64000000, 'allowedBackends': ['codex']}
        elif path == '/api/agents': data = {'agents': []}
        elif path == '/api/teams': data = {'teams': []}
        elif path == '/api/projects': data = {'projects': []}
        elif path == '/api/sessions': data = {'sessions': []}
        elif path.startswith('/api/'): data = {}
        else:
            file = root / ('index.html' if path == '/' else path.removeprefix('/app/').lstrip('/'))
            r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
            return
        r.fulfill(json=data)
    context.route('**/*', route)
    page = context.new_page()
    page.set_default_timeout(8000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    handle = page.get_by_role('separator', name='サイドバーの幅')
    def width(value):
        expect(handle).to_have_attribute('aria-valuenow', str(value))
        page.wait_for_function('(w) => Math.abs(document.querySelector(".sidebar").getBoundingClientRect().width - w) < 1', arg=value)
    def saved(): return page.evaluate('(key) => localStorage.getItem(key)', key)
    def start_drag(delta):
        box = handle.bounding_box()
        x, y = box['x'] + box['width']/2, box['y'] + 100
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + delta, y, steps=8)
    page.goto('http://sidebar.test/')
    width(300)
    page.screenshot(path=str(out/'default-desktop.png'))
    start_drag(120); page.mouse.up(); width(420); assert saved() == '420'
    page.reload(); width(420)
    handle.focus(); page.keyboard.press('ArrowRight'); width(430)
    page.keyboard.press('Shift+ArrowLeft'); width(390)
    page.keyboard.press('Home'); width(240)
    page.keyboard.press('End'); width(560)
    page.screenshot(path=str(out/'wide-desktop.png'))
    page.set_viewport_size({'width': 800, 'height': 900}); width(440); assert saved() == '560'
    page.set_viewport_size({'width': 1440, 'height': 900}); width(560)
    start_drag(-80); page.keyboard.press('Escape'); page.mouse.up(); width(560); assert saved() == '560'
    start_drag(-80)
    page.evaluate('document.querySelector(".chat-sidebar-resizer").dispatchEvent(new PointerEvent("pointercancel", {bubbles:true}))')
    page.mouse.up(); width(560); assert saved() == '560'
    start_drag(-80)
    page.evaluate('''() => { const e=document.querySelector('.chat-sidebar-resizer'); for(let id=1;id<10;id++) if(e.hasPointerCapture(id)) e.releasePointerCapture(id); }''')
    page.mouse.up(); width(560); assert saved() == '560'
    start_drag(-500); page.mouse.up(); width(240)
    start_drag(900); page.mouse.up(); width(560)
    handle.dblclick(); width(300); assert saved() == '300'
    handle.focus(); page.keyboard.press('Shift+ArrowRight'); width(340)
    page.get_by_role('button', name='サイドバーを閉じる', exact=True).click()
    expect(handle).to_have_count(0)
    page.get_by_role('button', name='サイドバーを開く', exact=True).click(); width(340)
    for mobile_width in [768, 375, 320]:
        page.set_viewport_size({'width': mobile_width, 'height': 900})
        expect(handle).to_be_hidden()
        page.get_by_role('button', name='サイドバーを開く', exact=True).click()
        page.wait_for_function('document.querySelector(".sidebar").getBoundingClientRect().x >= -1')
        page.screenshot(path=str(out/f'mobile-open-{mobile_width}.png'))
        page.get_by_role('button', name='サイドバーを閉じる', exact=True).click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert saved() == '340'
    page.set_viewport_size({'width': 1440, 'height': 900}); width(340)
    # Moving to mobile during a drag cancels without overwriting the preference.
    start_drag(80)
    page.set_viewport_size({'width': 375, 'height': 900}); page.mouse.up()
    assert saved() == '340'
    page.set_viewport_size({'width': 1440, 'height': 900}); width(340)
    for bad in ['garbage', 'Infinity', '-4', 'null']:
        page.evaluate('([key, value]) => localStorage.setItem(key, value)', [key, bad])
        page.reload(); width(300)
    # Denied storage must not disable resizing or crash Chat.
    page.add_init_script('''const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (key === 'xangi-chat-sidebar-width') throw new Error('storage denied');
            return originalSetItem.call(this, key, value);
        };''')
    page.reload(); width(300); handle.focus(); page.keyboard.press('ArrowRight'); width(310)
    assert not errors, errors
    print(json.dumps({'result': 'PASS', 'checks': ['drag and reload', 'keyboard and limits', 'viewport preference', 'escape/cancel/lost capture', 'reset', 'collapse/reopen', 'mobile 768/375/320', 'resize during drag', 'invalid and denied storage'], 'browserErrors': errors}, ensure_ascii=False))
    browser.close()
