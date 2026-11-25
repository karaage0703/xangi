import fs from 'node:fs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const repo=new URL('../../',import.meta.url).pathname;
const dir=process.argv[2] ? resolve(process.argv[2])+'/' : mkdtempSync(join(tmpdir(),'xangi-review-ui-'))+'/';
fs.mkdirSync(dir,{recursive:true});
const require=createRequire(repo+'/package.json');
const {createServer}=await import(pathToFileURL(require.resolve('vite')));
const react=(await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))).default;
const mock=String.raw`
window.__requests=[];
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const nativeFetch=window.fetch;
window.fetch=async(url,init={})=>{
  if(!String(url).startsWith('/api/'))return nativeFetch(url,init);
  window.__requests.push({url:String(url),method:init.method||'GET',body:init.body});
  if(String(url).startsWith('/api/web-commands')) {
    if(init.method==='POST') {
      if(JSON.parse(init.body).input==='/demo-skill') return json({kind:'message',message:'demo skill executed'});
      return json({kind:'session',sessionId:'switched-by-command'});
    }
    return json({commands:[
      {name:'workspace',description:'作業場所',usage:'/workspace use <name>',options:[{name:'use',description:'切替',type:'subcommand',options:[{name:'name',description:'作業場所',type:'string',required:true,choices:[{name:'Second workspace',value:'Second workspace'}]}]}]},
      {name:'demo-skill',description:'直接スキル',usage:'/demo-skill [args]',category:'skills',options:[{name:'args',description:'引数',type:'string'}]}
    ]});
  }
  if(String(url).startsWith('/api/workspace/file')) {
    if(init.method==='PUT')return new Promise(resolve=>{window.__releaseSave=()=>{const body=JSON.parse(init.body);resolve(json({path:'report.txt',content:body.content,version:'v2',size:10,mtimeMs:Date.now()}));};});
    return json({path:'report.txt',content:'original',version:'v1',size:8,mtimeMs:Date.now()});
  }
  if(String(url).startsWith('/api/workspace/entries'))return json({path:'',parent:null,entries:[]});
  if(url==='/api/workspaces')return json({workspaces:[{id:'default',name:'default',path:'/synthetic'}]});
  if(String(url).startsWith('/api/user-input/'))return json({questions:[]});
  if(String(url).includes('turn-history'))return json({history:[]});
  if(String(url).includes('external-chat-link'))return new Response('{}',{status:404});
  if(url==='/api/sessions'&&init.method==='POST') return json({sessionId:'fixture'});
  if(url==='/api/sessions/fixture/turns'&&init.method==='POST')
    return json({turn:{id:'fixture-turn',state:'completed',delivery:'delivered'}});
  if(String(url).startsWith('/api/sessions/fixture?')){
    const previous=new URL(url,'http://localhost').searchParams.get('cursor')==='50';
    const linked=new URLSearchParams(location.search).get('linked');
    return json({id:'fixture',title:'Synthetic regression',platform:linked||'web',linkedChannel:Boolean(linked),lifecycle:'open',hasMore:!previous,nextCursor:previous?null:50,messages:Array.from({length:50},(_,i)=>({id:'m'+(i+(previous?0:50)),role:'user',content:'message '+(i+(previous?0:50)),promptSource:previous||linked?undefined:['schedule','web-user'][i-47],createdAt:'2026-10-30T00:00:00Z'}))});
  }
  return json({});
};
`;
const plugin={name:'qcd-ui-regression-harness',enforce:'pre',transform(code,id){if(id.split('?')[0].endsWith('/Chat.tsx'))return code+'\nexport { ChatPane };';},configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(!req.url?.startsWith('/__qcd_ui')){next();return;}
  const workspace=req.url.includes('mode=workspace');
  const component=workspace?"import {Workspace} from '/src/Workspace.tsx';const component=React.createElement(Workspace);":`
    import {ChatPane} from '/src/Chat.tsx';
    const noop=()=>{};
    function ChatFixture() {
      const params=new URLSearchParams(location.search);
      const linked=params.get('linked');
      const [sessionId,setSessionId]=React.useState(params.has('new')?null:'fixture');
      const linkedDraft=sessionId?undefined:{name:'Fixture project',agentId:'fixture-agent',projectId:'fixture-project',channel:{platform:linked,channelId:'fixture-channel'}};
      return React.createElement(ChatPane,{pane:{key:'test',sessionId,linkedDraft},active:true,config:{uploadAccept:null,uploadMaxBytes:67108864,allowedBackends:[],completionShowElapsed:true},refreshVersion:1,onFocus:noop,onClose:noop,onSessionChange:id=>{window.__selectedSession=id;if(linked)setSessionId(id);},onBusyChange:noop,onSessionsInvalidated:async()=>{},onComplete:noop,onAbortReady:noop});
    }
    const component=React.createElement(ChatFixture);
  `;
  const html='<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>'+mock+'</script><script type="module">import React from "react";import {createRoot} from "react-dom/client";import "/src/styles.css";'+component+'createRoot(document.getElementById("root")).render(component);</script></body></html>';
  res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml(req.url,html));
});}};
const vite=await createServer({configFile:false,root:repo+'/web-ui',base:'/',plugins:[react(),plugin],server:{host:'127.0.0.1',port:0},logLevel:'error'});await vite.listen();
const address=vite.httpServer.address();const base='http://127.0.0.1:'+address.port;
const browser=spawn(process.env.XANGI_TEST_CHROMIUM || 'chromium',['--headless','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+dir+'ui-browser-profile','about:blank']);
const log=fs.createWriteStream(dir+'ui-browser.log');let ws;
try{
 const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),20000);browser.stderr.on('data',chunk=>{log.write(chunk);const m=chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});browser.on('error',reject);});
 const port=new URL(endpoint).port;const targets=await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json());
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let id=0;const pending=new Map();const errors=[];
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{const start=Date.now();while(Date.now()-start<15000){if(await evaluate('Boolean('+expression+')'))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI wait failed: '+expression+'\n'+JSON.stringify(errors));};
 const type=async value=>evaluate(`(()=>{const input=document.querySelector('textarea.workspace-editor');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await send('Page.enable');await send('Runtime.enable');
 for(const width of [1440,390]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
   await send('Page.navigate',{url:base+'/__qcd_ui?mode=workspace&path=report.txt'});await wait('document.querySelector("textarea.workspace-editor")');
   await type('first save');await wait('!document.querySelector("button.primary").disabled');
   await evaluate('document.querySelector("button.primary").click()');await wait('typeof window.__releaseSave === "function"');
   await type('first save plus new typing');
   assert.equal(await evaluate('document.querySelector("button.primary").disabled'),true);
   await evaluate('window.__releaseSave()');await wait('!document.querySelector("button.primary").disabled');
   assert.equal(await evaluate('document.querySelector("textarea.workspace-editor").value'),'first save plus new typing');
   assert.match(await evaluate('document.querySelector(".workspace-save-status").textContent'),/未保存/);
   const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'workspace-'+width+'.png',Buffer.from(shot.data,'base64'));
   console.log('PASS R13 in real Chromium, width',width,'typed text remains unsaved after delayed response; duplicate save disabled');
   await send('Page.navigate',{url:base+'/__qcd_ui?mode=chat'});await wait('document.querySelectorAll("article.message").length===50');
   await new Promise(r=>setTimeout(r,200));const before=await evaluate('window.__requests.filter(r=>r.url.startsWith("/api/sessions/fixture?")).length');
   await evaluate('document.querySelector("button.load-older").click()');await wait('document.querySelectorAll("article.message").length===100');
   await new Promise(r=>setTimeout(r,300));assert.equal(await evaluate('document.querySelectorAll("article.message").length'),100);
   assert.equal(await evaluate('window.__requests.filter(r=>r.url.startsWith("/api/sessions/fixture?")).length'),before+1);
   assert.deepEqual(await evaluate("['m97','m98','m99'].map(id=>document.querySelector('#message-'+id+' header span').textContent)"),['予約実行','あなた','入力（送信元不明）']);
   console.log('PASS Web Chat input labels in Chromium, width',width);
   const chatShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'chat-'+width+'.png',Buffer.from(chatShot.data,'base64'));
   console.log('PASS R02 in real Chromium, width',width,'100 messages retained; one older-page request; no extra tail request');
   await evaluate("document.querySelector('#message-m99').scrollIntoView({block:'end'})");
   const labelsShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'chat-input-labels-'+width+'.png',Buffer.from(labelsShot.data,'base64'));
   const typeCommand=async value=>evaluate(`(()=>{const input=document.querySelector('textarea.pane-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   const click = async selector => {
     const {x,y} = await evaluate(`(() => {
       const target = document.querySelector(${JSON.stringify(selector)});
       target.scrollIntoView({block:'nearest'});
       const rect = target.getBoundingClientRect();
       return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
     })()`);
     await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
     await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
   };
   await typeCommand('unsent draft');
   await click('.pane-command-btn');
   await wait('document.querySelectorAll(".command-option").length===2');
   assert.equal(await evaluate('document.querySelector("textarea.pane-input").value'),'unsent draft');
   await click('.pane-command-btn');
   await wait('!document.querySelector(".command-popover")');
   await typeCommand('/');await wait('document.querySelectorAll(".command-option").length===2');
   assert.match(await evaluate('document.querySelector(".command-palette").textContent'),/demo-skill/);
   await click('.command-option:nth-of-type(2)');
   await wait('document.querySelector(".command-run")');
   assert.match(await evaluate('document.querySelector(".command-palette").textContent'),/必要なら引数を入力/);
   await click('.command-run');
   await wait('document.querySelector(".pane-messages")?.textContent.includes("demo skill executed")');
   assert.equal(await evaluate('JSON.parse(window.__requests.find(r=>r.method==="POST"&&r.url==="/api/web-commands").body).input'),'/demo-skill');
   await typeCommand('/workspace use ');await wait('document.querySelector(".command-option")?.textContent.includes("Second workspace")');
   await evaluate('document.querySelector(".command-option").click()');await wait('document.querySelector(".command-run")');
   assert.equal(await evaluate('document.querySelector("textarea.pane-input").value'),'/workspace use "Second workspace" ');
   await evaluate('document.querySelector(".command-run").click()');await wait('window.__selectedSession==="switched-by-command"');
   assert.equal(await evaluate('JSON.parse(window.__requests.filter(r=>r.method==="POST"&&r.url==="/api/web-commands").at(-1).body).input'),'/workspace use "Second workspace"');
   assert.equal(await evaluate('document.querySelector("textarea.pane-input").value'),'');
   console.log('PASS command palette in real Chromium, width',width,'palette with an existing draft, skill execution without arguments, quoted workspace selection, session navigation, and cleared draft');

   for(const [platform,newConversation] of [['discord',false],['slack',true]]){
     await send('Page.navigate',{url:base+'/__qcd_ui?mode=chat&linked='+platform+(newConversation?'&new':'')});
     await wait(newConversation?'document.querySelector(".pane-destination")':'document.querySelectorAll("article.message").length===50');
     await click('.pane-command-btn');
     await wait('document.querySelectorAll(".command-option").length===1');
     assert.match(await evaluate('document.querySelector(".command-option").textContent'),/demo-skill/);
     const catalog=await evaluate('window.__requests.find(r=>r.url.startsWith("/api/web-commands?")).url');
     const params=new URL(catalog,base).searchParams;
     assert.equal(params.get('skillsOnly'),'true');
     assert.equal(params.get(newConversation?'agentId':'appSessionId'),newConversation?'fixture-agent':'fixture');
     await click('.command-option');
     await wait('document.querySelector(".command-run")');
     await click('.command-run');
     await wait('window.__requests.some(r=>r.url==="/api/sessions/fixture/turns")');
     let turns=await evaluate('window.__requests.filter(r=>r.url==="/api/sessions/fixture/turns").map(r=>JSON.parse(r.body))');
     assert.equal(turns[0].message,'/demo-skill');
     assert.equal(turns[0].skill,true);
     if(newConversation){
       const creation=await evaluate('JSON.parse(window.__requests.find(r=>r.url==="/api/sessions"&&r.method==="POST").body)');
       assert.equal(creation.mode,'linked');
       assert.deepEqual(creation.expectedChannel,{platform,channelId:'fixture-channel'});
       assert.equal(creation.skill,true);
     }
     await wait('document.querySelector(".pane-command-btn:not(:disabled)")');
     await typeCommand('ordinary message');
     await click('.pane-send');
     await wait('window.__requests.filter(r=>r.url==="/api/sessions/fixture/turns").length===2');
     turns=await evaluate('window.__requests.filter(r=>r.url==="/api/sessions/fixture/turns").map(r=>JSON.parse(r.body))');
     assert.equal(turns[1].message,'ordinary message');
     assert.equal(turns[1].skill,undefined);
     console.log('PASS linked skill and ordinary send in real Chromium, width',width,platform,'new conversation:',newConversation);
   }

 }
 assert.equal(errors.length,0,JSON.stringify(errors));console.log('PASS no browser exceptions');
}finally{ws?.close();browser.kill();log.end();await vite.close();}
