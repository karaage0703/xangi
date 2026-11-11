import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(import.meta.dirname, '../../');
const output = await mkdtemp(join(tmpdir(), 'xangi-favorites-'));
let favorites = [
  { id: 'studio', displayName: 'Studio', available: true },
  { id: 'tasks', displayName: 'Tasks', available: true },
];
let fail = false;
const plugin = {
  name: 'favorites-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url === '/api/extension-favorites') {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          if (fail) {
            res.statusCode = 500;
            res.end('{}');
            return;
          }
          const action = JSON.parse(body);
          const item = favorites.find((f) => f.id === action.id);
          if (action.action === 'set-sidebar') item.showInSidebar = action.showInSidebar;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ favorites }));
        return;
      }
      if (req.url === '/api/extensions') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ extensions: [], issues: [], degraded: false }));
        return;
      }
      if (req.url?.startsWith('/api/extensions/') && req.url.endsWith('/ui')) {
        res.end('<h1>Extension opened</h1><a href="/fixture">Back</a>');
        return;
      }
      if (req.url != '/fixture') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(
        await server.transformIndexHtml(
          '/fixture',
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {Extensions} from '/src/Extensions.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(Extensions));</script>`
        )
      );
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
  await send('Page.bringToFront');
  const url = 'http://127.0.0.1:' + vite.httpServer.address().port + '/fixture';
  const toggle = 'button[aria-label="Studioのサイドバー表示"]';
  for (const width of [1280, 390]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await send('Page.navigate', { url });
    await wait(`document.querySelector('${toggle}')?.getAttribute('aria-pressed')==='true'`);
    await evaluate(`document.querySelector('${toggle}').click()`);
    await wait(`document.querySelector('${toggle}')?.getAttribute('aria-pressed')==='false'`);
    await wait(
      `!document.querySelector('.app-navigation-favorites a[href="/api/extensions/studio/ui"]')`
    );
    assert.equal(
      await evaluate(
        `!!document.querySelector('.extension-favorites-list a[href="/api/extensions/studio/ui"]')`
      ),
      true
    );
    await send('Page.reload');
    await wait(`document.querySelector('${toggle}')?.getAttribute('aria-pressed')==='false'`);
    if (width < 768) {
      await evaluate(`document.querySelector('.app-more-trigger').click()`);
      await wait('document.querySelector("#app-more-sheet")');
      assert.equal(
        await evaluate(
          `!!document.querySelector('.app-more-links a[href="/api/extensions/studio/ui"]')`
        ),
        false
      );
      assert.equal(
        await evaluate(
          `!!document.querySelector('.app-more-links a[href="/api/extensions/tasks/ui"]')`
        ),
        true
      );
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    }
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    await writeFile(join(output, `favorites-${width}.png`), Buffer.from(shot.data, 'base64'));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    await evaluate(
      `document.querySelector('.extension-favorites-list a[href="/api/extensions/studio/ui"]').click()`
    );
    await wait(`document.body.innerText.includes('Extension opened')`);
    await send('Page.navigate', { url });
    await wait(
      `document.querySelector('${toggle}') && !document.querySelector('${toggle}').disabled`
    );
    // Keyboard activation of the toggle.
    await evaluate(`document.querySelector('${toggle}').focus()`);
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
    await wait(`document.querySelector('${toggle}')?.getAttribute('aria-pressed')==='true'`);
  }
  fail = true;
  await evaluate(`document.querySelector('${toggle}').click()`);
  await wait(`document.querySelector('.extension-favorites [role="alert"]')`);
  assert.equal(
    await evaluate(`document.querySelector('${toggle}').getAttribute('aria-pressed')`),
    'true'
  );
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(
    JSON.stringify(
      {
        passed: [
          'desktop/mobile toggle',
          'reload persistence',
          'list link opens hidden extension',
          'keyboard activation',
          'mobile more filtering',
          'no horizontal overflow',
          'save error retains state',
          'no exceptions',
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
