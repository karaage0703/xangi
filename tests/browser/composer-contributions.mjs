import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(import.meta.dirname, '../../');
const output = await mkdtemp(join(tmpdir(), 'xangi-composer-'));
let installed = false,
  catalogRequests = 0;
const widget = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}button{width:44px;height:44px;padding:0}</style><button id="insert" aria-label="定型文を挿入">文</button><script>
let config;
window.addEventListener('message', e => {
  if(e.source===parent&&e.origin===location.origin&&e.data.type==='xangi.composer.configure') config=e.data;
});
window.emit = (type, fields={}) => parent.postMessage({schemaVersion:1,contextId:config.contextId,requestId:'fixture',type:'xangi.composer.'+type,...fields},location.origin);
window.getConfig=()=>config;
document.querySelector('button').onclick=()=>window.emit('insert',{text:'いつもありがとうございます。'});
parent.postMessage({schemaVersion:1,type:'xangi.composer.ready'},location.origin);
</script>`;
const plugin = {
  name: 'composer-contribution-fixture',
  enforce: 'pre',
  transform(code, id) {
    if (id.split('?')[0].endsWith('/Chat.tsx')) return code + '\nexport { ChatPane };';
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.includes('/service/snippets/')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(widget);
        return;
      }
      if (req.url?.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/extensions') {
          catalogRequests++;
          res.end(
            JSON.stringify({
              extensions: installed
                ? ['snippets', 'generator'].map((id) => ({
                    id,
                    displayName: id,
                    installed: true,
                    running: true,
                    healthy: true,
                    uiAvailable: true,
                    capabilities: [],
                    composer: { path: '/snippets/' },
                  }))
                : [],
            })
          );
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
  const text = () => evaluate('document.querySelector(".pane-input").value');
  const emit = (index, type, fields = {}) =>
    evaluate(
      `document.querySelectorAll('iframe.composer-extension-frame')[${index}].contentWindow.emit(${JSON.stringify(type)},${JSON.stringify(fields)})`
    );
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  const modules = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.method === 'Network.requestWillBeSent') modules.push(m.params.request.url);
  });
  await send('Page.navigate', {
    url: 'http://127.0.0.1:' + vite.httpServer.address().port + '/fixture',
  });
  await wait(
    'document.querySelector(".pane-input")&&!document.querySelector(".pane-input").disabled'
  );
  assert.equal(
    await evaluate('document.querySelectorAll("iframe.composer-extension-frame").length'),
    0
  );
  assert.equal(
    modules.some((url) => url.includes('/ComposerContributions.tsx')),
    false,
    'host module stays unloaded without a contribution'
  );
  // Observe actual form submissions without sending a message to a backend.
  await evaluate(
    `window.fixtureSubmits=0;document.querySelector('.pane-input').form.addEventListener('submit',e=>{e.preventDefault();e.stopImmediatePropagation();window.fixtureSubmits++;},true)`
  );
  const desktopUA = await evaluate('navigator.userAgent');
  const macUA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15';
  const iphoneUA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
  const ipadUA =
    'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
  const androidUA =
    'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36';
  for (const device of [
    { name: 'desktop', width: 1440, touch: false, ua: desktopUA, submits: true },
    { name: 'narrow desktop', width: 600, touch: false, ua: desktopUA, submits: true },
    { name: 'touch PC', width: 1180, touch: true, ua: desktopUA, submits: true },
    { name: 'Mac', width: 1440, touch: false, ua: macUA, submits: true },
    { name: 'iPhone portrait', width: 390, touch: true, ua: iphoneUA, submits: false },
    { name: 'iPhone landscape', width: 844, touch: true, ua: iphoneUA, submits: false },
    { name: 'iPad mobile UA', width: 820, touch: true, ua: ipadUA, submits: false },
    { name: 'iPad desktop UA', width: 1180, touch: true, ua: macUA, submits: false },
    { name: 'iPad with mouse', width: 1180, touch: false, points: 5, ua: macUA, submits: false },
    { name: 'Android', width: 390, touch: true, ua: androidUA, submits: false },
  ]) {
    await send('Network.setUserAgentOverride', { userAgent: device.ua });
    await send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Emulation.setTouchEmulationEnabled', {
      enabled: device.touch,
      ...(device.touch ? { maxTouchPoints: 5 } : {}),
    });
    await evaluate(
      `Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:${device.points ?? (device.touch ? 5 : 0)}})`
    );
    await evaluate(
      `(()=>{const t=document.querySelector('.pane-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'first');t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();t.setSelectionRange(5,5);window.fixtureSubmits=0;})()`
    );
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    assert.equal(
      await evaluate('window.fixtureSubmits'),
      Number(device.submits),
      device.name + ' Enter submission'
    );
    assert.equal(await text(), device.submits ? 'first' : 'first\n', device.name + ' Enter text');
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 8,
      text: '\r',
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 8,
    });
    assert.equal(
      await evaluate('window.fixtureSubmits'),
      Number(device.submits),
      device.name + ' Shift+Enter does not submit'
    );
    assert.equal(
      await text(),
      device.submits ? 'first\n' : 'first\n\n',
      device.name + ' Shift+Enter text'
    );
    const unchanged = await text();
    for (const modifiers of [2, 4]) {
      // Ctrl / Cmd
      const previous = await evaluate('window.fixtureSubmits');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers,
      });
      assert.equal(
        await evaluate('window.fixtureSubmits'),
        previous + 1,
        device.name + ' modified Enter submits'
      );
      assert.equal(await text(), unchanged, device.name + ' submitted text preserved by fixture');
    }
    // Synthetic IME flags validate the handler guard; this does not emulate a real IME.
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      const previous = await evaluate('window.fixtureSubmits');
      for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
        const prevented = await evaluate(
          `(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true,...${JSON.stringify(ime)},...${JSON.stringify(modifiers)}});document.querySelector('.pane-input').dispatchEvent(e);return e.defaultPrevented;})()`
        );
        assert.equal(prevented, false, device.name + ' IME confirmation not intercepted');
      }
      assert.equal(
        await evaluate('window.fixtureSubmits'),
        previous,
        device.name + ' IME does not submit'
      );
    }
    await evaluate('document.querySelector(".pane-send").click()');
    assert.equal(
      await evaluate('window.fixtureSubmits'),
      Number(device.submits) + 3,
      device.name + ' send button'
    );
  }
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Network.setUserAgentOverride', { userAgent: desktopUA });
  await evaluate(`delete navigator.maxTouchPoints`);
  const before = catalogRequests;
  await new Promise((r) => setTimeout(r, 5500));
  assert.equal(catalogRequests, before, 'no catalog polling');
  installed = true;
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait(
    'document.querySelectorAll("iframe.composer-extension-frame").length===2&&[...document.querySelectorAll("iframe.composer-extension-frame")].every(f=>f.contentWindow.getConfig?.())'
  );
  assert.equal(
    await evaluate('document.querySelector("iframe").getAttribute("allow")'),
    null,
    'no microphone permission for canned replies'
  );
  const previousContext = await evaluate(
    'document.querySelector("iframe").contentWindow.getConfig().contextId'
  );
  await evaluate(
    `(()=>{const t=document.querySelector('.pane-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'既存の下書き');t.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await wait(
    'document.querySelector("iframe").contentWindow.getConfig().contextId !== ' +
      JSON.stringify(previousContext)
  );
  await evaluate(
    'document.querySelector("iframe").contentDocument.querySelector("button").click()'
  );
  await wait(
    'document.querySelector(".pane-input").value.endsWith("いつもありがとうございます。")'
  );
  assert.equal(await text(), '既存の下書き\nいつもありがとうございます。');
  assert.equal(await evaluate('document.querySelector(".pane-send").disabled'), false);
  await emit(0, 'begin');
  await wait('document.querySelector(".pane-send").disabled');
  await emit(1, 'insert', { text: '混入' });
  await emit(0, 'update', { revision: 1, text: '文案' });
  await wait('document.querySelector(".pane-input").value.endsWith("文案")');
  await emit(0, 'update', { revision: 2, text: '文案を更新' });
  await wait('document.querySelector(".pane-input").value.endsWith("文案を更新")');
  await emit(0, 'update', { revision: 1, text: '古い結果' });
  assert.equal((await text()).includes('混入'), false);
  assert.equal((await text()).endsWith('文案を更新'), true);
  await emit(0, 'end');
  await wait('!document.querySelector(".pane-send").disabled');
  for (const width of [390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await wait(
        `document.querySelector('iframe').contentWindow.getConfig().appearance.colorScheme===${JSON.stringify(theme)}`
      );
      const appearance = await evaluate(
        `document.querySelector('iframe').contentWindow.getConfig().appearance`
      );
      assert.equal(appearance.iconSize, '18px');
      assert.equal(appearance.buttonSize, '44px');
      assert.equal(appearance.strokeWidth, '1.7');
    }
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      join(output, 'snippets-' + width + '.png'),
      Buffer.from(screenshot.data, 'base64')
    );
  }
  installed = false;
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait('document.querySelectorAll("iframe.composer-extension-frame").length===0');
  assert.equal(await evaluate('document.querySelector(".pane-send").disabled'), false);
  assert.deepEqual(exceptions, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          'Enter, Shift+Enter, Ctrl/Cmd+Enter, IME guards and send button across PC, iPhone, iPad and Android profiles',
          'uninstalled lazy loading',
          'no catalog polling',
          'permission-free canned reply insertion',
          'streaming text generation',
          'exclusive operation',
          'stale revision rejected',
          'send restored',
          'removal',
          'two viewport sizes',
          'no browser exceptions',
        ],
        output,
      },
      null,
      2
    )
  );
} finally {
  ws?.close();
  browser.kill();
  vite.httpServer.closeAllConnections();
  await vite.close();
}
