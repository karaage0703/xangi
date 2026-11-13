import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const repo = new URL('../../', import.meta.url).pathname;
const output = process.argv[2]
  ? resolve(process.argv[2])
  : fs.mkdtempSync(join(tmpdir(), 'xangi-markdown-'));
fs.mkdirSync(output, { recursive: true });
const content = '一行目\n二行目\n\n```txt\na\nb\n```';
const mock = `
const nativeFetch = window.fetch;
window.fetch = async (url, init) => {
  if (!String(url).startsWith('/api/')) return nativeFetch(url, init);
  const path = String(url);
  let body;
  if (path.startsWith('/api/workspace/file')) body = {path:'note.md',content:${JSON.stringify(content)},version:'v1',size:50,mtimeMs:1};
  else if (path.startsWith('/api/workspace/entries')) body = {path:'',parent:null,entries:[]};
  else if (path === '/api/workspaces') body = {workspaces:[{id:'default',name:'default',path:'/synthetic'}]};
  else if (path === '/api/extension-favorites') body = {favorites:[]};
  else return new Response('{}', {status:503});
  return new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
};`;
const fixture = {
  name: 'markdown-line-break-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__markdown')) return next();
      const workspace = req.url.includes('workspace');
      const component = workspace
        ? 'React.createElement(Workspace)'
        : `React.createElement(React.Fragment,null,React.createElement(Settings),...['user','assistant'].map(role=>React.createElement('article',{className:'message '+role,key:role},React.createElement(MessageContent,{markdown:true,content:${JSON.stringify(content)}}))))`;
      const html = `<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>${mock}</script><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {MarkdownPreferencesProvider} from '/src/MarkdownPreferences.tsx';
        import {Settings} from '/src/Settings.tsx';
        import {MessageContent} from '/src/MessageContent.tsx';
        import {Workspace} from '/src/Workspace.tsx';import '/src/styles.css';
        createRoot(document.getElementById('root')).render(React.createElement(MarkdownPreferencesProvider,null,${component}));
      </script></body></html>`;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(await server.transformIndexHtml(req.url, html));
    });
  },
};
const vite = await createServer({
  configFile: false,
  root: repo + 'web-ui',
  plugins: [react(), fixture],
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
  '--user-data-dir=' + join(output, 'browser-profile'),
  'about:blank',
]);
const log = fs.createWriteStream(join(output, 'browser.log'));
const sockets = [];
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chromium startup timeout')), 20000);
    browser.on('error', reject);
    browser.stderr.on('data', (chunk) => {
      log.write(chunk);
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const port = new URL(endpoint).port;
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const errors = [];
  async function connect(url) {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        message.error ? task.reject(message.error) : task.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const current = ++id;
        pending.set(current, { resolve, reject });
        ws.send(JSON.stringify({ id: current, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression) => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error('Timed out: ' + expression + ' ' + JSON.stringify(errors));
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return { send, evaluate, wait };
  }
  const page = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const reload = async () => {
    await page.evaluate('window.__leaving = true');
    await page.send('Page.reload');
    await page.wait(
      'window.__leaving !== true && document.querySelector("#markdown-breaks-setting")'
    );
  };
  const change = async (value) => {
    await page.evaluate(
      `(()=>{const select=document.querySelector('#markdown-breaks-setting');select.focus();select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
  };
  for (const width of [1440, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Page.navigate', { url: base + '/__markdown' });
    await page.wait('document.querySelectorAll("article.message br").length===2');
    await page.evaluate('localStorage.clear()');
    await reload();
    await page.wait(
      'document.querySelector("#markdown-breaks-setting")?.value==="on" && document.querySelectorAll("article.message br").length===2'
    );
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(join(output, `settings-${width}.png`), Buffer.from(shot.data, 'base64'));
    await change('off');
    await page.wait('document.querySelectorAll("article.message br").length===0');
    assert.equal(await page.evaluate('localStorage.getItem("xangi-markdown-breaks")'), 'false');
    await reload();
    await page.wait(
      'document.querySelector("#markdown-breaks-setting")?.value==="off" && document.querySelectorAll("article.message").length===2'
    );
    assert.equal(await page.evaluate('document.querySelectorAll("article.message br").length'), 0);
    await change('on');
    await page.wait('document.querySelectorAll("article.message br").length===2');
    const target = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + '/__markdown?workspace&path=note.md')}`,
      { method: 'PUT' }
    ).then((r) => r.json());
    const file = await connect(target.webSocketDebuggerUrl);
    await file.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await file.wait('document.querySelector(".workspace-markdown-preview br")');
    assert.equal(
      await file.evaluate('document.querySelector(".workspace-markdown-preview p").textContent'),
      '一行目\n二行目'
    );
    assert.equal(
      await file.evaluate(
        'document.querySelector(".workspace-markdown-preview pre code").textContent'
      ),
      'a\nb\n'
    );
    await change('off');
    await file.wait(
      'document.querySelector(".workspace-markdown-preview") && document.querySelectorAll(".workspace-markdown-preview br").length===0'
    );
    await change('on');
    await file.wait('document.querySelectorAll(".workspace-markdown-preview br").length===1');
    await file.evaluate(
      `Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}});document.querySelector('.code-copy').click()`
    );
    await file.wait('window.__copied === "a\\nb"');
    const fileShot = await file.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(join(output, `workspace-${width}.png`), Buffer.from(fileShot.data, 'base64'));
    await file.evaluate('document.querySelectorAll(".workspace-editor-tabs button")[1].click()');
    await file.wait('document.querySelector("textarea.workspace-editor")');
    assert.equal(
      await file.evaluate('document.querySelector("textarea.workspace-editor").value'),
      content
    );
    await file.send('Page.close');
    // Saving can be denied even when reading remains possible.
    await page.evaluate(
      'Storage.prototype.setItem=function(){throw new DOMException("Blocked","SecurityError")}'
    );
    await change('off');
    await page.wait(
      'document.querySelector("#display [role=status]") && document.querySelectorAll("article.message br").length===0'
    );
    await reload();
    await page.wait('document.querySelector("#markdown-breaks-setting")?.value==="on"');
    console.log(
      'PASS width',
      width,
      'default ON, OFF, reload, shared user/AI rendering, cross-tab file preview, code and storage failure'
    );
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS no browser exceptions');
} finally {
  for (const ws of sockets) ws.close();
  browser.kill();
  log.end();
  await vite.close();
}
