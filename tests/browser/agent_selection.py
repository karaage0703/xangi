"""担当一覧・新会話・チャンネル設定を隔離したブラウザで確認する。"""
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='agent-selection-browser-'))
print(out, flush=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 768, 414, 375, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            agents = [{'id': 'a1', 'name': 'レビュー担当', 'role': 'コードレビュー', 'backend': 'codex', 'model': 'test-model', 'workspaceId': 'review'}]
            sessions, calls, errors = [], [], []
            selected = ['']; busy = [False]
            def snapshot():
                return {'agent': {'id': 'a1', 'name': 'レビュー担当', 'workspaceId': 'review'} if selected[0] else None,
                        'backend': {'value': 'inherit', 'effective': {'backend': 'codex'}}, 'llmMode': {'value': 'inherit', 'effective': 'agent'}, 'autoReply': {'value': 'inherit', 'effective': 'off'}}
            runtime = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}}, 'respondToBots': {'enabled': True, 'value': False}}
            def route(r):
                u=urlparse(r.request.url); path=u.path; method=r.request.method
                if path.endswith('/stream'):
                    r.fulfill(content_type='text/event-stream',body=': ready\n\n'); return
                if path == '/api/config': data={'uploadAccept':None,'uploadMaxBytes':64000000,'allowedBackends':['codex']}
                elif path == '/api/agents': data={'agents':agents}
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
                    selected[0]=body.get('value','') if body['action']=='set' else ''
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
            page.goto('http://agent-test.test/')
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            projects=page.get_by_role('button',name='Projects',exact=False)
            agents_button=page.get_by_role('button',name='Agents',exact=False)
            assert projects.evaluate('(e)=>e.parentElement===e.nextElementSibling.parentElement')
            agents_button.click()
            expect(page.get_by_role('heading',name='Agents',exact=True)).to_be_visible()
            page.screenshot(path=str(out/f'agents-{width}.png'), animations='disabled')
            page.get_by_role('button',name='レビュー担当',exact=False).click()
            expect(page.get_by_label('新規会話の担当')).to_have_value('a1')
            page.get_by_role('button',name='＋ 新規',exact=True).click()
            expect(page).to_have_url('http://agent-test.test/chat/new-session')
            assert calls[-1]['agentId']=='a1'
            print('settings', width, errors, flush=True)
            page.goto('http://agent-test.test/settings')
            page.screenshot(path=str(out/f'settings-{width}.png'))
            card=page.locator('section[aria-labelledby="settings-channel-title"]')
            card.get_by_label('プラットフォーム').select_option('slack')
            card.get_by_label('チャンネル',exact=True).select_option('C1')
            card.get_by_label('エージェント',exact=True).select_option('a1')
            busy[0]=True
            card.get_by_role('button',name='担当を保存',exact=True).click()
            expect(card.get_by_role('status')).to_contain_text('処理中')
            expect(card.get_by_label('バックエンド')).to_be_enabled()
            busy[0]=False
            card.get_by_role('button',name='担当を保存',exact=True).click()
            expect(card.get_by_label('バックエンド')).to_be_disabled()
            page.reload();card.get_by_label('プラットフォーム').select_option('slack');card.get_by_label('チャンネル',exact=True).select_option('C1')
            expect(card.get_by_label('エージェント',exact=True)).to_have_value('a1')
            expect(card.get_by_label('バックエンド')).to_be_disabled()
            card.screenshot(path=str(out/f'channel-agent-{width}.png'), animations='disabled')
            assert card.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            card.get_by_label('エージェント',exact=True).select_option('')
            card.get_by_role('button',name='担当を保存',exact=True).click()
            expect(card.get_by_label('バックエンド')).to_be_enabled()
            assert not errors,errors
            context.close()
    finally: browser.close()
print('PASS: Agents並列配置・担当選択・新会話・処理中拒否・保存/再読込・解除 (1280/768/414/375/320px)')
