"""ProjectのWeb会話とDiscord・Slackスレッドの選択を隔離ブラウザで確認する。"""
import mimetypes
from datetime import datetime, timezone
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/project-channel-browser'))
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'), headless=True, args=['--no-sandbox'])
    try:
        for platform, width in [('discord', 1280), ('discord', 375), ('slack', 1280), ('slack', 375)]:
            platform_label = {'discord': 'Discord', 'slack': 'Slack'}[platform]
            channel_id = {'discord': '123456789012345678', 'slack': 'C123'}[platform]
            agent_id = 'a1'
            work_channel = {'platform': platform, 'channelId': channel_id}
            placeholder = f'{platform_label}へ送るメッセージを入力'
            artifact = f'{platform}-{width}'
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            projects, sessions, posts, errors, pending = [], [], [], [], []
            assigned_channel = [work_channel]
            def route(r):
                u=urlparse(r.request.url); path=u.path; method=r.request.method
                if path.endswith('/stream'):
                    r.fulfill(content_type='text/event-stream',body=': ready\n\n'); return
                if path == '/api/config': data={'uploadAccept':None,'uploadMaxBytes':64000000,'allowedBackends':['codex']}
                elif path.startswith('/api/user-input/'): data={'questions':[]}
                elif path == '/api/agents': data={'agents':[{'id':'a1','name':'実装担当','prompt':'','workChannel':assigned_channel[0]}]}
                elif path == '/api/teams': data={'teams':[{'id':'t1','name':'開発チーム'}]}
                elif path == '/api/projects' and method == 'POST':
                    body = r.request.post_data_json
                    assert 'channel' not in body
                    projects.append(dict(body,id='p1'))
                    data={'project':projects[-1]}
                elif path == '/api/projects': data={'projects':projects}
                elif path == '/api/runtime-settings/channels': data={'channels':[{'id':channel_id,'name':'#開発'}]}
                elif path == '/api/sessions' and method == 'POST':
                    body=r.request.post_data_json; posts.append(body)
                    session={'id':'linked-session','title':'開発Project','projectId':'p1','platform':platform,'contextKey':channel_id + ':123.4','updatedAt':'2026-10-23T00:00:00Z','isActive':False,'lifecycle':'open','linkedChannel':True}
                    if body.get('mode') != 'linked':
                        session.update(id='web-session',title='Web会話',platform='web',linkedChannel=False)
                    if body.get('secret'): session.update(id='secret_test',title='シークレット',platform='web',linkedChannel=False)
                    sessions.append(session); data={'sessionId':session['id']}
                elif path == '/api/sessions': data={'sessions':sessions}
                elif path.endswith('/turns'):
                    posts.append(r.request.post_data_json); pending.append(r); return
                elif path.endswith('/close'):
                    posts.append({'closed':path.split('/')[3]}); sessions[:]=[s for s in sessions if s['id']!=path.split('/')[3]]; data={'ok':True}
                elif path.endswith('/turn-history'): data={'history':[]}
                elif path.endswith('/external-chat-link'):
                    if path.split('/')[3] != 'linked-session':
                        r.fulfill(status=404, json={'error':'No external chat'})
                        return
                    data={'platform':platform,'url':'https://example.test/thread'}
                elif path.startswith('/api/sessions/'):
                    data={**next((s for s in sessions if s['id']==path.split('/')[3]), {}),'messages':next((s.get('messages',[]) for s in sessions if s['id']==path.split('/')[3]), []),'total':0,'hasMore':False}
                elif path.startswith('/api/'): data={}
                else:
                    file=root/('index.html' if path=='/' or path.startswith('/chat/') else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404,body=file.read_bytes() if file.exists() else b'',content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream');return
                r.fulfill(json=data)
            context.route('**/*',route)
            page=context.new_page();page.set_default_timeout(10000);page.on('pageerror',lambda e: errors.append(e.stack or str(e)))
            page.goto('http://project-test.test/')
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            expect(page.locator('.sidebar-projects')).to_have_count(1)
            page.get_by_role('button',name='新規プロジェクト',exact=True).click()
            form=page.locator('.project-form')
            form.get_by_label('名前',exact=True).fill('開発Project')
            form.get_by_label('共通指示').fill('変更を検証してください')
            form.get_by_label('新しい会話の担当').select_option(agent_id)
            expect(form.get_by_role('combobox',name='接続先',exact=True)).to_have_count(0)
            expect(form.get_by_text(f'{platform_label} / {channel_id}', exact=False)).to_be_visible()
            page.screenshot(path=str(out/f'project-{artifact}.png'),full_page=True)
            assert form.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            form.get_by_role('button',name='作成',exact=True).click()
            expect(form).not_to_be_visible()
            assert projects[0]['defaultAgentId']==agent_id
            assigned_channel[0] = None
            page.reload()
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            page.locator('.sidebar').get_by_role('button',name='＋ 新しい会話',exact=True).click()
            expect(page).to_have_url('http://project-test.test/chat/web-session')
            assert 'mode' not in posts.pop()
            assigned_channel[0] = work_channel
            page.reload()
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            page.locator('.sidebar').get_by_role('button',name='＋ 新しい会話',exact=True).click()
            assert not posts, 'Opening a draft must not create a remote thread'
            destination = page.get_by_role('status').filter(has_text='投稿先')
            expect(destination).to_have_text(f'投稿先：{platform_label} / #開発')
            if width <= 768: expect(page.locator('.sidebar')).not_to_be_in_viewport()
            assert destination.bounding_box()['y'] < page.get_by_placeholder(placeholder).bounding_box()['y']
            page.screenshot(path=str(out/f'destination-{artifact}.png'),full_page=True)
            page.get_by_placeholder(placeholder).fill('続けてください')
            page.get_by_role('button',name='送信',exact=True).click()
            expect(page.get_by_label('送信したメッセージ')).to_contain_text('続けてください')
            for _ in range(100):
                if pending: break
                page.wait_for_timeout(20)
            assert pending, 'Input must appear while the response is still pending'
            sessions[-1]['messages']=[{'id':'server-user-1','role':'user','content':'続けてください','createdAt':datetime.now(timezone.utc).isoformat()}]
            pending.pop().fulfill(json={'turn':{'id':'mock-turn','state':'completed','delivery':'delivered'}})
            try:
                expect(page.get_by_placeholder(placeholder)).to_have_value('')
            except AssertionError:
                page.screenshot(path=str(out/f'failure-{artifact}.png'),full_page=True)
                print(page.url, page.locator('body').inner_text(), 'errors:', errors, flush=True)
                raise
            expect(page).to_have_url('http://project-test.test/chat/linked-session')
            assert posts[0]['projectId']=='p1' and posts[0]['mode']=='linked'
            assert posts[0]['expectedChannel']==work_channel
            assert posts[0]['expectedAgentId']==agent_id
            assert posts[0]['message']==posts[-1]['message']=='続けてください'
            expect(page.get_by_role('button',name=f'この{platform_label}で続ける')).to_have_count(0)
            expect(page.get_by_role('button',name='Web会話として分岐')).to_have_count(0)
            expect(page.get_by_label('送信したメッセージ')).to_have_count(0)
            expect(page.locator('.message.user').filter(has_text='続けてください')).to_have_count(1)
            page.get_by_placeholder(placeholder).fill('再送する本文')
            page.get_by_role('button',name='送信',exact=True).click()
            expect(page.get_by_label('送信したメッセージ')).to_contain_text('再送する本文')
            assert pending
            pending.pop().fulfill(status=409,json={'error':'接続できません'})
            expect(page.get_by_placeholder(placeholder)).to_have_value('再送する本文')
            expect(page.get_by_label('送信したメッセージ')).to_have_count(0)
            page.screenshot(path=str(out/f'continuation-{artifact}.png'),full_page=True)
            sessions.append({'id':'child-session','title':'子エージェントの調査','projectId':'p1','platform':'web','updatedAt':'2026-10-23T00:01:00Z','isActive':False,'lifecycle':'open'})
            page.reload()
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            if width <= 768:
                page.get_by_role('button',name='子エージェントの調査の操作',exact=True).click()
            else:
                page.locator('.session-row').filter(has_text='子エージェントの調査').hover()
            page.get_by_role('button',name='子エージェントの調査を別ペインで開く',exact=True).click()
            expect(page.locator('.pane')).to_have_count(2)
            if width <= 768: expect(page.locator('.sidebar')).not_to_be_in_viewport()
            page.screenshot(path=str(out/f'child-panes-{artifact}.png'),full_page=True)
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            toggle=page.get_by_label('新しい会話の種類と担当')
            toggle.focus(); page.keyboard.press('Enter')
            expect(page.get_by_role('button',name='シークレット会話',exact=False)).to_be_visible()
            page.keyboard.press('Escape')
            expect(page.locator('.new-chat-menu')).not_to_have_attribute('open','')
            toggle.click()
            page.screenshot(path=str(out/f'secret-menu-{artifact}.png'),full_page=True)
            page.get_by_role('button',name='シークレット会話',exact=False).click()
            expect(page.get_by_text('シークレット · Webのみ',exact=True)).to_be_visible()
            assert posts[-1]['secret'] is True and posts[-1]['projectId']=='p1'
            if width <= 768: expect(page.locator('.sidebar')).not_to_be_in_viewport()
            page.screenshot(path=str(out/f'secret-chat-{artifact}.png'),full_page=True)
            page.get_by_role('button',name='終了して破棄',exact=True).click()
            expect(page.get_by_text('シークレット会話を破棄しました',exact=True)).to_be_visible()
            assert posts[-1]=={'closed':'secret_test'}
            assert not errors,errors
            print(f'PASS {width}: Project保存・Web新規・{platform_label}新規と継続',flush=True)
            context.close()
    finally: browser.close()
