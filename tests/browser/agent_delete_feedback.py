"""Deletion errors remain visible beside the action, even in a long agent list.

Run after npm run build:web with uv run --with playwright python <this file>.
All API requests are intercepted; no real agent or team is changed.
"""
import json
import mimetypes
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

root = Path(os.environ.get('UI_ROOT', Path(__file__).resolve().parents[2] / 'web/app'))
out = Path(tempfile.mkdtemp(prefix='agent-delete-feedback-'))
print('Evidence:', out, flush=True)
team_error = 'Teamで使用中のAgentです。先にリーダー・メンバーの設定から外してください'
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'),
        headless=True, args=['--no-sandbox'],
    )
    for width in [1280, 375]:
        context = browser.new_context(
            viewport={'width': width, 'height': 800},
            has_touch=width < 768, is_mobile=width < 768,
        )
        agents = [{'id': f'a{i}', 'name': f'検証担当{i}', 'prompt': ''} for i in range(40)]
        deletes, errors = [], []
        failure = ['team']

        def route(r):
            path = urlparse(r.request.url).path
            if path == '/api/sessions/stream':
                r.fulfill(content_type='text/event-stream', body=': ready\n\n')
                return
            if path == '/api/config':
                data = {'allowedBackends': ['codex']}
            elif path == '/api/runtime-settings':
                data = {
                    'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex']},
                    'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True}},
                    'respondToBots': {'enabled': True, 'value': False},
                }
            elif path in ['/api/startup-settings', '/api/connection-settings']:
                data = {'groups': [], 'backends': []}
            elif path == '/api/runtime-settings/channels':
                data = {'status': 'disabled', 'channels': []}
            elif path == '/api/agents':
                data = {'agents': agents}
            elif path.startswith('/api/agents/') and r.request.method == 'DELETE':
                deletes.append(path)
                if failure[0] == 'team':
                    r.fulfill(status=409, json={'error': team_error})
                    return
                if failure[0] == 'network':
                    r.abort('failed')
                    return
                agents[:] = [a for a in agents if a['id'] != path.split('/')[-1]]
                data = {'ok': True}
            elif path == '/api/teams':
                data = {'teams': [], 'agents': agents}
            elif path == '/api/workspaces':
                data = {'workspaces': [{'id': 'default', 'name': 'default', 'path': '/srv', 'isDefault': True}]}
            elif path.startswith('/api/'):
                data = {}
            else:
                file = root / ('index.html' if path == '/settings' else path.removeprefix('/app/').lstrip('/'))
                r.fulfill(
                    status=200 if file.is_file() else 404,
                    body=file.read_bytes() if file.is_file() else b'',
                    content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',
                )
                return
            r.fulfill(json=data)

        context.route('**/*', route)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://delete-fixture.test/settings#agents')
        section = page.locator('#agents')
        button = section.get_by_role('button', name='検証担当39を削除', exact=True)
        if width < 768:
            button.tap()
        else:
            button.click()
        dialog = page.get_by_role('dialog', name='エージェントを削除')
        expect(dialog).to_be_visible()
        assert not deletes
        confirm = dialog.get_by_role('button', name='削除', exact=True)
        confirm.click()
        alert = dialog.get_by_role('alert')
        expect(alert).to_have_text(team_error)
        expect(dialog).to_be_visible()
        expect(confirm).to_be_enabled()
        box = alert.bounding_box()
        assert box and box['y'] >= 0 and box['y'] + box['height'] <= 800
        assert page.evaluate(
            '(dialog) => dialog.getAttribute("aria-describedby").split(" ").some(id => document.getElementById(id)?.getAttribute("role") === "alert")',
            dialog.element_handle(),
        )
        page.screenshot(path=str(out / f'team-error-{width}.png'))
        expect(section.locator('.catalog-row')).to_have_count(40)
        dialog.get_by_role('button', name='キャンセル', exact=True).click()
        expect(dialog).not_to_be_visible()
        assert len(deletes) == 1
        section.get_by_role('button', name='検証担当38を削除', exact=True).click()
        expect(dialog.get_by_role('alert')).to_have_count(0)
        failure[0] = 'network'
        confirm.click()
        expect(alert).not_to_be_empty()
        expect(dialog).to_be_visible()
        expect(confirm).to_be_enabled()
        failure[0] = None
        confirm.click()
        expect(dialog).not_to_be_visible()
        expect(section.locator('.catalog-row')).to_have_count(39)
        expect(section.get_by_role('button', name='検証担当38を削除', exact=True)).to_have_count(0)
        expect(section.get_by_role('button', name='検証担当39を削除', exact=True)).to_have_count(1)
        assert len(deletes) == 3
        assert not errors, errors
        results.append({'width': width, 'teamErrorVisible': True, 'networkRetrySucceeded': True})
        print('PASS', width, flush=True)
        context.close()
    browser.close()
(out / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
