import fs from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const production = process.env.XANGI_PERF_PRODUCTION === '1';
const repo = process.cwd();
const dir = resolve(process.argv[2]) + '/';
fs.mkdirSync(dir, { recursive: true });
const require = createRequire(repo + '/package.json');
const { createServer } = await import(pathToFileURL(require.resolve('vite')));
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))).default;
const mock = String.raw`
window.__requests=[];
window.__rows=Array.from({length:400},(_,i)=>({id:'fixture-'+i,title:'Fixture '+i,platform:'web',contextKey:'web-chat:fixture-'+i,createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',messageCount:50,isActive:false,lifecycle:'open',transcriptRevision:'r1'}));
localStorage.setItem('xangi_pane_state_v1',JSON.stringify({sessions:window.__rows.slice(0,4).map(s=>s.id),activeIndex:0}));
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const nativeFetch=window.fetch;
window.fetch=async(url,init={})=>{
 if(!String(url).startsWith('/api/'))return nativeFetch(url,init);
 window.__requests.push({url:String(url),method:init.method||'GET'});
 if(String(url).includes('turn-history'))return json({history:[]});
 if(String(url).includes('external-chat-link'))return new Response('{}',{status:404});
 if(String(url).startsWith('/api/sessions/')) {
  const id=String(url).split('/')[3].split('?')[0];
  await new Promise(r=>setTimeout(r,15));
  return json({id,title:id,platform:'web',lifecycle:'open',hasMore:false,messages:Array.from({length:50},(_,i)=>({id:id+'-m'+i,role:i%2?'assistant':'user',content:'Synthetic message '+i,createdAt:'2026-11-08T00:00:00Z'}))});
 }
 if(String(url).startsWith('/api/sessions?')){
  const p=new URL(url,'http://localhost').searchParams;
  const rows=p.get('lifecycle')==='closed'?[]:window.__rows;
  const offset=Number(p.get('offset')||0),limit=Number(p.get('limit')||100);
  return json({sessions:rows.slice(offset,offset+limit),meta:{total:rows.length,hasMore:offset+limit<rows.length,nextOffset:offset+limit}});
 }
 if(url==='/api/config')return json({uploadAccept:null,uploadMaxBytes:67108864,allowedBackends:[],completionShowElapsed:true});
 return json({agents:[],teams:[],projects:[],extensions:[],favorites:[],workspaces:[],providers:[]});
};
window.__sources=[];
window.EventSource=class {
 constructor(url){this.url=url;this.listeners={};window.__sources.push(this);setTimeout(()=>{this.onopen?.();if(String(url).includes('/sessions/stream'))this.emit('sessions',{sessions:String(url).includes('mode=changes')?window.__rows:window.__rows.slice(0,100),meta:{hasMore:true,nextOffset:100}});},100);}
 addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);}
 emit(type,data){for(const cb of this.listeners[type]||[])cb({data:JSON.stringify(data)});}
 close(){window.__sources=window.__sources.filter(s=>s!==this);}
};
window.__notify=()=>{for(const s of window.__sources.filter(s=>String(s.url).includes('/sessions/stream'))){if(String(s.url).includes('mode=changes'))s.emit('session_changes',{upsert:[{...window.__rows[9],title:'changed '+Math.random()}],removed:[]});else s.emit('sessions',{sessions:window.__rows.slice(0,100),meta:{hasMore:true,nextOffset:100}});}};
window.__longTasks=[];
new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
`;
const plugin = {
  name: 'web-performance-fixtures',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (production && req.url?.startsWith('/app/assets/')) {
        const path = resolve(repo + '/web' + req.url.split('?')[0]);
        if (!path.startsWith(repo + '/web/app/assets/')) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(fs.readFileSync(path));
        return;
      }
      if (!req.url?.startsWith('/__perf')) {
        next();
        return;
      }
      if (production) {
        const html = fs
          .readFileSync(repo + '/web/app/index.html', 'utf8')
          .replace('<head>', '<head><script>' + mock + '</script>');
        res.setHeader('content-type', 'text/html');
        res.end(html);
        return;
      }
      const name = req.url.includes('monitor') ? 'Monitor' : 'Chat';
      const html =
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>' +
        mock +
        '</script><script type="module">import React from "react";import {createRoot} from "react-dom/client";import { ' +
        name +
        ' } from "/src/' +
        name +
        '.tsx";import "/src/styles.css";createRoot(document.getElementById("root")).render(React.createElement(' +
        name +
        '));</script></body></html>';
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, html));
    });
  },
};
const vite = await createServer({
  configFile: false,
  root: repo + '/web-ui',
  base: '/',
  plugins: [react(), plugin],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await vite.listen();
const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
const browser = spawn(process.env.XANGI_TEST_CHROMIUM || 'chromium', [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--remote-debugging-port=0',
  '--user-data-dir=' + dir + 'ui-browser-profile',
  'about:blank',
]);
const log = fs.createWriteStream(dir + 'ui-browser.log');
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout')), 20000);
    browser.stderr.on('data', (chunk) => {
      log.write(chunk);
      const m = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    browser.on('error', reject);
  });
  const port = new URL(endpoint).port;
  const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (await evaluate('Boolean(' + expression + ')')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('UI wait failed: ' + expression + '\n' + JSON.stringify(errors));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  const results = [];
  for (const mode of production ? ['chat'] : ['chat', 'monitor']) {
    await send('Page.navigate', { url: base + '/__perf?mode=' + mode });
    await wait(
      mode === 'chat'
        ? 'document.querySelectorAll("article.message").length===200'
        : 'document.body.innerText.includes("Fixture 0")'
    );
    await new Promise((r) => setTimeout(r, 600));
    const before = await evaluate('window.__requests.length');
    await evaluate(
      '(async()=>{for(let i=0;i<10;i++){window.__notify();await new Promise(r=>setTimeout(r,100));}})()'
    );
    await new Promise((r) => setTimeout(r, 300));
    const detail = await evaluate(
      'window.__requests.slice(' +
        before +
        ').filter(r=>/^\\/api\\/sessions\\/fixture-.*\\?/.test(r.url)).length'
    );
    const list = await evaluate(
      'window.__requests.slice(' + before + ').filter(r=>r.url.startsWith("/api/sessions?")).length'
    );
    const tasks = await evaluate('window.__longTasks');
    const loadedScripts = await evaluate(
      'performance.getEntriesByType("resource").filter(e=>e.name.includes("/app/assets/")&&e.name.endsWith(".js")).map(e=>({name:new URL(e.name).pathname,bytes:e.decodedBodySize}))'
    );
    results.push({
      mode,
      loadedScripts,
      loadedJSBytes: loadedScripts.reduce((sum, item) => sum + item.bytes, 0),
      notifications: 10,
      detailRequests: detail,
      listRequests: list,
      longTasks: tasks.length,
      maxLongTaskMs: tasks.length ? Math.max(...tasks) : 0,
    });
    if (process.env.XANGI_ASSERT_PERF === '1') {
      assert.equal(detail, 0);
      assert.equal(list, 0);
    }
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  fs.writeFileSync(dir + 'results.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
} finally {
  ws?.close();
  browser.kill();
  log.end();
  await vite.close();
}
