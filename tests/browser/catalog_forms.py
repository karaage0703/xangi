"""Settings consolidation smoke test against the built UI and isolated API fixtures."""
import json
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='catalog-browser-'))
print('Evidence:', out, flush=True)
results = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 768, 414, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            agents, saved, errors, projects = [], [], [], []
            workspaces = [{'id': 'default', 'name': 'default', 'path': '/srv', 'isDefault': True}]
            reject_delete = [True]
            def route(r):
                parsed = urlparse(r.request.url)
                path, method = parsed.path, r.request.method
                if path == '/api/sessions/stream':
                    r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                if path == '/api/config':
                    data = {'uploadAccept': None, 'uploadMaxBytes': 64000000, 'allowedBackends': ['codex', 'local-llm']}
                elif path == '/api/runtime-settings':
                    data = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}, 'applyMode': 'immediate'}, 'respondToBots': {'enabled': True, 'value': False, 'applyMode': 'immediate'}}
                elif path == '/api/startup-settings': data = {'groups': []}
                elif path == '/api/connection-settings': data = {'groups': [], 'backends': []}
                elif path == '/api/runtime-settings/channels': data = {'status': 'disabled', 'channels': [], 'message': 'No test channels'}
                elif path == '/api/agents' and method == 'POST':
                    agent = {**r.request.post_data_json, 'id': 'a1'}
                    agents.append(agent); saved.append(agent.copy()); data = {'agent': agent}
                elif path.startswith('/api/agents/') and method == 'PATCH':
                    agents[0].update(r.request.post_data_json); saved.append(agents[0].copy()); data = {'agent': agents[0]}
                elif path.startswith('/api/agents/') and method == 'DELETE':
                    if reject_delete[0]:
                        r.fulfill(status=409, json={'error': '未完了の会話で使用中です'}); return
                    agents.clear(); data = {'ok': True}
                elif path == '/api/agents': data = {'agents': agents}
                elif path == '/api/projects' and method == 'POST':
                    project = {**r.request.post_data_json, 'id': 'p1'}
                    projects.append(project); data = {'project': project}
                elif path == '/api/projects': data = {'projects': projects}
                elif path == '/api/workspaces/directories':
                    directory = parse_qs(parsed.query).get('path', ['/srv'])[0]
                    data = {'path': directory, 'parent': '/srv' if directory != '/srv' else None, 'roots': ['/srv'], 'directories': [{'name': 'child', 'path': '/srv/child'}] if directory == '/srv' else []}
                elif path == '/api/workspaces' and method == 'POST':
                    workspaces.append({**r.request.post_data_json, 'id': 'child', 'isDefault': False}); data = {'workspace': workspaces[-1]}
                elif path == '/api/workspaces': data = {'workspaces': workspaces}
                elif path == '/api/sessions': data = {'sessions': []}
                elif path == '/api/models': data = {'models': [{'id': 'gpt-test', 'supportedEfforts': ['high']}], 'supportedEfforts': ['high'], 'status': 'available'}
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path in ['/', '/settings'] else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            def open_projects():
                page.goto('http://agent-owned.test/')
                if width <= 768: page.get_by_role('button', name='サイドバーを開く').click()
                page.get_by_role('button', name='Projects', exact=False).click()
            open_projects()
            page.screenshot(path=str(out / f'projects-{width}.png'), animations='disabled')
            assert page.locator('.project-view').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            expect(page.get_by_role('button', name='エージェント', exact=True)).to_have_count(0)
            page.get_by_role('link', name='ワークスペース設定', exact=True).click()
            expect(page).to_have_url('http://agent-owned.test/settings#workspaces')
            expect(page.locator('#workspaces')).to_be_focused()
            workspace = page.locator('#workspaces')
            workspace.get_by_label('名前', exact=True).fill('子の作業場所')
            workspace.get_by_role('button', name='参照…').click()
            dialog = page.get_by_role('dialog', name='サーバーのフォルダを選択')
            dialog.get_by_role('button', name='📁 child', exact=True).click()
            dialog.get_by_role('button', name='このフォルダを選択', exact=True).click()
            expect(workspace.get_by_label('ディレクトリの絶対パス')).to_have_value('/srv/child')
            workspace.get_by_role('button', name='参照…').click()
            page.keyboard.press('Escape')
            expect(dialog).not_to_be_visible()
            expect(workspace.get_by_label('ディレクトリの絶対パス')).to_have_value('/srv/child')
            workspace.get_by_role('button', name='Workspaceを追加').click()
            expect(workspace.locator('.workspace-manager-row')).to_have_count(2)
            open_projects()
            page.get_by_role('link', name='エージェント設定', exact=True).click()
            expect(page).to_have_url('http://agent-owned.test/settings#agents')
            section = page.locator('#agents')
            expect(section).to_be_focused()
            page.screenshot(path=str(out / f'settings-{width}.png'), animations='disabled')
            section.get_by_role('button', name='＋ 新規エージェント', exact=True).click()
            expect(section.locator('.catalog-filter')).to_have_count(0)
            section.get_by_label('名前', exact=True).fill('Avatar:検証担当')
            section.get_by_label('個別指示', exact=True).fill('変更前に確認する')
            section.get_by_label('得意なことを一言').fill('画面の検証')
            section.get_by_label('ワークスペース', exact=True).select_option('child')
            section.get_by_label('バックエンド', exact=True).select_option('local-llm')
            section.get_by_label('動作モード', exact=True).select_option('chat')
            section.get_by_label('Local LLMの推論強度', exact=True).select_option('low')
            section.get_by_label('モデル', exact=True).select_option('gpt-test')
            section.get_by_text('詳細設定', exact=True).click()
            section.get_by_label('effort', exact=True).select_option('high')
            page.screenshot(path=str(out / f'form-{width}.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert section.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            section.get_by_role('button', name='作成', exact=True).click()
            expect(section.locator('.agent-view-row')).to_have_count(1)
            assert saved[-1]['workspaceId'] == 'child' and saved[-1]['localLlmMode'] == 'chat'
            assert saved[-1]['localLlmReasoningEffort'] == 'low' and saved[-1]['effort'] == 'high'
            page.reload()
            section.get_by_role('button', name='Avatar:検証担当を編集').click()
            expect(section.get_by_label('個別指示')).to_have_value('変更前に確認する')
            expect(section.get_by_label('ワークスペース', exact=True)).to_have_value('child')
            expect(section.get_by_label('動作モード')).to_have_value('chat')
            section.get_by_label('動作モード').select_option('agent')
            section.get_by_role('button', name='更新', exact=True).click()
            expect(section.locator('.project-form')).to_have_count(0)
            assert saved[-1]['localLlmMode'] == 'agent'
            section.get_by_role('button', name='Avatar:検証担当を編集').click()
            section.get_by_label('バックエンド').select_option('codex')
            expect(section.get_by_label('動作モード')).to_have_count(0)
            section.get_by_role('button', name='更新', exact=True).click()
            expect(section.locator('.project-form')).to_have_count(0)
            assert saved[-1]['localLlmMode'] is None and saved[-1]['localLlmReasoningEffort'] is None
            section.get_by_role('button', name='Avatar:検証担当を削除').click()
            page.get_by_role('dialog').get_by_role('button', name='削除', exact=True).click()
            expect(section.get_by_role('alert')).to_contain_text('未完了の会話で使用中')
            expect(section.locator('.agent-view-row')).to_have_count(1)
            reject_delete[0] = False
            section.get_by_role('button', name='Avatar:検証担当を削除').click()
            page.get_by_role('dialog').get_by_role('button', name='削除', exact=True).click()
            expect(section.locator('.agent-view-row')).to_have_count(0)
            expect(section.get_by_role('alert')).to_have_count(0)
            open_projects()
            page.get_by_role('button', name='＋ 新規プロジェクト', exact=True).click()
            form = page.locator('.project-form')
            expect(form.get_by_label('ワークスペース', exact=True)).to_have_count(0)
            form.get_by_label('名前', exact=True).fill('検証プロジェクト')
            form.get_by_label('共通指示', exact=True).fill('共通の指示')
            form.get_by_role('button', name='作成', exact=True).click()
            expect(form).to_have_count(0)
            assert projects[-1]['prompt'] == '共通の指示'
            assert not errors, errors
            results.append({'width': width, 'pass': True, 'saves': saved, 'errors': errors})
            print('PASS', width, flush=True)
            context.close()
    finally:
        browser.close()
(out / 'browser.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
