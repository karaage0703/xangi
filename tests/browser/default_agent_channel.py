"""Default agent channel binding in the built UI with isolated API fixtures."""
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='default-agent-channel-'))
print(out, flush=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 390]:
            context = browser.new_context(viewport={'width': width, 'height': 900})
            agent = {'id': 'xangi:default', 'name': 'デフォルト（普段のxangi）', 'prompt': '', 'workspaceId': 'default', 'workChannel': None}
            saves, errors, ai_saves = [], [], []
            fail_ai = [False]
            channel_queries = []
            member = {'id': 'member', 'name': '通常担当', 'prompt': '', 'workspaceId': 'default'}
            runtime = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}, 'applyMode': 'immediate'}, 'respondToBots': {'enabled': True, 'value': False, 'applyMode': 'immediate'}}
            def route(r):
                u = urlparse(r.request.url)
                path, method = unquote(u.path), r.request.method
                if path == '/api/sessions/stream':
                    r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                if path == '/api/agents/member' and method == 'PATCH':
                    member.update(r.request.post_data_json)
                    r.fulfill(json={'agent': member}); return
                if path == '/api/agents/xangi:default' and method == 'PATCH':
                    agent.update(r.request.post_data_json)
                    r.fulfill(json={'agent': agent}); return
                if path == '/api/agents/xangi:default/channel' and method == 'PUT':
                    body = r.request.post_data_json
                    saves.append(body)
                    agent['workChannel'] = {'platform': body['platform'], 'channelId': body['channelId']} if body['action'] == 'set' else None
                    data = {'workChannel': agent['workChannel']}
                elif path == '/api/agents': data = {'agents': [agent, member]}
                elif path.startswith('/api/agents/') and path.endswith('/connections'): data = {'connections': []}
                elif path == '/api/config': data = {'allowedBackends': ['codex']}
                elif path == '/api/runtime-settings':
                    data = runtime
                    if method == 'POST':
                        if fail_ai[0]:
                            r.fulfill(status=500, json={'error': 'test save failure'}); return
                        ai_saves.append(r.request.post_data_json)
                        runtime['backend']['value'] = {k: v for k, v in r.request.post_data_json.items() if k in ['backend', 'model', 'effort']}
                        data = {'message': '保存しました', 'settings': data}
                elif path == '/api/runtime-settings/channels':
                    channel_queries.append(parse_qs(u.query))
                    data = {'channels': [{'id': 'C1', 'name': 'default-work'}]}
                elif path in ['/api/startup-settings', '/api/connection-settings']: data = {'groups': [], 'backends': []}
                elif path == '/api/workspaces': data = {'workspaces': [{'id': 'default', 'name': 'default', 'path': '/srv', 'isDefault': True}, {'id': 'writing', 'name': 'writing', 'path': '/writing', 'isDefault': False}]}
                elif path == '/api/models': data = {'models': [{'id': 'test-model'}], 'supportedEfforts': ['low', 'high'], 'status': 'available'}
                elif path == '/api/sessions': data = {'sessions': []}
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path in ['/', '/settings'] else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto('http://default-agent.test/settings#agents')
            section = page.locator('#agents')
            section.get_by_role('button', name='デフォルト（普段のxangi）を編集').click()
            expect(section.get_by_label('名前', exact=True)).to_have_value('デフォルト（普段のxangi）')
            section.get_by_label('名前', exact=True).fill('borot')
            section.get_by_label('ワークスペース', exact=True).select_option('writing')
            section.get_by_label('モデル', exact=True).select_option('test-model')
            section.get_by_text('詳細設定', exact=True).click()
            section.get_by_label('effort', exact=True).select_option('high')
            section.get_by_role('button', name='保存', exact=True).click()
            section.get_by_role('button', name='borotを編集').click()
            expect(section.get_by_label('名前', exact=True)).to_have_value('borot')
            expect(section.get_by_label('ワークスペース', exact=True)).to_have_value('writing')
            assert ai_saves[-1]['name'] == 'backend'
            assert ai_saves[-1]['backend'] == 'codex'
            assert ai_saves[-1]['model'] == 'test-model'
            assert ai_saves[-1]['effort'] == 'high'
            expect(section.get_by_role('button', name='保存', exact=True)).to_have_count(1)
            expect(section.get_by_role('button', name='既定を保存')).to_have_count(0)
            expect(page.get_by_role('heading', name='AIの既定', exact=True)).to_have_count(0)
            expect(section.get_by_role('button', name='エージェントを削除')).to_have_count(0)
            section.get_by_label('設定先チャンネル').select_option('discord:C1')
            section.get_by_role('button', name='チャンネルを設定', exact=True).click()
            expect(section.get_by_text('現在の設定先:', exact=False)).to_contain_text('Discord / #default-work')
            page.reload()
            section.get_by_role('button', name='borotを編集').click()
            expect(section.get_by_label('モデル', exact=True)).to_have_value('test-model')
            expect(section.get_by_text('現在の設定先:', exact=False)).to_contain_text('Discord / #default-work')
            section.scroll_into_view_if_needed()
            page.screenshot(path=str(out / f'default-{width}.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            section.get_by_role('button', name='チャンネルの紐づきを解除').click()
            expect(section.get_by_text('現在の設定先:', exact=False)).to_contain_text('未設定')
            section.get_by_label('設定先チャンネル').select_option('slack:C1')
            section.get_by_role('button', name='チャンネルを設定', exact=True).click()
            expect(section.get_by_text('現在の設定先:', exact=False)).to_contain_text('Slack / #default-work')
            section.get_by_role('button', name='キャンセル').click()
            expect(section.get_by_role('button', name='borotを削除')).to_have_count(0)
            assert [s['action'] for s in saves] == ['set', 'reset', 'set']
            for platform in ('discord', 'slack'):
                assert {'platform': [platform], 'agentId': [agent['id']]} in channel_queries
            section.get_by_role('button', name='borotを編集').click()
            section.get_by_label('名前', exact=True).fill('borot retry')
            fail_ai[0] = True
            section.get_by_role('button', name='保存', exact=True).click()
            expect(section.get_by_role('alert')).to_contain_text('AI設定を保存できませんでした')
            expect(section.get_by_label('名前', exact=True)).to_have_value('borot retry')
            expect(section.get_by_label('モデル', exact=True)).to_have_value('test-model')
            fail_ai[0] = False
            section.get_by_role('button', name='保存', exact=True).click()
            section.get_by_role('button', name='通常担当を編集').click()
            expect(section.get_by_label('バックエンド', exact=True)).to_have_value('')
            expect(section.get_by_label('バックエンド').locator('option[value=""]')).to_have_text('デフォルト担当の設定を使う')
            section.get_by_label('バックエンド').select_option('codex')
            section.get_by_label('モデル').select_option('test-model')
            section.get_by_text('詳細設定', exact=True).click()
            section.get_by_label('effort', exact=True).select_option('low')
            section.get_by_role('button', name='保存', exact=True).click()
            section.get_by_role('button', name='通常担当を編集').click()
            expect(section.get_by_label('モデル')).to_have_value('test-model')
            expect(section.get_by_label('effort')).to_have_value('low')
            assert member['backend'] == 'codex'
            section.get_by_label('バックエンド').select_option('')
            section.get_by_role('button', name='保存', exact=True).click()
            assert member['backend'] is None and member['model'] is None
            assert not errors, errors
            print('PASS', width, flush=True)
            context.close()
    finally:
        browser.close()
