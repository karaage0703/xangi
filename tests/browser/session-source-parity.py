"""Use the same synthetic session snapshot in Chat and Monitor. Build first."""
import json
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/session-source-parity'))
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])
    try:
        for width in [1280, 375]:
            context = browser.new_context(viewport={'width':width,'height':1000})
            sessions = [dict(id=id, title=title, platform=platform, scope=scope, executionOrigin=origin,
                             lifecycle='closed', sessionMode='stateful', isActive=False, updatedAt=datetime.now(timezone.utc).isoformat())
                        for id,title,platform,scope,origin in [
                            ('manual','Mail: 手動チェック','web','interactive','manual'),
                            ('auto','Mail: 自動巡回','web','interactive','automation'),
                            ('legacy','旧予定','discord','scheduler',None),
                            ('line','LINE会話','line','interactive','manual'),
                            ('oldmail','Mail: 起点不明の旧会話','web','interactive',None)]]
            errors=[]
            def route(r):
                u=urlparse(r.request.url); path=u.path
                if path.endswith('/stream'):r.fulfill(content_type='text/event-stream',body=': fixture\n\n');return
                if path=='/api/sessions':
                    q=parse_qs(u.query);items=[s for s in sessions if not q.get('lifecycle') or s['lifecycle']==q['lifecycle'][0]]
                    data={'sessions':items,'meta':{'hasMore':False}}
                elif path=='/api/projects':data={'projects':[]}
                elif path=='/api/agents':data={'agents':[]}
                elif path=='/api/teams':data={'teams':[]}
                elif path=='/api/config':data={'allowedBackends':[]}
                elif path.startswith('/api/'):data={}
                else:
                    f=root/(path.removeprefix('/app/').lstrip('/') if path.startswith('/app/') else 'index.html')
                    r.fulfill(body=f.read_bytes(),content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream');return
                r.fulfill(json=data)
            context.route('**/*',route)
            page=context.new_page();page.set_default_timeout(10000)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto('http://fixture.test/',wait_until='domcontentloaded')
            if width<768:page.get_by_role('button',name='サイドバーを開く',exact=True).click()
            rows=page.locator('.session-row');expect(rows).to_have_count(3)
            expect(page.locator('.session-list')).to_contain_text('手動チェック')
            expect(page.locator('.session-list')).to_contain_text('起点不明の旧会話')
            page.locator('.session-source-settings summary').click()
            page.get_by_role('checkbox',name='自動実行',exact=True).check()
            expect(rows).to_have_count(5)
            page.get_by_role('checkbox',name='Web',exact=True).uncheck()
            expect(rows).to_have_count(3)
            expect(page.locator('.session-list')).to_contain_text('自動巡回')
            expect(page.locator('.session-list')).not_to_contain_text('手動チェック')
            page.screenshot(path=str(out/f'chat-{width}.png'),animations='disabled')
            page.goto('http://fixture.test/monitor',wait_until='domcontentloaded')
            titles=page.locator('.monitor-session-title')
            # Monitor renders both lanes; inspect actual card titles, not hidden details.
            expect(page.locator('[data-filter="web"]')).to_have_attribute('aria-pressed','true')
            expect(page.locator('[data-filter="scheduler"]')).to_have_attribute('aria-pressed','false')
            expect(page.get_by_text('Mail: 手動チェック',exact=True).first).to_be_visible()
            expect(page.get_by_text('Mail: 起点不明の旧会話',exact=True).first).to_be_visible()
            expect(page.get_by_text('Mail: 自動巡回',exact=True)).to_have_count(0)
            expect(page.get_by_text('LINE会話',exact=True).first).to_be_visible()
            page.locator('[data-filter="scheduler"]').click()
            expect(page.get_by_text('Mail: 自動巡回',exact=True).first).to_be_visible()
            page.locator('[data-filter="web"]').click()
            expect(page.get_by_text('Mail: 手動チェック',exact=True)).to_have_count(0)
            expect(page.get_by_text('Mail: 自動巡回',exact=True).first).to_be_visible()
            page.screenshot(path=str(out/f'monitor-{width}.png'),animations='disabled')
            assert not errors,errors
            print(f'PASS {width}: Chat/Monitor same source grouping, closed mail visible, manual/automation/unknown/legacy/LINE',flush=True)
            context.close()
    finally:browser.close()
