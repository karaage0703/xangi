import json,mimetypes
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2]/'web/app'
import tempfile
out=Path(tempfile.mkdtemp(prefix='catalog-browser-'))
print('Evidence:',out,flush=True)
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/snap/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  for width in [1280,768,390,320]:
   context=browser.new_context(viewport={'width':width,'height':1000});agents=[];errors=[];saved=[]
   def route(r):
    path=urlparse(r.request.url).path;method=r.request.method
    if path=='/api/sessions/stream':r.fulfill(content_type='text/event-stream',body=': ready\n\n');return
    if path=='/api/config':data={'uploadAccept':None,'uploadMaxBytes':64000000,'allowedBackends':['codex','local-llm']}
    elif path=='/api/agents' and method=='POST':
     a={**r.request.post_data_json,'id':'a1'};agents.append(a);saved.append(a.copy());data={'agent':a}
    elif path.startswith('/api/agents/') and method=='PATCH':
     agents[0].update(r.request.post_data_json);saved.append(agents[0].copy());data={'agent':agents[0]}
    elif path=='/api/agents':data={'agents':agents}
    elif path=='/api/projects':data={'projects':[]}
    elif path=='/api/workspaces':data={'workspaces':[{'id':'default','name':'default','path':'/tmp/default','isDefault':True},{'id':'child','name':'子の作業場所','path':'/tmp/child'}]}
    elif path=='/api/sessions':data={'sessions':[]}
    elif path.startswith('/api/models'):data={'models':[{'id':'gpt-test','supportedEfforts':['high']}],'supportedEfforts':['high'],'status':'available'}
    elif path.startswith('/api/'):data={}
    else:
     f=root/('index.html' if path=='/' else path.removeprefix('/app/').lstrip('/'))
     r.fulfill(status=200 if f.exists() else 404,body=f.read_bytes() if f.exists() else b'',content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream');return
    r.fulfill(json=data)
   context.route('**/*',route);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto('http://agent-owned.test/')
   if width<=768:page.get_by_role('button',name='サイドバーを開く').click()
   page.get_by_role('button',name='Projects',exact=False).click();page.get_by_role('button',name='エージェント',exact=True).click();page.get_by_role('button',name='＋ 新規エージェント',exact=True).click()
   expect(page.locator('.catalog-filter')).to_have_count(0)
   page.get_by_label('名前',exact=True).fill('Avatar:検証担当');page.get_by_label('ワークスペース',exact=True).select_option('child');page.get_by_label('バックエンド',exact=True).select_option('local-llm');page.get_by_label('動作モード',exact=True).select_option('chat');page.get_by_label('Local LLMの推論強度',exact=True).select_option('low')
   page.screenshot(path=str(out/f'form-{width}.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   page.get_by_role('button',name='作成',exact=True).click();expect(page.locator('.project-form')).to_have_count(0)
   if width<=768:page.get_by_role('button',name='サイドバーを開く').click()
   page.get_by_role('button',name='Projects',exact=False).click();expect(page.locator('.agent-view-row')).to_have_count(1);assert saved[-1]['workspaceId']=='child' and saved[-1]['localLlmMode']=='chat' and saved[-1]['localLlmReasoningEffort']=='low'
   expect(page.get_by_text('エージェントを検索',exact=True)).to_be_visible()
   expect(page.get_by_text('Avatar連携の項目も表示',exact=False)).to_have_count(0)
   page.reload()
   if width<=768:page.get_by_role('button',name='サイドバーを開く').click()
   page.get_by_role('button',name='Projects',exact=False).click();page.get_by_role('button',name='エージェント',exact=True).click();page.get_by_role('button',name='Avatar:検証担当を編集',exact=True).click()
   expect(page.get_by_label('ワークスペース',exact=True)).to_have_value('child');expect(page.get_by_label('動作モード',exact=True)).to_have_value('chat');expect(page.get_by_label('Local LLMの推論強度',exact=True)).to_have_value('low')
   page.get_by_label('動作モード',exact=True).select_option('agent');page.get_by_role('button',name='更新',exact=True).click();expect(page.locator('.project-form')).to_have_count(0)
   if width<=768:page.get_by_role('button',name='サイドバーを開く').click()
   page.get_by_role('button',name='Projects',exact=False).click();expect(page.locator('.agent-view-row')).to_have_count(1);assert saved[-1]['localLlmMode']=='agent'
   page.get_by_role('button',name='Avatar:検証担当を編集',exact=True).click();page.get_by_label('バックエンド',exact=True).select_option('codex');expect(page.get_by_label('動作モード',exact=True)).to_have_count(0);page.get_by_role('button',name='更新',exact=True).click();expect(page.locator('.project-form')).to_have_count(0)
   if width<=768:page.get_by_role('button',name='サイドバーを開く').click()
   page.get_by_role('button',name='Projects',exact=False).click();expect(page.locator('.agent-view-row')).to_have_count(1);assert saved[-1]['localLlmMode'] is None and saved[-1]['localLlmReasoningEffort'] is None
   page.get_by_role('button',name='プロジェクト',exact=True).click();page.get_by_label('プロジェクトを検索',exact=True).fill('nonmatching-list-query');page.get_by_role('button',name='＋ 新規プロジェクト',exact=True).click();expect(page.get_by_label('ワークスペース',exact=True)).to_have_count(0)
   expect(page.locator('.catalog-filter')).to_have_count(0)
   page.get_by_text('参加エージェント・詳細設定',exact=True).click()
   expect(page.get_by_label('Avatar:検証担当',exact=True)).to_be_visible()
   expect(page.get_by_text('共通の参考資料',exact=True)).to_have_count(0)
   assert not errors,errors;results.append({'width':width,'pass':True,'saves':saved,'errors':errors});print('PASS',width,flush=True);context.close()
 finally:browser.close()
(out/'browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
