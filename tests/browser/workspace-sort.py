"""Run after npm run build:web: uv run --with playwright python tests/browser/workspace-sort.py."""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

root = Path(os.environ.get('WEB_BUILD', Path(__file__).resolve().parents[2] / 'web/app'))
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/workspace-sort'))
out.mkdir(parents=True, exist_ok=True)
entries = [
    {'name': 'folder', 'path': 'folder', 'type': 'directory', 'mtimeMs': 0},
    {'name': 'a.txt', 'path': 'a.txt', 'type': 'file', 'mtimeMs': 300, 'tags': ['alpha']},
    {'name': 'b.txt', 'path': 'b.txt', 'type': 'file', 'mtimeMs': 100, 'tags': ['beta']},
    {'name': 'c.txt', 'path': 'c.txt', 'type': 'file', 'mtimeMs': 200, 'tags': ['alpha']},
]


def route(request):
    path = urlparse(request.request.url).path
    if path == '/api/workspaces':
        data = {'workspaces': [{'id': 'default', 'name': 'fixture', 'isDefault': True}]}
    elif path == '/api/workspace/entries':
        data = {'path': '', 'parent': None, 'entries': entries}
    elif path.startswith('/api/'):
        data = {}
    else:
        file = root / path.removeprefix('/app/') if path.startswith('/app/') else root / 'index.html'
        request.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
        return
    request.fulfill(content_type='application/json', body=json.dumps(data))


with sync_playwright() as pw:
    browser_type = getattr(pw, os.environ.get('BROWSER_ENGINE', 'chromium'))
    browser = browser_type.launch(headless=True)
    try:
        for width in [390, 820, 1280]:
            context = browser.new_context(viewport={'width': width, 'height': 1000}, has_touch=True)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', route)
            page.goto('http://fixture/workspace')
            rows = page.locator('.workspace-file-name')
            expect(rows).to_have_text(['folder', 'a.txt', 'b.txt', 'c.txt'])
            menu = page.locator('.workspace-display-options')
            summary = menu.locator('summary')
            summary.tap()
            sort = page.get_by_label('ファイルの並び順')
            sort.select_option('mtime')
            expect(rows).to_have_text(['folder', 'b.txt', 'c.txt', 'a.txt'])
            # A touch target may receive no focus on Safari. Reproduce focusout
            # with relatedTarget=null before the direction button's click.
            sort.focus()
            sort.evaluate('(element) => element.blur()')
            expect(menu).to_have_attribute('open', '')
            page.get_by_role('button', name='降順に変更').tap()
            expect(rows).to_have_text(['folder', 'a.txt', 'c.txt', 'b.txt'])
            page.get_by_role('button', name='昇順に変更').tap()
            expect(rows).to_have_text(['folder', 'b.txt', 'c.txt', 'a.txt'])
            sort.select_option('name')
            page.get_by_role('button', name='降順に変更').tap()
            expect(rows).to_have_text(['folder', 'c.txt', 'b.txt', 'a.txt'])
            page.get_by_label('タグで絞り込み').select_option('alpha')
            expect(rows).to_have_text(['folder', 'c.txt', 'a.txt'])
            page.screenshot(path=str(out / f'sort-{width}.png'))
            # Outside taps close the menu even when nothing inside has focus.
            sort.evaluate('(element) => element.blur()')
            page.locator('.workspace-breadcrumbs').tap(position={'x': 2, 'y': 2})
            expect(menu).not_to_have_attribute('open', '')
            page.screenshot(path=str(out / f'sorted-list-{width}.png'))
            summary.tap()
            sort.focus()
            page.keyboard.press('Escape')
            expect(menu).not_to_have_attribute('open', '')
            expect(summary).to_be_focused()
            # Keyboard users can move among controls, then out of the menu.
            page.keyboard.press('Enter')
            page.keyboard.press('Tab')
            expect(sort).to_be_focused()
            page.keyboard.press('Tab')
            expect(page.get_by_role('button', name='昇順に変更')).to_be_focused()
            page.keyboard.press('Tab')
            expect(page.get_by_label('タグで絞り込み')).to_be_focused()
            page.keyboard.press('Tab')
            expect(menu).not_to_have_attribute('open', '')
            assert not errors, errors
            print(f'PASS {browser_type.name} {width}px: sort, null focusout, tags, outside tap, Escape, Tab', flush=True)
            context.close()
    finally:
        browser.close()
