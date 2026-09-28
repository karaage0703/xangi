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
        fail_models = [False]
        def snapshot(channel):
            data = saved.get(channel, {})
            return {'backend': {'value': data.get('backend', 'inherit'), 'model': data.get('model'), 'effort': data.get('effort'), 'localLlmReasoningEffort': data.get('localLlmReasoningEffort'), 'effective': {'backend': data.get('backend', 'codex'), 'model': data.get('model'), 'localLlmReasoningEffort': data.get('localLlmReasoningEffort')}}, 'llmMode': {'value': data.get('localLlmMode') or 'inherit', 'effective': data.get('localLlmMode') or 'agent'}, 'autoReply': {'value': 'inherit', 'effective': 'off'}}
        runtime = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex', 'openrouter', 'local-llm'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}}, 'respondToBots': {'enabled': True, 'value': False}}
        def route(r):
            u = urlparse(r.request.url); path = u.path
            if path == '/api/runtime-settings':
                if r.request.method == 'POST':
                    data = r.request.post_data_json; calls.append(data)
                    if data['action'] == 'reset': saved.pop(data['channelId'], None)
                    else: saved[data['channelId']] = data
                    r.fulfill(json={'message': '保存しました', 'settings': runtime}); return
                data = runtime
            elif path == '/api/runtime-settings/channel': data = snapshot(parse_qs(u.query)['channelId'][0])
            elif path == '/api/runtime-settings/channels': data = {'status': 'available', 'channels': [{'id': 'C1', 'name': '#test-one'}, {'id': 'C2', 'name': '#test-two'}]}
            elif path == '/api/models':
                if fail_models[0]: data = {'status': 'unavailable', 'models': [], 'supportedEfforts': []}
                else: data = {'status': 'available', 'models': [{'id': 'vendor/one', 'supportedEfforts': ['low', 'high']}, {'id': 'vendor/two', 'supportedEfforts': ['medium']}], 'supportedEfforts': ['low', 'medium', 'high']}
            elif path == '/api/config': data = {'allowedBackends': ['codex', 'openrouter'], 'uploadMaxBytes': 1000}
            elif path == '/api/connection-settings': data = {'groups': [], 'backends': []}
            elif path == '/api/startup-settings': data = {'groups': []}
            elif path == '/api/agents': data = {'agents': []}
            elif path == '/api/workspaces': data = {'workspaces': []}
            elif path.startswith('/api/'): data = {}
            else:
                file = root / ('index.html' if path == '/settings' else path.removeprefix('/app/').lstrip('/'))
                r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
            r.fulfill(json=data)
        context.route('**/*', route)
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://channel-test.test/settings')
        card = page.locator('section[aria-labelledby="settings-channel-title"]')
        card.get_by_label('プラットフォーム').select_option('slack')
        card.get_by_label('チャンネル', exact=True).select_option('C1')
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
        assert not errors, errors
        context.close()
    browser.close()
print('PASS: 保存・再読込・チャンネル切替・モデル別Effort・取得失敗・継承リセット (1280/390px)')
