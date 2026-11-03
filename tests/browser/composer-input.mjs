import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposerPreview } from '../../scripts/composer-preview.mjs';

const preview = await createComposerPreview();
const output = await mkdtemp(join(tmpdir(), 'xangi-voice-ui-'));
const chrome = spawn(
  process.env.XANGI_TEST_CHROMIUM || 'chromium',
  [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-port=0',
    '--user-data-dir=' + join(output, 'profile'),
    'about:blank',
  ],
  { windowsHide: true }
);
let ws;
const errors = [];
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('Chromium startup timed out; set XANGI_TEST_CHROMIUM')),
      15000
    );
    chrome.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    chrome.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on('exit', (code) => {
      clearTimeout(timer);
      reject(Error('Chromium exited: ' + code));
    });
  });
  const targets = await fetch('http://127.0.0.1:' + new URL(endpoint).port + '/json/list').then(
    (r) => r.json()
  );
  ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      message.error ? entry.reject(message.error) : entry.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression: expression
        .replaceAll(
          'window.__speechSessions',
          'document.querySelector("iframe.composer-extension-frame").contentWindow.__speechSessions'
        )
        .replaceAll(
          'document.querySelector(".contribution-btn")',
          'document.querySelector("iframe.composer-extension-frame").contentDocument.querySelector("#control")'
        ),
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const wait = async (expression) => {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (await evaluate('Boolean(' + expression + ')')) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw Error(
      'UI wait timed out: ' +
        expression +
        '\n' +
        JSON.stringify(errors) +
        '\n' +
        JSON.stringify(
          await evaluate(
            '({href:location.href,html:document.body.innerHTML.slice(-4000),frames:Array.from(document.querySelectorAll("iframe")).map(f=>({src:f.src,html:f.contentDocument?.body?.innerHTML}))})'
          )
        )
    );
  };
  const type = async (text) =>
    evaluate(
      `(()=>{const input=document.querySelector('.pane-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
  const click = async (selector) => {
    const point = await evaluate(
      `(()=>{const frame=document.querySelector('iframe.composer-extension-frame');const target=${JSON.stringify(selector)}==='.contribution-btn'?frame:document.querySelector(${JSON.stringify(selector)});const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
    );
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
  };
  const frame = 'document.querySelector("iframe.composer-extension-frame").contentWindow';
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "window.__begins=[];window.addEventListener('message',e=>{if(e.data?.type==='xangi.composer.begin')window.__begins.push(e.data)})",
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send('Page.navigate', { url: preview.url });
  await wait(
    'document.querySelector("iframe.composer-extension-frame")?.contentDocument?.querySelector("#control")&&!document.querySelector(".contribution-btn").disabled'
  );
  await type('Existing draft');
  await click('.contribution-btn');
  await wait('document.querySelector(".pane-send").disabled');
  await evaluate(frame + '.update("first")');
  await wait('document.querySelector(".pane-input").value==="Existing draft\\nfirst"');
  await evaluate(
    `(()=>{const f=document.querySelector('iframe.composer-extension-frame');const valid=window.__begins.at(-1);for(const [origin,source,extra] of [[location.origin,window,{}],['https://invalid.example',f.contentWindow,{}],[location.origin,f.contentWindow,{contextId:'stale'}],[location.origin,f.contentWindow,{requestId:'wrong'}],[location.origin,f.contentWindow,{revision:1}]])window.dispatchEvent(new MessageEvent('message',{origin,source,data:{...valid,type:'xangi.composer.update',revision:999,text:'invalid',...extra}}));})()`
  );
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(
    await evaluate('document.querySelector(".pane-input").value'),
    'Existing draft\nfirst'
  );
  await evaluate(frame + '.update("first revised")');
  await wait('document.querySelector(".pane-input").value.endsWith("first revised")');
  await evaluate('document.querySelector(".pane-input").form.requestSubmit()');
  assert.equal(
    preview.requests.some((r) => r.method === 'POST'),
    false
  );
  await type('manual edit');
  await wait(frame + '.cancelCount>0');
  await evaluate(frame + '.stale("late overwrite")');
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await evaluate('document.querySelector(".pane-input").value'), 'manual edit');
  await click('.contribution-btn');
  await evaluate(frame + '.update("second")');
  await wait('document.querySelector(".pane-input").value.endsWith("second")');
  await evaluate(frame + '.finish()');
  await wait('!document.querySelector(".pane-send").disabled');
  await click('.contribution-btn');
  await evaluate('window.__composerPreviewSwitch()');
  await wait('!document.querySelector(".pane-send").disabled');
  await evaluate(frame + '.stale("wrong conversation")');
  await new Promise((done) => setTimeout(done, 50));
  assert(
    !(await evaluate('document.querySelector(".pane-input").value')).includes('wrong conversation')
  );
  await click('.contribution-btn');
  await evaluate('window.__disableExtension()');
  await wait('!document.querySelector("iframe.composer-extension-frame")');
  await type('extension stopped');
  await wait('!document.querySelector(".pane-send").disabled');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'real ChatPane',
        'generic extension iframe',
        'snapshot replacement',
        'origin/source/context/request/revision validation',
        'manual cancellation',
        'no send during input',
        'conversation cancellation',
        'extension removal',
        'mobile layout',
        'no browser exceptions',
      ],
    })
  );
} finally {
  ws?.close();
  chrome.kill();
  await preview.close();
}
