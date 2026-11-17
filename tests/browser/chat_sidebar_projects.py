"""Exercise project navigation and editing against isolated API fixtures.
Run after npm run build with uv run --with playwright python this_file.py.
"""
import mimetypes
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(os.environ.get('WEB_BUILD', Path(__file__).resolve().parents[2] / 'web/app'))
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/chat-sidebar-projects'))
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 768, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 900})
            projects = [{'id': f'p{i}', 'name': name, 'prompt': ''} for i, name in enumerate([
                'ブログ執筆', 'アプリ開発', '読書メモ', '旅行の計画', '勉強会',
                '長い名前のプロジェクトでも操作ボタンが隠れないことを確認する',
            ])]
            sessions = [{'id': f's{i}', 'title': f'会話{i}', 'projectId': f'p{i}', 'platform': 'web',
                         'updatedAt': '2026-10-26T14:00:00Z', 'isActive': False, 'lifecycle': 'closed' if i == 5 else 'open'} for i in range(6)]
            errors, writes = [], []
            session_queries = []
            fail_save = [False]
            def route(r):
                u = urlparse(r.request.url); path = u.path; method = r.request.method
                if path.endswith('/stream'):
                    pid = parse_qs(u.query).get('projectId', [''])[0]
                    snapshot = {'sessions': [s for s in sessions if not pid or s['projectId'] == pid]}
                    r.fulfill(content_type='text/event-stream', body=f'event: sessions\ndata: {json.dumps(snapshot)}\n\n'); return
                if path == '/api/config': data = {'uploadAccept': None, 'uploadMaxBytes': 64000000, 'allowedBackends': ['codex']}
                elif path == '/api/agents': data = {'agents': []}
                elif path == '/api/teams': data = {'teams': []}
                elif path == '/api/projects' and method == 'POST':
                    projects.append(dict(r.request.post_data_json, id='new')); data = {'project': projects[-1]}
                elif path == '/api/projects': data = {'projects': projects}
                elif path.startswith('/api/projects/') and method == 'PATCH':
                    if fail_save[0]:
                        r.fulfill(status=400, json={'error': '保存を確認できません'}); return
                    project = next(p for p in projects if p['id'] == path.split('/')[-1])
                    project.update(r.request.post_data_json); writes.append(project.copy()); data = {'project': project}
                elif path == '/api/sessions' and method == 'POST':
                    body = r.request.post_data_json; writes.append(body)
                    session = dict(sessions[0], id='new-session', projectId=body.get('projectId'), title='新しい会話')
                    sessions.append(session); data = {'sessionId': session['id']}
                elif path == '/api/sessions':
                    query = parse_qs(u.query); pid = query.get('projectId', [''])[0]
                    q = query.get('q', [''])[0]
                    lifecycle = query.get('lifecycle', [''])[0]; session_queries.append(query)
                    matching = [s for s in sessions if (not pid or s['projectId'] == pid) and (not q or q in s['title']) and (not lifecycle or s['lifecycle'] == lifecycle)]
                    offset = int(query.get('offset', ['0'])[0]); limit = int(query.get('limit', ['100'])[0])
                    data = {'sessions': matching[offset:offset+limit], 'meta': {'hasMore': offset+limit < len(matching), 'nextOffset': offset+limit}}
                elif method == 'POST' and (path.endswith('/close') or path.endswith('/reopen')):
                    session = next(s for s in sessions if s['id'] == path.split('/')[3])
                    session['lifecycle'] = 'closed' if path.endswith('/close') else 'open'
                    data = {'ok': True}
                elif path.endswith('/turn-history'): data = {'history': []}
                elif path.startswith('/api/sessions/'):
                    data = {**next((s for s in sessions if s['id'] == path.split('/')[3]), {}), 'messages': [], 'total': 0, 'hasMore': False}
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path == '/' or path.startswith('/chat/') or path == '/settings' else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404, body=file.read_bytes() if file.exists() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            context.add_init_script("localStorage.setItem('xangi_session_filter_v1', 'closed')")
            page = context.new_page(); page.set_default_timeout(8000)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto('http://sidebar.test/')
            def open_sidebar():
                if width <= 768 and 'open' not in page.locator('.sidebar').get_attribute('class').split():
                    page.get_by_role('button', name='サイドバーを開く', exact=True).click()
            open_sidebar()
            expect(page.locator('.session-row')).to_have_count(6)
            expect(page.locator('.session-list')).to_contain_text('会話5')
            expect(page.get_by_role('combobox', name='会話の状態')).to_have_value('all')
            assert session_queries and all('lifecycle' not in query for query in session_queries)
            state_filter = page.get_by_role('combobox', name='会話の状態')
            state_filter.select_option('open')
            expect(page.locator('.session-row')).to_have_count(5)
            state_filter.select_option('closed')
            expect(page.locator('.session-row')).to_have_count(1)
            expect(page.locator('.session-list')).to_contain_text('会話5')
            page.get_by_placeholder('会話を検索').fill('該当なし')
            expect(page.locator('.session-row')).to_have_count(0)
            page.get_by_placeholder('会話を検索').fill('')
            expect(page.locator('.session-row')).to_have_count(1)
            page.locator('.sidebar-project-select').first.click()
            expect(page.locator('.session-row')).to_have_count(0)
            page.get_by_role('button', name='すべての会話', exact=True).click()
            expect(state_filter).to_have_value('closed')
            expect(page.locator('.session-row')).to_have_count(1)
            state_filter.focus()
            page.keyboard.press('ArrowUp')
            page.keyboard.press('Enter')
            expect(state_filter).to_have_value('open')
            expect(page.locator('.session-row')).to_have_count(5)
            page.screenshot(path=str(out/f'lifecycle-{width}.png'), full_page=True, animations='disabled')
            state_filter.select_option('all')
            expect(page.locator('.session-row')).to_have_count(6)
            search = page.get_by_placeholder('会話を検索')
            search.fill('会話5')
            expect(page.locator('.session-row')).to_have_count(1)
            expect(page.locator('.session-list')).to_contain_text('会話5')
            search.fill('')
            expect(page.locator('.session-row')).to_have_count(6)
            expect(page.locator('.sidebar-project-select')).to_have_count(5)
            toggle = page.get_by_role('button', name='プロジェクト', exact=True)
            expect(toggle).to_have_attribute('aria-expanded', 'true')
            toggle.focus(); page.keyboard.press('Enter')
            expect(toggle).to_have_attribute('aria-expanded', 'false')
            expect(page.locator('.sidebar-project-select:visible')).to_have_count(0)
            expect(page.get_by_role('button', name='すべて表示（6）')).not_to_be_visible()
            expect(page.get_by_role('button', name='新規プロジェクト', exact=True)).to_be_visible()
            page.screenshot(path=str(out/f'collapsed-{width}.png'), full_page=True, animations='disabled')
            page.reload(); open_sidebar()
            expect(page.locator('.session-row')).to_have_count(6)
            expect(page.locator('.session-list')).to_contain_text('会話5')
            expect(toggle).to_have_attribute('aria-expanded', 'false')
            expect(page.locator('.sidebar-project-select:visible')).to_have_count(0)
            toggle.focus(); page.keyboard.press('Space')
            expect(page.locator('.sidebar-project-select:visible')).to_have_count(5)
            page.reload(); open_sidebar()
            expect(toggle).to_have_attribute('aria-expanded', 'true')
            expect(page.locator('.sidebar-footer')).to_be_in_viewport()
            page.screenshot(path=str(out/f'sidebar-{width}.png'), full_page=True, animations='disabled')
            page.locator('.sidebar').get_by_role('button', name='ブログ執筆', exact=True).click()
            expect(page.locator('.session-row')).to_have_count(1)
            expect(page.locator('.session-main')).to_contain_text('会話0')
            page.locator('.session-main').click()
            expect(page).to_have_url('http://sidebar.test/chat/s0')
            if width <= 768: expect(page.locator('.sidebar')).not_to_be_in_viewport()
            open_sidebar()
            trigger = page.get_by_role('button', name='ブログ執筆の設定', exact=True)
            trigger.focus(); page.keyboard.press('Enter')
            form = page.locator('.project-form')
            expect(form).to_be_visible()
            expect(form.get_by_label('名前', exact=True)).to_have_value('ブログ執筆')
            expect(page.locator('.sidebar-project-options')).to_have_count(0)
            form.get_by_role('button', name='キャンセル', exact=True).click(); open_sidebar()
            toggle.click()
            expect(page.locator('.session-row')).to_have_count(1)
            expect(page).to_have_url('http://sidebar.test/chat/s0')
            expect(page.locator('.sidebar-project-select:visible')).to_have_count(0)
            page.reload(); open_sidebar()
            expect(toggle).to_have_attribute('aria-expanded', 'false')
            expect(page.locator('.session-row')).to_have_count(1)
            toggle.click()
            expect(page.locator('.sidebar-project-select[aria-pressed="true"]')).to_contain_text('ブログ執筆')
            trigger.click()
            form = page.locator('.project-form')
            expect(form).to_be_visible()
            form.get_by_label('名前', exact=True).fill('ブログの企画')
            form.get_by_label('共通指示').fill('読みやすい文章にする')
            fail_save[0] = True
            form.get_by_role('button', name='更新', exact=True).click()
            expect(page.get_by_role('status').filter(has_text='保存を確認できません')).to_be_visible()
            expect(form.get_by_label('名前', exact=True)).to_have_value('ブログの企画')
            fail_save[0] = False
            form.get_by_role('button', name='更新', exact=True).click()
            expect(form).not_to_be_visible(); open_sidebar()
            expect(page.locator('.sidebar').get_by_role('button', name='ブログの企画', exact=True)).to_be_visible()
            assert writes[-1]['prompt'] == '読みやすい文章にする'
            page.reload(); open_sidebar()
            expect(page.locator('.sidebar').get_by_role('button', name='ブログの企画', exact=True)).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('button', name='すべての会話', exact=True).click()
            expect(page.locator('.session-row')).to_have_count(6)
            page.get_by_role('button', name='すべて表示（6）', exact=True).click()
            expect(page.locator('.sidebar-project-select')).to_have_count(6)
            page.locator('.sidebar-project-select').last.click()
            expect(page.locator('.session-row')).to_have_count(1)
            page.get_by_role('button', name='表示を減らす', exact=True).click()
            expect(page.locator('.sidebar-project-select[aria-pressed="true"]')).to_contain_text('長い名前')
            assert page.locator('.sidebar-scroll').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            expect(page.locator('.sidebar-footer')).to_be_in_viewport()
            page.locator('.sidebar').get_by_role('button', name='＋ 新しい会話', exact=True).click()
            expect(page).to_have_url('http://sidebar.test/chat/new-session')
            assert writes[-1]['projectId'] == 'p5'
            open_sidebar()
            page.get_by_role('button', name='新規プロジェクト', exact=True).click()
            expect(form).to_be_visible()
            form.get_by_label('名前', exact=True).fill('検証プロジェクト')
            form.get_by_role('button', name='作成', exact=True).click()
            expect(form).not_to_be_visible(); open_sidebar()
            expect(page.locator('.sidebar').get_by_role('button', name='検証プロジェクト', exact=True)).to_be_visible()
            page.get_by_role('button', name='検証プロジェクトの設定').click()
            expect(form.get_by_label('名前', exact=True)).to_have_value('検証プロジェクト')
            page.screenshot(path=str(out/f'project-settings-{width}.png'), full_page=True, animations='disabled')
            form.get_by_role('button', name='キャンセル', exact=True).click(); open_sidebar()
            expect(page.locator('.sidebar-footer')).to_be_in_viewport()
            page.get_by_role('link', name='全体設定', exact=True).click()
            expect(page).to_have_url('http://sidebar.test/settings')
            assert not errors, errors
            context.close()
            print(f'PASS {width}: select/open/edit/error/retry/reload/new/cancel/settings/keyboard/overflow', flush=True)
        # Empty and large catalogs retain access to creation and settings.
        # Reuse the fixture with a fresh page and no restored storage.
        for count in [0, 100]:
            context = browser.new_context(viewport={'width': 375, 'height': 667})
            projects[:] = [{'id': f'p{i}', 'name': f'プロジェクト{i}', 'prompt': ''} for i in range(count)]
            context.route('**/*', route); page = context.new_page(); page.set_default_timeout(8000)
            page.goto('http://sidebar.test/'); page.get_by_role('button', name='サイドバーを開く').click()
            expect(page.locator('.sidebar-footer')).to_be_in_viewport()
            if count:
                page.get_by_role('button', name='すべて表示（100）').click()
                page.get_by_role('button', name='プロジェクト99', exact=True).click()
                expect(page.locator('.sidebar-footer')).to_be_in_viewport()
            else: expect(page.get_by_text('プロジェクトはまだありません', exact=True)).to_be_visible()
            toggle = page.get_by_role('button', name='プロジェクト', exact=True)
            toggle.click()
            expect(page.locator('.sidebar-project-select:visible')).to_have_count(0)
            expect(page.locator('.sidebar-project-empty')).not_to_be_visible()
            expect(page.get_by_role('button', name='表示を減らす')).not_to_be_visible()
            page.get_by_role('button', name='新規プロジェクト', exact=True).click()
            expect(page.locator('.project-form')).to_be_visible()
            context.close(); print(f'PASS catalog count={count}', flush=True)
        # An unfiltered SSE snapshot must refresh the filtered API, rather than
        # reintroducing completed rows or hiding older matching conversations.
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        context.route('**/*', route)
        context.add_init_script("""
          window.testStreams = [];
          window.EventSource = class extends EventTarget {
            constructor() { super(); window.testStreams.push(this); }
            close() { window.testStreams = window.testStreams.filter(s => s !== this); }
          };
        """)
        sessions[:] = [dict(id=f'page{i}', title=f'検証{i}', projectId='', platform='web',
                           updatedAt='2026-11-17T00:00:00Z', isActive=False,
                           lifecycle='open' if i < 105 else 'closed') for i in range(110)]
        page = context.new_page(); page.set_default_timeout(8000)
        page.goto('http://sidebar.test/')
        state_filter = page.get_by_role('combobox', name='会話の状態')
        expect(state_filter).to_have_value('all')
        state_filter.select_option('open')
        expect(page.locator('.session-row')).to_have_count(100)
        page.get_by_role('button', name='さらに読み込む').click()
        expect(page.locator('.session-row')).to_have_count(105)
        expect(page.get_by_role('button', name='さらに読み込む')).to_have_count(0)
        sessions[0]['lifecycle'] = 'closed'
        def snapshot():
            page.evaluate("""() => window.testStreams.forEach(s => s.dispatchEvent(
              new MessageEvent('sessions', {data: JSON.stringify({sessions: []})})))""")
        snapshot()
        expect(page.locator('.session-row')).to_have_count(100)
        expect(page.locator('.session-main').filter(has_text='検証0')).to_have_count(0)
        state_filter.select_option('closed')
        expect(page.locator('.session-row')).to_have_count(6)
        sessions[0]['lifecycle'] = 'open'
        snapshot()
        expect(page.locator('.session-row')).to_have_count(5)
        page.get_by_placeholder('会話を検索').fill('検証0')
        expect(page.locator('.session-row')).to_have_count(0)
        sessions[0]['lifecycle'] = 'closed'
        snapshot()
        expect(page.locator('.session-row')).to_have_count(1)
        # Existing source visibility remains independent from lifecycle.
        page.get_by_label('会話の表示設定').click()
        page.get_by_label('Web', exact=True).uncheck()
        expect(page.locator('.session-row')).to_have_count(0)
        page.get_by_label('Web', exact=True).check()
        expect(page.locator('.session-row')).to_have_count(1)
        page.get_by_label('会話の表示設定').click()
        page.get_by_placeholder('会話を検索').fill('')
        state_filter.select_option('open')
        expect(page.locator('.session-row')).to_have_count(100)
        target_row = page.locator('.session-row').filter(has=page.get_by_text('検証1', exact=True))
        target_row.hover()
        target_row.get_by_role('button', name='完了にする', exact=True).click()
        expect(target_row).to_have_count(0)
        expect(page.get_by_role('button', name='元に戻す', exact=True)).to_be_visible()
        assert sessions[1]['lifecycle'] == 'closed'
        page.get_by_role('button', name='元に戻す', exact=True).click()
        expect(target_row).to_be_visible()
        assert sessions[1]['lifecycle'] == 'open'
        page.reload()
        expect(page.get_by_role('combobox', name='会話の状態')).to_have_value('all')
        context.close()
        print('PASS lifecycle: pagination/SSE close/reopen/search/source/reset', flush=True)
    finally:
        browser.close()
