import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(import.meta.dirname, '../../');
const output = await mkdtemp(join(tmpdir(), 'xangi-continuous-chat-'));
const turns = [];
const completed = new Set();
let rejectNext = false;
const plugin = {
  name: 'continuous-chat-fixture',
  enforce: 'pre',
  transform(code, id) {
    if (id.split('?')[0].endsWith('/Chat.tsx')) {
      return code + '\nexport { ChatPane };';
    }
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/sessions/fixture/turns' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          if (rejectNext) {
            rejectNext = false;
            res.statusCode = 409;
            res.end('{"error":"fixture rejection"}');
            return;
          }
          turns.push(input);
          res.end(
            JSON.stringify({ turn: { id: input.requestId, state: 'running', delivery: 'none' } })
          );
        } else if (req.url === '/api/sessions/fixture/stop') {
          completed.add(turns.at(-1).requestId);
          res.end('{}');
        } else if (req.url === '/api/upload') {
          for await (const chunk of req) {
            /* consume multipart fixture */
          }
          res.end('{"files":[{"path":"/fixture/upload.txt","name":"upload.txt"}]}');
        } else if (req.url.startsWith('/api/sessions/fixture/turn-requests/')) {
          const id = req.url.split('/').pop();
          res.end(
            JSON.stringify({
              turn: { id, state: completed.has(id) ? 'completed' : 'running', delivery: 'none' },
            })
          );
        } else if (req.url === '/api/extensions') {
          res.end('{"extensions":[]}');
        } else if (req.url.includes('user-input')) {
          res.end('{"questions":[]}');
        } else if (req.url.includes('external-chat-link')) {
          res.statusCode = 404;
          res.end('{}');
        } else if (req.url.includes('turn-history')) res.end('{"history":[]}');
        else if (req.url.startsWith('/api/sessions/fixture?'))
          res.end(
            JSON.stringify({
              id: 'fixture',
              title: 'Fixture',
              platform: 'web',
              lifecycle: 'open',
              messages: [],
              hasMore: false,
            })
          );
        else if (req.method !== 'GET') throw Error('Unexpected send: ' + req.url);
        else res.end('{"commands":[],"models":[],"workspaces":[]}');
        return;
      }
      if (req.url !== '/fixture') return next();
      const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {ChatPane} from '/src/Chat.tsx';import {useComposerContributions} from '/src/composerContributions.ts';import '/src/styles.css';
const noop=()=>{};function Fixture(){const extensions=useComposerContributions();return React.createElement(ChatPane,{composerExtensions:extensions,pane:{key:'fixture',sessionId:'fixture'},active:true,config:{uploadAccept:null,uploadMaxBytes:67108864,allowedBackends:[],completionShowElapsed:true},refreshVersion:0,onFocus:noop,onClose:noop,onSessionChange:noop,onBusyChange:noop,onSessionsInvalidated:async()=>{},onComplete:noop,onAbortReady:noop});}createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await server.transformIndexHtml('/fixture', html));
    });
  },
};
const vite = await createServer({
  configFile: false,
  root: join(root, 'web-ui'),
  plugins: [react(), plugin],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await vite.listen();
const browser = spawn(process.env.XANGI_TEST_CHROMIUM || 'chromium', [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--remote-debugging-port=0',
  '--user-data-dir=' + join(output, 'profile'),
  'about:blank',
]);
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chromium startup timeout')), 15000);
    browser.once('error', reject);
    browser.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const targets = await fetch('http://127.0.0.1:' + new URL(endpoint).port + '/json/list').then(
    (r) => r.json()
  );
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let sequence = 0;
  const pending = new Map(),
    exceptions = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
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
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error(
      'UI timeout: ' +
        expression +
        ' ' +
        JSON.stringify(exceptions) +
        ' DOM: ' +
        (await evaluate('document.body.innerText'))
    );
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', {
    url: 'http://127.0.0.1:' + vite.httpServer.address().port + '/fixture',
  });
  await wait(
    'document.querySelector(".pane-input")&&!document.querySelector(".pane-input").disabled'
  );
  const type = async (text) => {
    await evaluate(
      `(() => {const el=document.querySelector('.pane-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await new Promise((r) => setTimeout(r, 50));
  };
  const submit = () => evaluate("document.querySelector('.pane-input').form.requestSubmit()");
  const complete = () => completed.add(turns.at(-1).requestId);
  const waitTurns = async (count) => {
    for (let n = 0; n < 100 && turns.length < count; n++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(turns.length, count);
  };
  await type('first');
  await submit();
  await waitTurns(1);
  assert.equal(
    await evaluate("document.querySelector('.pane-input').disabled"),
    false,
    'input remains enabled during response'
  );
  assert.equal(
    await evaluate("document.querySelector('.pane-send').textContent.trim()"),
    '完了後に送信'
  );
  await evaluate(
    `(() => {const input=document.querySelector('.pane-file-input');const dt=new DataTransfer();dt.items.add(new File(['attachment'],'upload.txt',{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
  await wait(
    "document.querySelector('.pane-attachments') || document.body.innerText.includes('upload.txt')"
  );
  await wait("!document.querySelector('.pane-attach-btn').disabled");
  await type('second');
  await submit();
  await type('cancel me');
  await submit();
  await type('third');
  await submit();
  assert.equal(turns.length, 1, 'queued inputs do not interrupt the running turn');
  assert.equal(await evaluate("document.querySelectorAll('.pane-send-queue li').length"), 3);
  await evaluate("document.querySelectorAll('.pane-send-queue li button')[1].click()");
  await type('unfinished draft');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'desktop.png'), Buffer.from(shot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'mobile.png'), Buffer.from(mobile.data, 'base64'));
  complete();
  await waitTurns(2);
  assert.equal(turns[1].message, 'second');
  assert.deepEqual(turns[1].attachments, ['/fixture/upload.txt']);
  assert.equal(
    await evaluate("document.querySelector('.pane-input').value"),
    'unfinished draft',
    'automatic dispatch preserves current draft'
  );
  complete();
  await waitTurns(3);
  assert.equal(turns[2].message, 'third');
  complete();
  await wait("!document.querySelector('.pane-stop')");
  await type('after completion');
  await submit();
  await waitTurns(4);
  complete();
  await wait("!document.querySelector('.pane-stop')");
  assert.deepEqual(
    turns.map((t) => t.message),
    ['first', 'second', 'third', 'after completion']
  );
  await type('fifth');
  await submit();
  await waitTurns(5);
  await type('rejected');
  await submit();
  await type('seventh');
  await submit();
  await type('new draft');
  rejectNext = true;
  complete();
  await wait("document.querySelector('.pane-input').value.includes('rejected')");
  assert.equal(
    await evaluate("document.querySelector('.pane-input').value"),
    'new draft\nrejected'
  );
  assert.equal(turns.length, 5, 'failure pauses the remaining queue');
  await evaluate(
    "[...document.querySelectorAll('.pane-send-queue button')].find(b=>b.textContent.includes('再開')).click()"
  );
  await waitTurns(6);
  assert.equal(turns[5].message, 'seventh');
  complete();
  await wait("!document.querySelector('.pane-stop')");
  await type('eighth');
  await submit();
  await waitTurns(7);
  await type('ninth');
  await submit();
  await evaluate("document.querySelector('.pane-stop').click()");
  await wait("!document.querySelector('.pane-stop')");
  assert.equal(turns.length, 7, 'stop pauses the remaining queue');
  await evaluate(
    "[...document.querySelectorAll('.pane-send-queue button')].find(b=>b.textContent.includes('再開')).click()"
  );
  await waitTurns(8);
  assert.equal(turns[7].message, 'ninth');
  complete();
  await wait("!document.querySelector('.pane-stop')");
  assert.deepEqual(exceptions, []);
  console.log(
    JSON.stringify({ passed: true, turns: turns.map((t) => t.message), screenshots: output })
  );
} finally {
  ws?.close();
  browser.kill();
  vite.httpServer.closeAllConnections();
  await vite.close();
}
