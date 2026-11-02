import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const repo = new URL('../../', import.meta.url).pathname;
const dir = process.argv[2]
  ? resolve(process.argv[2]) + '/'
  : mkdtempSync(join(tmpdir(), 'xangi-review-ui-')) + '/';
fs.mkdirSync(dir, { recursive: true });
const require = createRequire(repo + '/package.json');
const { createServer } = await import(pathToFileURL(require.resolve('vite')));
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))).default;
const mock = String.raw`
window.__requests=[]; window.__fail=false; window.__delay=false;
let schedules=[]; let nextId=0;
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
window.fetch=async(url,init={})=>{
 window.__requests.push({url:String(url),method:init.method||'GET',body:init.body});
 if(url==='/api/projects')return json({projects:[]});
 if(String(url).startsWith('/api/runtime-settings/channels')) {
   const discord=String(url).includes('discord');
   if(discord && window.__delay) await new Promise(r=>window.__releaseDiscord=r);
   if(window.__fail)return json({status:'unavailable',channels:[],message:'一覧取得テスト失敗'});
   return json({status:'available',channels:discord?[{id:'111',name:'#general',group:'Server A'},{id:'222',name:'#general',group:'Server B'}]:[{id:'C123',name:'#team'}]});
 }
 if(url==='/api/schedules' && !init.method)return json({schedules,enabled:true,startupEnabled:true});
 if(String(url).startsWith('/api/schedules') && ['POST','PATCH'].includes(init.method)){
   const body=JSON.parse(init.body);const schedule={...body,id:init.method==='PATCH'?String(url).split('/').at(-1):'s'+(++nextId),enabled:true,destinationLabel:body.channelId==='111'?'#general':undefined};schedules=[schedule];return json({schedule});
 }
 return json({});
};
`;
const plugin = {
  name: 'schedule-ui-harness',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__qcd_ui')) {
        next();
        return;
      }
      const html =
        '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>' +
        mock +
        '</script><script type="module">import React from "react";import {createRoot} from "react-dom/client";import "/src/styles.css";import {Schedules} from "/src/Schedules.tsx";createRoot(document.getElementById("root")).render(React.createElement(Schedules));</script></body></html>';
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
const address = vite.httpServer.address();
const base = 'http://127.0.0.1:' + address.port;
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
    throw Error(
      'UI wait failed: ' +
        expression +
        '\n' +
        JSON.stringify(errors) +
        '\n' +
        JSON.stringify(
          await evaluate(
            '({text:document.body.innerText,requests:window.__requests,fail:window.__fail})'
          )
        )
    );
  };

  const change = async (selector, value) =>
    evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`
    );
  const click = async (text) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getClientRects().length).at(${text === '編集' ? -1 : 0}).click()`
    );
  const platform = 'form > label:first-child select';
  const channel = 'form > label:nth-child(2) select';
  const save = async () => {
    await change('textarea', 'テスト依頼');
    await click('予定を追加');
    await wait(
      'document.querySelector(".schedules-notice")?.textContent.includes("追加しました") && document.querySelector("form > label:first-child select").value === "web"'
    );
  };
  const payload = () =>
    evaluate(
      'JSON.parse(window.__requests.filter(r=>r.method==="POST"||r.method==="PATCH").at(-1).body)'
    );
  await send('Page.enable');
  await send('Runtime.enable');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url: base + '/__qcd_ui' });
    await wait('document.querySelector("form")');
    await change(platform, 'discord');
    await wait('document.querySelectorAll("form label:nth-child(2) option").length===4');
    assert.match(
      await evaluate('document.querySelector("form label:nth-child(2)").textContent'),
      /Server A.*Server B/s
    );
    await change(channel, '111');
    await save();
    assert.equal((await payload()).channelId, '111');
    await click('編集');
    await wait('document.querySelector("form label:nth-child(2) select")?.value==="111"');
    await change(channel, '__manual__');
    await change('input[placeholder="チャンネルまたはスレッドID"]', '999');
    await click('変更を保存');
    await wait(
      'document.querySelector(".schedules-notice")?.textContent.includes("更新しました") && document.querySelector("form > label:first-child select").value === "web"'
    );
    assert.equal((await payload()).channelId, '999');
    await click('編集');
    await wait('document.querySelector("input[placeholder^=チャンネルまたは]")?.value==="999"');
    await click('キャンセル');
    await change(platform, 'slack');
    await wait('document.querySelector("form label:nth-child(2)")?.textContent.includes("#team")');
    await change(channel, 'C123');
    await save();
    assert.equal((await payload()).platform, 'slack');
    assert.equal((await payload()).channelId, 'C123');
    await click('編集');
    await wait('document.querySelector("form label:nth-child(2) select")?.value==="C123"');
    await change(channel, '__manual__');
    await change('input[placeholder^="チャンネルID または"]', 'C123:123.456');
    await click('変更を保存');
    await wait(
      'document.querySelector(".schedules-notice")?.textContent.includes("更新しました") && document.querySelector("form > label:first-child select").value === "web"'
    );
    assert.equal((await payload()).channelId, 'C123:123.456');
    await evaluate('window.__fail=true');
    await change(platform, 'discord');
    await wait('document.body.textContent.includes("一覧取得テスト失敗")');
    await change(channel, '__manual__');
    await change('input[placeholder="チャンネルまたはスレッドID"]', '888');
    await save();
    assert.equal((await payload()).channelId, '888');
    await change(platform, 'discord');
    await wait('document.body.textContent.includes("一覧取得テスト失敗")');
    await evaluate('window.__fail=false');
    await click('チャンネル一覧を再読み込み');
    await wait(
      'document.querySelector("form label:nth-child(2)")?.textContent.includes("Server A")'
    );
    // Keyboard selection uses the native select; no custom pointer-only control.
    await evaluate('document.querySelector("form label:nth-child(2) select").focus()');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home' });
    await change(channel, '111');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(dir + 'schedule-' + width + '.png', Buffer.from(shot.data, 'base64'));
    // A delayed Discord result must not overwrite Slack options.
    await change(platform, 'web');
    await evaluate('window.__delay=true');
    await change(platform, 'discord');
    await wait('typeof window.__releaseDiscord==="function"');
    await change(platform, 'slack');
    await wait('document.querySelector("form label:nth-child(2)")?.textContent.includes("#team")');
    await evaluate('window.__releaseDiscord()');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await evaluate(
        'document.querySelector("form label:nth-child(2)").textContent.includes("Server A")'
      ),
      false
    );
    console.log(
      'PASS width',
      width,
      'name selection, save, edit, Discord/Slack thread IDs, API failure, retry, stale platform response, no overflow'
    );
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS no browser exceptions');
} finally {
  ws?.close();
  browser.kill();
  log.end();
  await vite.close();
}
