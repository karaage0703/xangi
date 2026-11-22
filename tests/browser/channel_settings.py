"""チャンネル設定のPC/モバイル操作をビルド済みUIと隔離fixtureで検証する。"""
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='channel-settings-browser-'))
print(out, flush=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in [1280, 390]:
        context = browser.new_context(viewport={'width': width, 'height': 1000})
        saved, calls, errors = {}, [], []
        workspace_bindings, agent_bindings = {}, {}
        agent_workspace = ['dev']
        agent_backend = {}
        fail_workspace = [False]
        workspace_enabled = [True]
        workspaces = [{'id': 'default', 'name': 'default', 'path': '/workspace'}, {'id': 'dev', 'name': '開発工房', 'path': '/home/test/' + 'long-path/' * 15}]
        fail_models = [False]
        def snapshot(channel, platform):
            key = (platform, channel)
            data = agent_backend if agent_bindings.get(key) else saved.get(channel, {})
            agent = {'id': 'worker', 'name': '担当', 'workspaceId': agent_workspace[0]} if agent_bindings.get(key) else None
            workspace_id = agent['workspaceId'] if agent else workspace_bindings.get(key, 'inherit')
            effective = workspace_id
            workspace = next((w for w in workspaces if w['id'] == effective), workspaces[0])
            return {'agent': agent, 'workspace': {'enabled': workspace_enabled[0], 'value': workspace_id, 'effective': workspace}, 'backend': {'value': data.get('backend', 'inherit'), 'model': data.get('model'), 'effort': data.get('effort'), 'localLlmReasoningEffort': data.get('localLlmReasoningEffort'), 'effective': {'backend': data.get('backend', 'codex'), 'model': data.get('model'), 'localLlmReasoningEffort': data.get('localLlmReasoningEffort')}}, 'llmMode': {'value': data.get('localLlmMode') or 'inherit', 'effective': data.get('localLlmMode') or 'agent'}, 'autoReply': {'value': 'inherit', 'effective': 'off'}}
        runtime = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex', 'openrouter', 'local-llm'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}}, 'respondToBots': {'enabled': True, 'value': False}}
        def route(r):
            u = urlparse(r.request.url); path = u.path
            if path == '/api/runtime-settings':
                if r.request.method == 'POST':
                    data = r.request.post_data_json; calls.append(data)
                    key = (data.get('platform'), data.get('channelId'))
                    if data['name'] == 'workspace':
                        if fail_workspace[0]:
                            r.fulfill(status=400, json={'error': '保存できませんでした'}); return
                        if agent_bindings.get(key):
                            agent_workspace[0] = data['value']
                            r.fulfill(json={'message': '次のターンから適用されます。', 'settings': runtime}); return
                        if data['action'] == 'reset': workspace_bindings.pop(key, None)
                        else: workspace_bindings[key] = data['value']
                        r.fulfill(json={'message': 'ワークスペースを保存しました。次の /new から適用されます。', 'settings': runtime}); return
                    if data['name'] == 'agent':
                        if data['action'] == 'reset': agent_bindings.pop(key, None)
                        else: agent_bindings[key] = data['value']
                        r.fulfill(json={'message': 'saved', 'settings': runtime}); return
                    if agent_bindings.get(key):
                        agent_backend.clear()
                        if data['action'] == 'set': agent_backend.update(data)
                    elif data['action'] == 'reset': saved.pop(data['channelId'], None)
                    else: saved[data['channelId']] = data
                    r.fulfill(json={'message': '保存しました。次のturnから適用されます。', 'settings': runtime}); return
                data = runtime
            elif path == '/api/runtime-settings/channel': data = snapshot(parse_qs(u.query)['channelId'][0], parse_qs(u.query)['platform'][0])
            elif path == '/api/runtime-settings/channels': data = {'status': 'available', 'channels': [{'id': 'C1', 'name': '#test-one'}, {'id': 'C2', 'name': '#test-two'}]}
            elif path == '/api/models':
                if fail_models[0]: data = {'status': 'unavailable', 'models': [], 'supportedEfforts': []}
                else: data = {'status': 'available', 'models': [{'id': 'vendor/one', 'supportedEfforts': ['low', 'high']}, {'id': 'vendor/two', 'supportedEfforts': ['medium']}], 'supportedEfforts': ['low', 'medium', 'high']}
            elif path == '/api/config': data = {'allowedBackends': ['codex', 'openrouter'], 'uploadMaxBytes': 1000}
            elif path == '/api/connection-settings': data = {'groups': [], 'backends': []}
            elif path == '/api/startup-settings': data = {'groups': []}
            elif path == '/api/agents': data = {'agents': [{'id': 'worker', 'name': '担当', 'workspaceId': 'dev'}]}
            elif path == '/api/workspaces': data = {'workspaces': workspaces}
            elif path.startswith('/api/'): data = {}
            else:
                file = root / ('index.html' if path == '/settings' else path.removeprefix('/app/').lstrip('/'))
                r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
            r.fulfill(json=data)
        context.route('**/*', route)
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://channel-test.test/settings')
        card = page.locator('section[aria-labelledby="settings-channel-title"]')
        card.get_by_label('チャンネル', exact=True).select_option('C1')
        workspace_select = card.get_by_label('チャンネルのワークスペース', exact=True)
        workspace_save = card.get_by_role('button', name='チャンネルのワークスペースを保存', exact=True)
        expect(workspace_select).to_have_value('inherit')
        workspace_select.focus()
        page.keyboard.press('ArrowDown'); page.keyboard.press('ArrowDown'); page.keyboard.press('Enter')
        expect(workspace_select).to_have_value('dev')
        workspace_save.click()
        expect(card.get_by_role('status')).to_contain_text('次の /new から')
        assert calls[-1] == {'name': 'workspace', 'action': 'set', 'value': 'dev', 'platform': 'discord', 'channelId': 'C1'}
        page.reload(); card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(workspace_select).to_have_value('dev')
        expect(card).to_contain_text('現在の作業場所: 開発工房')
        card.screenshot(path=str(out / f'workspace-{width}.png'))
        assert card.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        card.get_by_label('チャンネル', exact=True).select_option('C2')
        expect(workspace_select).to_have_value('inherit')
        card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(workspace_select).to_have_value('dev')
        fail_workspace[0] = True
        workspace_select.select_option('inherit'); workspace_save.click()
        expect(card.get_by_role('status')).to_have_text('保存できませんでした')
        assert workspace_bindings[('discord', 'C1')] == 'dev'
        fail_workspace[0] = False
        workspace_save.click()
        expect(card.get_by_role('status')).to_contain_text('次の /new から')
        assert ('discord', 'C1') not in workspace_bindings
        card.get_by_label('エージェント', exact=True).select_option('worker')
        card.get_by_role('button', name='担当を保存', exact=True).click()
        expect(workspace_select).to_have_value('dev')
        expect(workspace_select).to_be_enabled()
        expect(workspace_save).to_be_enabled()
        expect(card.get_by_label('バックエンド')).to_be_enabled()
        workspace_select.select_option('default'); workspace_save.click()
        expect(card.get_by_role('status')).to_contain_text('次のターンから')
        assert agent_workspace[0] == 'default'
        assert ('discord', 'C1') not in workspace_bindings
        card.get_by_label('バックエンド').select_option('openrouter')
        card.get_by_label('モデル', exact=True).select_option('vendor/one')
        card.get_by_role('button', name='チャンネルのモデル設定を保存').click()
        expect(card.get_by_role('status')).to_have_text('保存しました。次のturnから適用されます。')
        assert agent_backend['model'] == 'vendor/one' and 'C1' not in saved
        card.get_by_label('エージェント', exact=True).select_option('')
        card.get_by_role('button', name='担当を保存', exact=True).click()
        expect(workspace_select).to_be_enabled()
        expect(card.get_by_label('バックエンド')).to_have_value('inherit')
        card.get_by_label('プラットフォーム').select_option('slack')
        card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(workspace_select).to_have_value('inherit')
        workspace_select.select_option('dev'); workspace_save.click()
        expect(card.get_by_role('status')).to_contain_text('次の /new から')
        assert calls[-1]['platform'] == 'slack'
        card.get_by_label('バックエンド').select_option('openrouter')
        assert card.get_by_label('モデル', exact=True).evaluate('(e) => e.tagName') == 'SELECT'
        card.get_by_label('モデル', exact=True).select_option('vendor/one')
        card.get_by_label('Effort（推論強度）').select_option('high')
        expect(card.get_by_label('Effort（推論強度）').locator('option')).to_have_count(3)
        card.get_by_label('動作モード').select_option('chat')
        card.get_by_role('button', name='チャンネルのモデル設定を保存').click()
        expect(card.get_by_role('status')).to_have_text('保存しました。次のturnから適用されます。')
        assert calls[-1]['localLlmReasoningEffort'] == 'high' and calls[-1]['platform'] == 'slack'
        page.reload(); card.get_by_label('プラットフォーム').select_option('slack'); card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(card.get_by_label('モデル', exact=True)).to_have_value('vendor/one')
        expect(card.get_by_label('Effort（推論強度）')).to_have_value('high')
        card.get_by_label('チャンネル', exact=True).select_option('C2')
        expect(card.get_by_label('バックエンド')).to_have_value('inherit')
        card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(card.get_by_label('Effort（推論強度）')).to_have_value('high')
        fail_models[0] = True
        card.get_by_role('button', name='モデル一覧を再読み込み').click()
        expect(card.get_by_role('button', name='チャンネルのモデル設定を保存')).to_be_disabled()
        fail_models[0] = False
        card.get_by_role('button', name='モデル一覧を再読み込み').click()
        expect(card.get_by_role('button', name='チャンネルのモデル設定を保存')).to_be_enabled()
        card.get_by_label('モデル', exact=True).select_option('vendor/two')
        expect(card.get_by_label('Effort（推論強度）')).to_have_value('')
        card.get_by_label('Effort（推論強度）').select_option('medium')
        if width == 1280:
            backend_box = card.get_by_label('バックエンド').bounding_box()
            model_box = card.get_by_label('モデル', exact=True).bounding_box()
            assert abs(backend_box['y'] - model_box['y']) <= 1, (backend_box, model_box)
            assert abs(backend_box['height'] - model_box['height']) <= 1
        card.screenshot(path=str(out / f'channel-{width}.png'))
        assert card.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        card.get_by_label('バックエンド').select_option('inherit')
        card.get_by_role('button', name='チャンネルのモデル設定を保存').click()
        expect(card.get_by_role('status')).to_have_text('保存しました。次のturnから適用されます。')
        assert 'C1' not in saved
        workspace_enabled[0] = False
        page.reload(); card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(workspace_select).to_be_disabled()
        expect(workspace_save).to_be_disabled()
        workspace_enabled[0] = True
        runtime['backend']['enabled'] = False
        page.reload(); card.get_by_label('チャンネル', exact=True).select_option('C1')
        expect(workspace_select).to_be_enabled()
        expect(workspace_save).to_be_enabled()
        expect(card.get_by_label('バックエンド')).to_be_disabled()
        assert not errors, errors
        context.close()
    browser.close()
print('PASS: Discord/Slack workspace保存・再読込・チャンネル切替・失敗後再試行・継承リセット・担当優先・機能フラグ・キーボード操作・長いパス、モデル設定回帰 (1280/390px)')
