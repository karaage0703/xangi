"""Team作成・担当編集・Agentチャンネル設定を隔離したブラウザで確認する。"""
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='team-settings-browser-'))
print(out, flush=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 768, 414, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            agents = [{'id': 'a1', 'name': 'レビュー担当', 'prompt': 'コードレビュー\n根拠を示す', 'backend': 'codex', 'model': 'test-model', 'workspaceId': 'review'}]
            agents += [{'id':'a2','name':'サブリーダー','role':'進行管理'},{'id':'a3','name':'実装担当','role':'実装'}]
            teams = []
            sessions, calls, errors = [], [], []
            selected = ['']; selected_team = ['']; busy = [False]
            def snapshot():
                return {'team': {'id':'p1','name':teams[0]['name'],'leadership':teams[0]['leadership']} if selected_team[0] else None, 'agent': {'id': 'a1', 'name': 'レビュー担当', 'workspaceId': 'review'} if selected[0]=='a1' else None,
                        'backend': {'value': 'inherit', 'effective': {'backend': 'codex'}}, 'llmMode': {'value': 'inherit', 'effective': 'agent'}, 'autoReply': {'value': 'inherit', 'effective': 'off'}}
            runtime = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}}, 'respondToBots': {'enabled': True, 'value': False}}
            def route(r):
                u=urlparse(r.request.url); path=u.path; method=r.request.method
                if path.endswith('/stream'):
                    r.fulfill(content_type='text/event-stream',body=': ready\n\n'); return
                if path == '/api/config': data={'uploadAccept':None,'uploadMaxBytes':64000000,'allowedBackends':['codex']}
                elif path == '/api/agents': data={'agents':agents}
                elif path == '/api/agents/a1/channel' and method == 'PUT':
                    body=r.request.post_data_json
                    if busy[0]: r.fulfill(status=400,json={'error':'処理中の会話があります'}); return
                    agents[0]['workChannel'] = None if body['action']=='reset' else {'platform':body['platform'],'channelId':body['channelId']}
                    data={'workChannel':agents[0]['workChannel']}
                elif path == '/api/agents/a1' and method == 'PATCH':
                    body=r.request.post_data_json
                    assert 'role' not in body
                    agents[0]={**agents[0],**body};data={'agent':agents[0]}
                elif path == '/api/teams' and method == 'GET': data={'teams':teams,'agents':[{'id':'xangi:default','name':'デフォルト（普段のxangi）','role':'メンバー'},*agents]}
                elif path == '/api/teams' and method == 'POST':
                    p={**r.request.post_data_json,'id':'p1'};teams.append(p);data={'team':p}
                elif path == '/api/teams/p1' and method == 'PATCH':
                    teams[0]={**teams[0],**r.request.post_data_json};data={'team':teams[0]}
                elif path == '/api/teams/p1' and method == 'DELETE':
                    if selected_team[0]: r.fulfill(status=409,json={'error':'使用中のTeamです'});return
                    teams.clear();data={'ok':True}
                elif path == '/api/models': data={'status':'available','models':[{'id':'test-model'}],'supportedEfforts':[]}
                elif path == '/api/projects': data={'projects':[]}
                elif path == '/api/sessions' and method == 'POST':
                    body=r.request.post_data_json; calls.append(body)
                    session={'id':'new-session','title':'担当との新しい会話','selectedAgentId':body.get('agentId'),'platform':'web','contextKey':'web-chat:new-session','updatedAt':'2026-01-01T00:00:00Z','isActive':True,'lifecycle':'open'}
                    sessions.append(session); data={'sessionId':session['id']}
                elif path == '/api/sessions':
                    agent_id=parse_qs(u.query).get('agentId',[None])[0]
                    data={'sessions':[s for s in sessions if not agent_id or s.get('selectedAgentId')==agent_id]}
                elif path.endswith('/turn-history'): data={'history':[]}
                elif path.startswith('/api/sessions/'):
                    data={'messages':[],'session':sessions[-1] if sessions else None,'total':0,'hasMore':False}
                elif path == '/api/runtime-settings' and method == 'POST':
                    body=r.request.post_data_json
                    if busy[0]: r.fulfill(status=400,json={'error':'処理中の会話があります。完了してから担当を変更してください'}); return
                    target = selected_team if body['name']=='team' else selected
                    target[0]=body.get('value','') if body['action']=='set' else ''
                    data={'message':'saved','settings':runtime}
                elif path == '/api/runtime-settings': data=runtime
                elif path == '/api/runtime-settings/channel': data=snapshot()
                elif path == '/api/runtime-settings/channels': data={'status':'available','channels':[{'id':'C1','name':'#test'}]}
                elif path == '/api/startup-settings': data={'groups':[]}
                elif path == '/api/connection-settings': data={'groups':[],'backends':[]}
                elif path == '/api/workspaces': data={'workspaces':[]}
                elif path.startswith('/api/'): data={}
                else:
                    file=root/('index.html' if path in ['/', '/settings'] or path.startswith('/chat/') else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404,body=file.read_bytes() if file.exists() else b'',content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream');return
                r.fulfill(json=data)
            context.route('**/*',route)
            page=context.new_page();page.set_default_timeout(10000);page.on('pageerror',lambda e: errors.append(str(e)))
            page.goto('http://agent-test.test/settings')
            links=page.locator('.settings-section-links a')
            expect(links).to_have_text(['ワークスペース', 'エージェント', 'チーム'])
            rects=links.evaluate_all('(links) => links.map(a => ({y:a.getBoundingClientRect().y, height:a.getBoundingClientRect().height}))')
            assert len(set(round(r['height'], 1) for r in rects)) == 1, rects
            if width >= 768: assert max(r['y'] for r in rects)-min(r['y'] for r in rects) < 1, rects
            page.screenshot(path=str(out/f'nav-{width}.png'))
            links.nth(1).click()
            agent_panel=page.locator('#agents')
            agent_panel.get_by_role('button',name='レビュー担当を編集',exact=True).click()
            agent_panel.get_by_label('設定先チャンネル',exact=True).select_option('discord:C1')
            agent_panel.get_by_role('button',name='チャンネルを設定',exact=True).click()
            expect(agent_panel.get_by_text('現在の設定先: Discord / #test',exact=True)).to_be_visible()
            busy[0]=True
            agent_panel.get_by_role('button',name='チャンネルの紐づきを解除',exact=True).click()
            expect(agent_panel.get_by_text('処理中の会話があります',exact=True)).to_be_visible()
            expect(agent_panel.get_by_text('現在の設定先: Discord / #test',exact=True)).to_be_visible()
            busy[0]=False
            agent_panel.get_by_role('button',name='チャンネルの紐づきを解除',exact=True).click()
            expect(agent_panel.get_by_label('設定先チャンネル',exact=True)).to_be_visible()
            agent_panel.get_by_label('設定先チャンネル',exact=True).select_option('slack:C1')
            agent_panel.get_by_role('button',name='チャンネルを設定',exact=True).click()
            expect(agent_panel.get_by_text('現在の設定先: Slack / #test',exact=True)).to_be_visible()
            expect(agent_panel.get_by_label('基本指示')).to_be_visible()
            expect(agent_panel.get_by_label('得意なことを一言')).to_have_count(0)
            expect(agent_panel.get_by_label('基本指示')).to_have_value('コードレビュー\n根拠を示す')
            agent_panel.get_by_label('基本指示').fill('根拠を示してレビューする')
            agent_panel.get_by_role('button',name='更新',exact=True).click()
            agent_panel.get_by_role('button',name='レビュー担当を編集',exact=True).click()
            expect(agent_panel.get_by_label('基本指示')).to_have_value('根拠を示してレビューする')
            agent_panel.screenshot(path=str(out/f'agent-editor-{width}.png'),animations='disabled')
            links.last.click()
            panel=page.locator('#teams')
            expect(panel.get_by_text('チームはまだありません。',exact=False)).to_be_visible()
            panel.get_by_role('button',name='チームを作成',exact=True).click()
            panel.get_by_label('チーム名（必須）').fill('開発チーム')
            expect(panel.get_by_label('同時実行数',exact=True)).to_have_value('16')
            expect(panel.get_by_label('同じ作業場所では順番に実行する')).not_to_be_checked()
            panel.get_by_label('同時実行数',exact=True).fill('4')
            panel.get_by_label('同じ作業場所では順番に実行する').check()
            panel.get_by_label('共通指示').fill('変更と検証結果を報告する')
            for agent_id in ['xangi:default','a2','a3']: panel.get_by_label('メンバーを追加').select_option(agent_id)
            expect(panel.get_by_label('リーダー方式')).to_have_count(0)
            rows=panel.locator('.team-member')
            rows.nth(0).get_by_label('チーム内の担当（任意）').fill('レビュー')
            expect(panel.get_by_label('報告先')).to_have_count(0)
            expect(rows.nth(1).get_by_label('チーム内の担当（任意）')).to_have_value('')
            assert panel.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            panel.screenshot(path=str(out/f'team-editor-{width}.png'),animations='disabled')
            panel.get_by_role('button',name='チームを保存',exact=True).click()
            expect(panel.get_by_role('status')).to_contain_text('チームを保存')
            assert teams[0]['maxConcurrency']==4 and teams[0]['serializeWorkspaces'] is True
            assert teams[0]['members'][2]['role']==''
            assert teams[0]['members'][0]['agentId']=='xangi:default'
            page.reload()
            panel.get_by_role('button',name='開発チームを編集').click()
            expect(panel.get_by_label('同時実行数',exact=True)).to_have_value('4')
            expect(panel.get_by_label('同じ作業場所では順番に実行する')).to_be_checked()
            expect(panel.get_by_label('チーム名（必須）')).to_have_value('開発チーム')
            expect(panel.locator('.team-member').nth(2).get_by_label('チーム内の担当（任意）')).to_have_value('')
            expect(panel.get_by_label('報告先')).to_have_count(0)
            panel.get_by_role('button',name='チームを保存',exact=True).click()
            expect(panel.get_by_role('status')).to_contain_text('チームを保存')
            assert teams[0]['leadership']=='caller' and not any(m.get('reportsTo') for m in teams[0]['members'])
            card=page.locator('section[aria-labelledby="settings-channel-title"]')
            card.get_by_label('プラットフォーム').select_option('slack')
            card.get_by_label('チャンネル',exact=True).select_option('C1')
            expect(card.get_by_label('利用するチーム')).to_have_count(0)
            card.get_by_label('エージェント',exact=True).select_option('a1')
            busy[0]=True
            card.get_by_role('button',name='担当を保存',exact=True).click()
            expect(card.get_by_role('status')).to_contain_text('処理中')
            busy[0]=False
            card.get_by_role('button',name='担当を保存',exact=True).click()
            expect(card.get_by_label('バックエンド')).to_be_disabled()
            expect(card.get_by_role('status')).to_contain_text('担当を保存')
            page.reload()
            card.get_by_label('プラットフォーム').select_option('slack')
            card.get_by_label('チャンネル',exact=True).select_option('C1')
            expect(card.get_by_label('エージェント',exact=True)).to_have_value('a1')
            expect(card.get_by_label('利用するチーム')).to_have_count(0)
            card.screenshot(path=str(out/f'agent-channel-{width}.png'),animations='disabled')
            assert card.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            card.get_by_label('エージェント',exact=True).select_option('')
            card.get_by_role('button',name='担当を保存',exact=True).click()
            expect(card.get_by_label('バックエンド')).to_be_enabled()
            panel.get_by_role('button',name='開発チームを編集').click()
            expect(panel.get_by_label('リーダー方式')).to_have_count(0)
            panel.get_by_role('button',name='チームを保存',exact=True).click()
            expect(panel.get_by_text('呼び出し元がリーダー',exact=False)).to_be_visible()
            panel.get_by_role('button',name='開発チームを削除').click()
            page.get_by_role('dialog').get_by_role('button',name='削除',exact=True).click()
            expect(panel.get_by_text('チームはまだありません。',exact=False)).to_be_visible()
            assert not errors,errors
            context.close()
    finally: browser.close()
print('PASS: Team作成・任意担当・編集/再読込・割当/解除・並列・削除・処理中拒否 (1280/768/414/375/320px)')
