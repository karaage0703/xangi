"""Settings consolidation smoke test against the built UI and isolated API fixtures."""
import json
import mimetypes
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='catalog-browser-'))
print('Evidence:', out, flush=True)
results = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'), headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 768, 414, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            agents, saved, errors, projects = [], [], [], []
            chats, sessions = [], []
            reject_session = [False]
            missing_cli = [False]
            workspaces = [{'id': 'default', 'name': 'default', 'path': '/srv', 'isDefault': True}]
            reject_delete = [True]
            def route(r):
                parsed = urlparse(r.request.url)
                path, method = parsed.path, r.request.method
                if path == '/api/sessions/stream':
                    r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                if path == '/api/config':
                    data = {'instanceCliCommand': None if missing_cli[0] else "'/srv/test instance/bin/xangi'", 'uploadAccept': None, 'uploadMaxBytes': 64000000, 'allowedBackends': ['codex', 'local-llm']}
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
                    data = {'path': directory, 'parent': '/srv' if directory != '/srv' else None, 'directories': [{'name': 'child', 'path': '/srv/child'}] if directory == '/srv' else []}
                elif path == '/api/workspaces' and method == 'POST':
                    workspaces.append({**r.request.post_data_json, 'id': 'child', 'isDefault': False}); data = {'workspace': workspaces[-1]}
                elif path == '/api/workspaces': data = {'workspaces': workspaces}
                elif path == '/api/teams': data = {'teams': [], 'agents': agents}
                elif path == '/api/sessions' and method == 'POST':
                    if reject_session[0]:
                        r.fulfill(status=503, json={'error': 'テスト用の作成失敗'}); return
                    assert r.request.post_data_json == {'workspaceId': 'default'}
                    sessions.append({'id': f'consult-{len(sessions)}', 'title': '作成相談', 'platform': 'web', 'messages': []})
                    data = {'sessionId': sessions[-1]['id']}
                elif path == '/api/sessions': data = {'sessions': sessions}
                elif path.startswith('/api/sessions/consult-') and path.endswith('/turns'): data = {'turns': []}
                elif path.startswith('/api/sessions/consult-'): data = next(s for s in sessions if s['id'] == path.split('/')[3])
                elif path == '/api/chat':
                    chats.append(r.request.post_data_json)
                    r.fulfill(content_type='text/event-stream', body='event: done\ndata: {}\n\n'); return
                elif path == '/api/models': data = {'models': [{'id': 'gpt-test', 'supportedEfforts': ['high']}], 'supportedEfforts': ['high'], 'status': 'available'}
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if (path in ['/', '/settings'] or path.startswith('/chat/')) else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            def open_projects():
                page.goto('http://agent-owned.test/')
                if width <= 768: page.get_by_role('button', name='サイドバーを開く').click()
            open_projects()
            page.screenshot(path=str(out / f'projects-{width}.png'), animations='disabled')
            assert page.locator('.sidebar-projects').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            expect(page.get_by_role('button', name='エージェント', exact=True)).to_have_count(0)
            page.goto('http://agent-owned.test/settings#workspaces')
            expect(page).to_have_url('http://agent-owned.test/settings#workspaces')
            expect(page.locator('#workspaces')).to_be_focused()
            workspace = page.locator('#workspaces')
            workspace.get_by_role('button', name='ワークスペースを作成', exact=True).click()
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
            workspace.get_by_role('button', name='作成', exact=True).click()
            expect(workspace.locator('.catalog-row')).to_have_count(2)
            open_projects()
            page.goto('http://agent-owned.test/settings#agents')
            expect(page).to_have_url('http://agent-owned.test/settings#agents')
            section = page.locator('#agents')
            expect(section).to_be_focused()
            page.screenshot(path=str(out / f'settings-{width}.png'), animations='disabled')
            section.get_by_role('button', name='エージェントを作成', exact=True).click()
            expect(section.locator('.catalog-filter')).to_have_count(0)
            section.get_by_label('名前', exact=True).fill('Avatar:検証担当')
            section.get_by_label('基本指示', exact=True).fill('変更前に確認する')
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
            expect(section.locator('.catalog-row')).to_have_count(1)
            assert saved[-1]['workspaceId'] == 'child' and saved[-1]['localLlmMode'] == 'chat'
            assert saved[-1]['localLlmReasoningEffort'] == 'low' and saved[-1]['effort'] == 'high'
            page.reload()
            section.get_by_role('button', name='Avatar:検証担当を編集').click()
            expect(section.get_by_label('基本指示')).to_have_value('変更前に確認する')
            expect(section.get_by_label('ワークスペース', exact=True)).to_have_value('child')
            expect(section.get_by_label('動作モード')).to_have_value('chat')
            section.get_by_label('動作モード').select_option('agent')
            section.get_by_role('button', name='保存', exact=True).click()
            expect(section.locator('.project-form')).to_have_count(0)
            assert saved[-1]['localLlmMode'] == 'agent'
            section.get_by_role('button', name='Avatar:検証担当を編集').click()
            section.get_by_label('バックエンド').select_option('codex')
            expect(section.get_by_label('動作モード')).to_have_count(0)
            section.get_by_role('button', name='保存', exact=True).click()
            expect(section.locator('.project-form')).to_have_count(0)
            assert saved[-1]['localLlmMode'] is None and saved[-1]['localLlmReasoningEffort'] is None
            section.get_by_role('button', name='Avatar:検証担当を削除').click()
            page.get_by_role('dialog').get_by_role('button', name='削除', exact=True).click()
            expect(section.get_by_role('alert')).to_contain_text('未完了の会話で使用中')
            expect(page.get_by_role('dialog')).to_be_visible()
            expect(section.locator('.catalog-row')).to_have_count(1)
            reject_delete[0] = False
            page.get_by_role('dialog').get_by_role('button', name='削除', exact=True).click()
            expect(section.locator('.catalog-row')).to_have_count(0)
            expect(section.get_by_role('alert')).to_have_count(0)
            open_projects()
            page.get_by_role('button', name='新規プロジェクト', exact=True).click()
            form = page.locator('.project-form')
            expect(form.get_by_label('ワークスペース', exact=True)).to_have_count(0)
            form.get_by_label('名前', exact=True).fill('検証プロジェクト')
            form.get_by_label('共通指示', exact=True).fill('共通の指示')
            form.get_by_role('button', name='作成', exact=True).click()
            expect(form).to_have_count(0)
            assert projects[-1]['prompt'] == '共通の指示'
            for section_id, label in [('workspaces', 'ワークスペース'), ('agents', 'エージェント'), ('teams', 'チーム')]:
                page.goto(f'http://agent-owned.test/settings#{section_id}')
                section = page.locator(f'#{section_id}')
                button = section.get_by_role('button', name=f'{label}をAIと相談して作成')
                expect(button).to_be_enabled()
                button.scroll_into_view_if_needed()
                manual = section.get_by_role('button', name=f'{label}を作成', exact=True)
                assert abs(manual.bounding_box()['y'] - button.bounding_box()['y']) <= 1, (section_id, width, 'buttons wrapped')
                page.screenshot(path=str(out / f'consult-{section_id}-{width}.png'))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                missing_cli[0] = True
                existing_sessions = len(sessions)
                button.click()
                expect(section.get_by_role('alert')).to_contain_text('実行用CLIを取得できません')
                assert len(sessions) == existing_sessions
                missing_cli[0] = False
                reject_session[0] = True
                button.click()
                expect(section.get_by_role('alert')).to_contain_text('テスト用の作成失敗')
                expect(button).to_be_enabled()
                reject_session[0] = False
                before = len(chats)
                with page.expect_request('**/api/chat'):
                    button.click()
                expect(page).to_have_url(f'http://agent-owned.test/chat/consult-{len(sessions)-1}')
                assert len(chats) == before + 1
                assert f'{label}を作りたい' in chats[-1]['message']
                assert 'まず用途や希望を聞いて' in chats[-1]['message']
                for required in ['xangi workspace list', 'xangi agent list', 'xangi team list', 'xangi workspace create', 'xangi agent create', 'xangi team create', 'AGENTS.override.md', 'シンボリックリンク', '子のAGENTS.md']:
                    assert required.replace('xangi ', "'/srv/test instance/bin/xangi' ") in chats[-1]['message'], required
                page.reload()
                expect(page.locator('textarea')).to_be_visible()
                assert len(chats) == before + 1
                page.go_back()
                expect(page).to_have_url(f'http://agent-owned.test/settings#{section_id}')
            assert not errors, errors
            results.append({'width': width, 'pass': True, 'saves': saved, 'errors': errors})
            print('PASS', width, flush=True)
            context.close()
    finally:
        browser.close()
(out / 'browser.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
