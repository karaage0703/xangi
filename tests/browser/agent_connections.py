"""Dedicated Discord/Slack connection forms using built UI and isolated API fixtures."""
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/agent-connections-browser'))
out.mkdir(parents=True, exist_ok=True)
print('Evidence:', out, flush=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'), headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 390, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            connections, calls, errors = [], [], []
            reject = [False]
            agent = {'id': 'a1', 'name': '接続検証担当', 'prompt': '', 'workspaceId': 'default'}
            def route(r):
                parsed = urlparse(r.request.url)
                path, method = parsed.path, r.request.method
                if path == '/api/sessions/stream':
                    r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                if path == '/api/agents/a1/connections' and method == 'POST':
                    body = r.request.post_data_json
                    calls.append(body)
                    if reject[0]:
                        r.fulfill(status=400, json={'error':'専用Botを作成してください'}); return
                    connection = {k: v for k, v in body.items() if k not in ['botToken','appToken']}
                    connection.update(id=str(len(connections)+1), status='stopped')
                    connections.append(connection); data = {'connection':connection}
                elif path.startswith('/api/agents/a1/connections/') and method == 'PATCH':
                    body = r.request.post_data_json; calls.append(body)
                    connection = next(c for c in connections if c['id'] == path.split('/')[-1])
                    connection.update({k:v for k,v in body.items() if k not in ['botToken','appToken']})
                    data = {'connection':connection}
                elif path.startswith('/api/agents/a1/connections/') and method == 'DELETE':
                    connections[:] = [c for c in connections if c['id'] != path.split('/')[-1]]; data = {'ok':True}
                elif path == '/api/agents/a1/connections': data = {'connections':connections}
                elif path == '/api/config': data = {'allowedBackends':['codex']}
                elif path == '/api/runtime-settings': data = {'backend':{'enabled':True,'value':{'backend':'codex'},'options':['codex'],'applyMode':'next-turn'},'replySuggestions':{'enabled':True,'value':'inherit','effective':{'web':True,'discord':True,'slack':True},'applyMode':'immediate'},'respondToBots':{'enabled':True,'value':False,'applyMode':'immediate'}}
                elif path == '/api/agents': data = {'agents':[agent]}
                elif path == '/api/models': data = {'models':[],'supportedEfforts':[]}
                elif path in ['/api/projects','/api/teams','/api/sessions']: data = {path.split('/')[-1]:[]}
                elif path == '/api/workspaces': data = {'workspaces':[{'id':'default','name':'default','path':'/srv','isDefault':True}]}
                elif path == '/api/runtime-settings/channels': data = {'channels':[]}
                elif path == '/api/startup-settings': data = {'groups':[]}
                elif path == '/api/connection-settings': data = {'groups':[],'backends':[]}
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path in ['/', '/settings'] else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page(); page.set_default_timeout(10000)
            page.on('pageerror', lambda e: (errors.append(str(e)), print('PAGE ERROR:', e, flush=True)))
            def open_editor():
                page.goto('http://connection-test.test/settings#agents')
                page.reload()
                page.get_by_role('button', name='接続検証担当を編集', exact=True).click()
            open_editor()
            section = page.get_by_role('region', name='専用Bot接続')
            expect(section.get_by_text('専用Botは未設定です。')).to_be_visible()
            for platform in ['discord', 'slack']:
                section.get_by_role('button', name='接続を追加').click()
                expect(section.get_by_label('接続名（任意）')).not_to_have_attribute('required', '')
                if platform == 'slack': section.get_by_label('接続名（任意）').fill('担当専用' + platform)
                section.get_by_label('サービス', exact=True).select_option(platform)
                section.get_by_label('Botトークン（必須）', exact=True).fill('fixture-bot-' + platform)
                if platform == 'slack': section.get_by_label('Appトークン（必須）').fill('fixture-app')
                section.get_by_label('許可ユーザーID（必須）').fill('123' if platform == 'discord' else 'U123')
                reject[0] = True
                section.get_by_role('button', name='接続を保存').click()
                expect(section.get_by_role('alert')).to_contain_text('専用Bot')
                expect(section.get_by_label('Botトークン（必須）', exact=True)).to_have_value('fixture-bot-' + platform)
                reject[0] = False
                page.screenshot(path=str(out / f'{platform}-form-{width}.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                section.get_by_role('button', name='接続を保存').click()
                expect(section.get_by_role('button', name='接続を追加')).to_be_visible()
                expect(section.get_by_role('status')).to_contain_text('再起動して')
                expect(section.get_by_text('反映にはxangiの再起動が必要です。', exact=True)).to_be_in_viewport()
            section.evaluate('(e) => e.scrollIntoView({block: "start"})')
            page.screenshot(path=str(out / f'connections-{width}.png'), full_page=True)
            open_editor()
            expect(section.locator('.catalog-row')).to_have_count(2)
            section.get_by_role('button', name='担当専用slackを編集').click()
            expect(section.get_by_label('Botトークン（変更する場合のみ）', exact=True)).to_have_value('')
            expect(section.get_by_label('Appトークン（変更する場合のみ）')).to_have_value('')
            section.get_by_label('接続名（任意）').fill('Slack変更後')
            section.get_by_label('次回起動時に接続する').uncheck()
            section.get_by_role('button', name='接続を保存').click()
            expect(section.get_by_text('Slack変更後', exact=True)).to_be_visible()
            assert calls[-1]['botToken'] == '' and calls[-1]['appToken'] == '' and not calls[-1]['enabled']
            section.get_by_role('button', name='Slack変更後を編集').click()
            section.get_by_label('接続名（任意）').fill('')
            section.get_by_role('button', name='接続を保存').click()
            expect(section.get_by_role('button', name='Slackを編集')).to_be_visible()
            open_editor()
            section.get_by_role('button', name='Slackを編集').click()
            expect(section.get_by_label('接続名（任意）')).to_have_value('')
            section.get_by_role('button', name='キャンセル', exact=True).click()
            section.get_by_role('button', name='Discordを削除').click()
            dialog = page.get_by_role('dialog', name='専用Bot接続を削除')
            expect(dialog).to_contain_text('再起動まで継続')
            expect(dialog).to_contain_text('Discord')
            dialog.get_by_role('button', name='削除', exact=True).click()
            expect(section.locator('.catalog-row')).to_have_count(1)
            expect(section.get_by_role('status')).to_contain_text('再起動して')
            section.get_by_role('button', name='接続を追加').click()
            section.get_by_role('button', name='キャンセル', exact=True).click()
            expect(section.get_by_role('button', name='接続を追加')).to_be_visible()
            assert not errors, errors
            context.close()
            print(f'{width}px: both services create/retry/reload/edit/disable/delete/cancel PASS', flush=True)
    finally:
        browser.close()
