"""Isolated browser check; no live xangi or external messages.
uv run --with playwright python tests/browser/agent-team-router.py
"""
import mimetypes
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(os.environ.get('MONITOR_ROOT', str(Path(__file__).resolve().parents[2]))) / 'web/app'
OUT = Path(os.environ.get('ROUTER_EVIDENCE', '/tmp/agent-team-router-browser'))
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium-browser'), headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 375]:
            context = browser.new_context(viewport={'width':width,'height':900})
            page = context.new_page()
            page.set_default_timeout(10000)
            errors, teams = [], []
            page.on('pageerror', lambda error: (errors.append(str(error)), print('PAGEERROR',error,flush=True)))
            page.add_init_script("window.EventSource=class{addEventListener(n,f){if(n==='sessions')fetch('/api/sessions').then(r=>r.json()).then(d=>f({data:JSON.stringify(d)}))}close(){}}")
            now = page.evaluate('new Date().toISOString()')
            sessions = [dict(id=sid,title=title,lifecycle='open',platform='web',messageCount=2,isActive=False,createdAt=now,updatedAt=now,**extra) for sid,title,extra in [
                ('parent','親ルーター',{}),
                ('team','並列調査チーム',{'parentAppSessionId':'parent','agentWork':{'runId':'team-run','teamId':'t','teamName':'調査チーム'},'agentRunStatus':'running'}),
                ('research','自分の調査担当',{'parentAppSessionId':'team','agentWork':{'runId':'research-run','teamName':'調査チーム','memberId':'research','assignment':'調査対象を確認','delivery':'team'},'agentRunStatus':'queued'}),
                ('review','自分のレビュー担当',{'parentAppSessionId':'team','agentWork':{'runId':'review-run','teamName':'調査チーム','memberId':'review','assignment':'結果をレビュー','delivery':'team'},'agentRunStatus':'succeeded'}),
                ('orphan','別期間の子',{'parentAppSessionId':'outside','agentRunStatus':'failed','agentWork':{'runId':'orphan-run','delivery':'failed'}}),
            ]]
            next(s for s in sessions if s['id']=='review')['lifecycle']='closed'
            sessions.append(dict(id='old',title='期限外の完了した子',parentAppSessionId='parent',lifecycle='closed',platform='web',messageCount=2,isActive=False,agentRunStatus='succeeded',updatedAt=(datetime.now(timezone.utc)-timedelta(days=3)).isoformat()))
            agents=[{'id':'a','name':'作業担当','workspaceId':'default','prompt':'調査と検証'}]
            def route(r):
                u=urlparse(r.request.url); path=u.path; method=r.request.method
                if path=='/api/sessions':
                    query=parse_qs(u.query);life=query.get('lifecycle',[None])[0]
                    rows=[s for s in sessions if life is None or s['lifecycle']==life]
                    if query.get('updatedSince'):
                        cutoff=query['updatedSince'][0]
                        rows=[s for s in rows if s['updatedAt']>=cutoff]
                    data={'sessions':rows,'meta':{'hasMore':False}}
                elif path.endswith(('/close','/reopen')) and method=='POST':
                    sid=path.split('/')[3];row=next(s for s in sessions if s['id']==sid)
                    row['lifecycle']='closed' if path.endswith('/close') else 'open';row['updatedAt']=now
                    data={'ok':True,'lifecycle':row['lifecycle']}
                elif path.startswith('/api/sessions/'):
                    sid=path.split('/')[3]
                    data={'session':next((s for s in sessions if s['id']==sid),None),'messages':[],'total':0,'hasMore':False}
                elif path=='/api/teams' and method=='POST':
                    team={**r.request.post_data_json,'id':'t'}; teams.append(team); data={'team':team}
                elif path=='/api/teams': data={'teams':teams,'agents':agents}
                elif path=='/api/teams/t' and method=='PATCH':
                    teams[0].update(r.request.post_data_json);data={'team':teams[0]}
                elif path=='/api/agents': data={'agents':agents}
                elif path=='/api/workspaces': data={'workspaces':[{'id':'default','name':'既定','path':'/workspace','isDefault':True}]}
                elif path=='/api/models': data={'status':'available','models':[],'supportedEfforts':[]}
                elif path.endswith('/channels'): data={'status':'available','channels':[]}
                elif path=='/api/runtime-settings': data={'backend':{'enabled':True,'value':{'backend':'codex'},'options':['codex'],'applyMode':'next-turn'},'replySuggestions':{'enabled':True,'value':'inherit','effective':{'web':True,'discord':True,'slack':True}},'respondToBots':{'enabled':True,'value':False}}
                elif path=='/api/startup-settings': data={'groups':[]}
                elif path=='/api/connection-settings': data={'groups':[],'backends':[]}
                elif path=='/api/config': data={'allowedBackends':['codex']}
                elif path.startswith('/api/'): data={}
                else:
                    file=ROOT/('index.html' if path in ['/monitor','/settings','/'] else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404,body=file.read_bytes() if file.exists() else b'',content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream');return
                r.fulfill(json=data)
            context.route('**/*',route)
            page.goto('http://router.test/monitor')
            board=page.get_by_role('region',name='sessions',exact=True)
            working=board.get_by_role('region',name='作業中',exact=True)
            finished=board.get_by_role('region',name='完了',exact=True)
            expect(page.get_by_role('region',name='チームと子の作業')).to_have_count(0)
            card=lambda sid: board.locator('article').filter(has=page.locator(f'[data-state-session="{sid}"]'))
            expect(card('review')).to_have_count(1)
            expect(finished.locator('[data-state-session="review"]')).to_be_visible()
            expect(working.locator('[data-state-session="research"]')).to_be_visible()
            expect(card('orphan').get_by_text('親への結果通知に失敗')).to_be_visible()
            expect(card('orphan').get_by_role('link',name='親の会話を開く（表示範囲外）')).to_have_attribute('href','/chat/outside')
            expect(board.get_by_text('期限外の完了した子',exact=True)).to_have_count(0)
            expect(board.get_by_text('結果をレビュー',exact=True)).to_have_count(0)
            # Normal cards own lifecycle actions; relation links do not create duplicate cards.
            card('research').get_by_role('button',name='並列調査チーム',exact=True).click()
            expect(page.get_by_role('heading',name='並列調査チーム',exact=True)).to_be_visible()
            card('review').get_by_role('button',name='自分のレビュー担当の詳細を表示',exact=True).click()
            expect(page.get_by_role('region',name='子への依頼要約').get_by_text('結果をレビュー',exact=True)).to_be_visible()
            summary=card('team').locator('summary')
            expect(summary).to_contain_text('子の作業 2件')
            expect(summary).to_contain_text('完了 1件')
            expect(card('team').get_by_role('button',name='自分のレビュー担当',exact=True)).not_to_be_visible()
            summary.focus();page.keyboard.press('Enter')
            card('team').get_by_role('button',name='自分のレビュー担当',exact=True).click()
            expect(page.get_by_role('heading',name='自分のレビュー担当',exact=True)).to_be_visible()
            summary.click()
            # A closed child can be reopened and completed using the unchanged card buttons.
            card('review').get_by_role('button',name='自分のレビュー担当を作業中へ戻す',exact=True).click()
            expect(working.locator('[data-state-session="review"]')).to_be_visible()
            card('review').get_by_role('button',name='自分のレビュー担当を完了にする',exact=True).click()
            expect(finished.locator('[data-state-session="review"]')).to_be_visible()
            # Completed children follow the ordinary time filter, not a separate history list.
            period=page.get_by_label('完了セッションの表示期間',exact=True)
            period.select_option('all')
            expect(finished.locator('[data-state-session="old"]')).to_be_visible()
            period.select_option('24h')
            expect(board.locator('[data-state-session="old"]')).to_have_count(0)
            # Keep the screenshot on the board rather than the selected detail pane.
            page.get_by_role('button',name='詳細を閉じる',exact=True).click()
            page.get_by_role('button',name='変更通知を閉じる',exact=True).click()
            board.locator('.monitor-column-list').evaluate_all('(nodes)=>nodes.forEach(n=>n.scrollTop=0)')
            board.scroll_into_view_if_needed()
            page.screenshot(path=str(OUT/f'monitor-{width}.png'),full_page=True)
            if width < 600:
                finished.scroll_into_view_if_needed()
                page.screenshot(path=str(OUT/f'monitor-completed-{width}.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'monitor horizontal overflow'
            page.goto('http://router.test/settings')
            page.wait_for_timeout(500)
            page.screenshot(path=str(OUT/f'settings-before-{width}.png'),full_page=True)
            page.locator('.settings-section-links a').filter(has_text='チーム').click()
            team_panel=page.locator('#teams')
            team_panel.get_by_role('button',name='チームを作成',exact=True).click()
            team_panel.get_by_label('チーム名（必須）',exact=True).fill('同じ自分のチーム')
            add=team_panel.get_by_label('メンバーを追加')
            add.select_option('a');add.select_option('a');add.select_option('a')
            expect(team_panel.locator('.team-member')).to_have_count(3)
            for i,role in enumerate(['調査','検証','レビュー']):
                team_panel.get_by_label('チーム内の担当（任意）').nth(i).fill(role)
            team_panel.locator('.team-member').nth(1).get_by_role('button',name='メンバーから外す').click()
            expect(team_panel.locator('.team-member')).to_have_count(2)
            team_panel.get_by_label('リーダー（任意）').select_option('a')
            team_panel.get_by_role('button',name='作成',exact=True).click()
            expect(team_panel.get_by_text('チームを保存しました。',exact=False)).to_be_visible()
            assert len(teams[0]['members'])==2
            assert len({m['memberId'] for m in teams[0]['members']})==2
            assert [m['role'] for m in teams[0]['members']]==['調査','レビュー']
            team_panel.get_by_role('button',name='同じ自分のチームを編集',exact=True).click()
            expect(team_panel.locator('.team-member')).to_have_count(2)
            page.screenshot(path=str(OUT/f'team-{width}.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
            assert not errors, errors
            print(f'PASS {width}px: integrated cards/parent navigation/child collapse/close/reopen/period, repeated Team slots/save/reopen, no overflow/errors',flush=True)
            context.close()
    finally:
        browser.close()
