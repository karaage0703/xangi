"""Catalog deletion errors stay visible in long workspace, agent and team lists.

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
out = Path(os.environ.get('EVIDENCE_DIR') or tempfile.mkdtemp(prefix='catalog-delete-feedback-'))
out.mkdir(parents=True, exist_ok=True)
print('Evidence:', out, flush=True)
team_error = 'Teamで使用中のAgentです。先にリーダー・メンバーの設定から外してください'
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'),
        headless=True, args=['--no-sandbox'],
    )
    for kind, width in [(kind, width) for kind in os.environ.get('TEST_KINDS', 'workspaces,teams,agents').split(',') for width in [1280, 375]]:
        context = browser.new_context(
            viewport={'width': width, 'height': 800},
            has_touch=width < 768, is_mobile=width < 768,
        )
        agents = [{'id': f'a{i}', 'name': f'検証担当{i}', 'prompt': ''} for i in range(40)]
        teams = [{'id': f't{i}', 'name': f'検証チーム{i}', 'members': [], 'prompt': ''} for i in range(40)]
        workspaces = [{'id': 'default', 'name': 'default', 'path': '/srv', 'isDefault': True}] + [
            {'id': f'w{i}', 'name': 'qcd-review-20261030-shared' if i == 39 else f'検証場所{i}', 'path': f'/srv/w{i}'} for i in range(40)
        ]
        items = {'agents': agents, 'teams': teams, 'workspaces': workspaces}[kind]
        title = {'agents': 'エージェントを削除', 'teams': 'チームを削除', 'workspaces': 'Workspaceの登録を解除'}[kind]
        action = '登録解除' if kind == 'workspaces' else '削除'
        message = team_error if kind == 'agents' else f'{kind}は使用中のため解除・削除できません'
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
            elif path.startswith(f'/api/{kind}/') and r.request.method == 'DELETE':
                deletes.append(path)
                if failure[0] == 'team':
                    r.fulfill(status=409, json={'error': message})
                    return
                if failure[0] == 'network':
                    r.abort('failed')
                    return
                items[:] = [a for a in items if a['id'] != path.split('/')[-1]]
                data = {'ok': True}
            elif path == '/api/teams':
                data = {'teams': teams, 'agents': agents}
            elif path == '/api/workspaces':
                data = {'workspaces': workspaces}
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
        page.goto(f'http://delete-fixture.test/settings#{kind}')
        section = page.locator(f'#{kind}')
        original_count = len(items)
        target_name = items[-1]['name']
        retry_name = items[-2]['name']
        button = section.get_by_role('button', name=f'{target_name}を{action}', exact=True)
        if width < 768:
            button.tap()
        else:
            button.click()
        dialog = page.get_by_role('dialog', name=title)
        expect(dialog).to_be_visible()
        assert not deletes
        confirm = dialog.get_by_role('button', name=action, exact=True)
        confirm.click()
        alert = dialog.get_by_role('alert')
        try:
            expect(alert).to_have_text(message)
        except AssertionError:
            page.screenshot(path=str(out / f'{kind}-failure-{width}.png'))
            raise
        expect(dialog).to_be_visible()
        expect(confirm).to_be_enabled()
        box = alert.bounding_box()
        assert box and box['y'] >= 0 and box['y'] + box['height'] <= 800
        assert page.evaluate(
            '(dialog) => dialog.getAttribute("aria-describedby").split(" ").some(id => document.getElementById(id)?.getAttribute("role") === "alert")',
            dialog.element_handle(),
        )
        page.screenshot(path=str(out / f'{kind}-error-{width}.png'))
        expect(section.locator('.catalog-row')).to_have_count(original_count)
        dialog.get_by_role('button', name='キャンセル', exact=True).click()
        expect(dialog).not_to_be_visible()
        assert len(deletes) == 1
        section.get_by_role('button', name=f'{retry_name}を{action}', exact=True).click()
        expect(dialog.get_by_role('alert')).to_have_count(0)
        failure[0] = 'network'
        confirm.click()
        expect(alert).not_to_be_empty()
        expect(dialog).to_be_visible()
        expect(confirm).to_be_enabled()
        failure[0] = None
        confirm.click()
        expect(dialog).not_to_be_visible()
        expect(section.locator('.catalog-row')).to_have_count(original_count - 1)
        expect(section.get_by_role('button', name=f'{retry_name}を{action}', exact=True)).to_have_count(0)
        expect(section.get_by_role('button', name=f'{target_name}を{action}', exact=True)).to_have_count(1)
        assert len(deletes) == 3
        assert not errors, errors
        results.append({'kind': kind, 'width': width, 'errorVisible': True, 'networkRetrySucceeded': True})
        print('PASS', kind, width, flush=True)
        context.close()
    browser.close()
(out / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
