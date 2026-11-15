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
  ...Array.from({length: 16}, (_, i) => ({id: 'extra-' + i, displayName: 'Extra ' + i, available: true})),
];
let fail = false;
let favoritesDelay = 0;
let failReads = false;
const plugin = {
  name: 'favorites-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url === '/api/extension-favorites') {
        if (req.method === 'GET') {
          await new Promise(resolve => setTimeout(resolve, favoritesDelay));
          if (failReads) { res.statusCode=500; res.end('{}'); return; }
        }
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
      if (req.url?.startsWith('/api/extensions/') && (req.url.endsWith('/ui') || req.url.endsWith('/service/'))) {
        if (req.url === '/api/extensions/feed/ui') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<script>location.replace("/api/extensions/feed/service/")</script>');
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<a id="home" href="/" aria-label="xangiホーム">xangiホーム</a><a id="xangi-home" href="/">xangiホーム</a><a id="xangiHome" href="/">xangiホーム</a><h1>Extension opened: ' + req.url.split('/')[3] + '</h1><input aria-label="Test input"><button onclick="this.textContent=123">Run</button>');
        return;
      }
      if (!/^\/(extensions|workspace|monitor)(\/|$)/.test(req.url || '')) return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        await server.transformIndexHtml(
          '/fixture',
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {App} from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));</script>`
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
        ' FRAME LINKS: ' + (await evaluate(`Array.from(document.querySelector('iframe')?.contentDocument?.querySelectorAll('a') || [], a => a.outerHTML)`)) + ' DOM: ' +
        (await evaluate('document.body.innerText'))
    );
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  for (const [width, height] of [[1280, 900], [1280, 480], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 768});
    await send('Page.navigate', {url: origin + '/extensions'});
    await wait('document.querySelector(".app-navigation-favorites a")');
    const compact = await evaluate(`matchMedia('(max-width: 768px), (max-height: 500px) and (hover: none)').matches`);
    if (compact) {
      await evaluate('document.querySelector(".app-more-trigger").click()');
      await wait('document.querySelector(".app-more-links .extension-favorite-link")');
    }
    await evaluate(`document.querySelector('${compact ? '.app-more-links' : '.app-navigation-favorites'} a[href="/extensions/studio"]').click()`);
    await wait('document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Extension opened: studio")');
    assert.equal(await evaluate('!!document.querySelector(".app-topbar")'), true);
    await wait('document.querySelector("iframe").contentDocument.querySelectorAll("a").length === 0');
    assert.equal(await evaluate('location.pathname'), '/extensions/studio');
    await evaluate('document.querySelector("iframe").contentDocument.querySelector("button").click()');
    assert.equal(await evaluate('document.querySelector("iframe").contentDocument.querySelector("button").textContent'), '123');
    await evaluate('void (window.railBefore = document.querySelector(".app-topbar"))');
    if (compact) {
      await evaluate('document.querySelector(".app-more-trigger").click()');
      await wait('document.querySelector(".app-more-links")');
    }
    await evaluate(`document.querySelector('${compact ? '.app-more-links' : '.app-navigation-favorites'} a[href="/extensions/tasks"]').click()`);
    await wait('document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Extension opened: tasks")');
    assert.equal(await evaluate('window.railBefore === document.querySelector(".app-topbar")'), true);
    if (compact) {
      // Close the sheet after switching; the selection should close it automatically.
      assert.equal(await evaluate('!!document.querySelector(".app-more-sheet")'), false);
    }
    await evaluate('history.back()');
    await wait('location.pathname === "/extensions/studio" && document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Extension opened: studio")');
    await evaluate('history.forward()');
    await wait('location.pathname === "/extensions/tasks" && document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Extension opened: tasks")');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate('document.querySelector("iframe").getBoundingClientRect().bottom <= (innerHeight - (getComputedStyle(document.querySelector(".app-topbar")).width === innerWidth + "px" ? 64 : 0))'), true);
    if (!compact) {
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-navigation-favorites")).scrollbarWidth'), 'none');
      await evaluate('document.querySelector(".app-navigation-favorites a:last-child").focus()');
      assert.equal(await evaluate('document.activeElement.getBoundingClientRect().bottom <= document.querySelector(".app-navigation-favorites").getBoundingClientRect().bottom + 1'), true);
    }
    const shot = await send('Page.captureScreenshot', {format: 'png'});
    await writeFile(join(output, `shell-${width}-${height}.png`), Buffer.from(shot.data, 'base64'));
    await evaluate("document.body.dataset.beforeReload = 'true'");
    await send('Page.reload');
    await wait("document.body.dataset.beforeReload !== 'true' && document.querySelector('.app-topbar')");
    await wait('document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Extension opened: tasks")');
    assert.equal(await evaluate(`!!document.querySelector('a[href="/workspace"]')`), true);
    assert.equal(await evaluate(`document.querySelector('a[href="/monitor"]').textContent`), 'モニター');
    await evaluate(`document.querySelector('a[href="/workspace"]').click()`);
    await wait('location.pathname === "/workspace" && document.querySelector(".workspace-browser-shell .app-topbar")');
  }
  // A cached favorite must appear while the new API response is still delayed.
  favoritesDelay = 2500;
  await evaluate("document.body.dataset.beforeReload = 'true'");
  await send('Page.navigate', {url: origin + '/extensions/studio'});
  await wait("document.body.dataset.beforeReload !== 'true' && document.querySelector('.app-topbar')");
  await wait(`document.querySelector('.app-navigation-favorites a[href="/extensions/studio"]')`);
  const cacheVisibleMs = await evaluate('performance.now()');
  assert.ok(cacheVisibleMs < 2000, 'cached navigation waited for favorites API');
  favorites[0].displayName = 'Studio refreshed';
  await wait(`document.querySelector('.app-navigation-favorites a[href="/extensions/studio"]').textContent.includes('Studio refreshed')`);
  // Transient failures retain navigation instead of blanking it.
  favoritesDelay = 0;
  failReads = true;
  await evaluate("document.body.dataset.beforeReload = 'true'");
  await send('Page.reload');
  await wait("document.body.dataset.beforeReload !== 'true' && document.querySelector('.app-topbar')");
  await wait(`document.querySelector('.app-navigation-favorites a[href="/extensions/studio"]')?.textContent.includes('Studio refreshed')`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await evaluate(`!!document.querySelector('.app-navigation-favorites a[href="/extensions/studio"]')`), true);
  // Damaged / unavailable storage cannot break a fresh API read.
  failReads = false;
  await evaluate("sessionStorage.setItem('xangi-extension-favorites-v1', '{broken')");
  await evaluate("document.body.dataset.beforeReload = 'true'");
  await send('Page.reload');
  await wait("document.body.dataset.beforeReload !== 'true' && document.querySelector('.app-topbar')");
  await wait(`document.querySelector('.app-navigation-favorites a[href="/extensions/studio"]')`);
  const script = await send('Page.addScriptToEvaluateOnNewDocument', {source: "Object.defineProperty(window, 'sessionStorage', {value: {getItem() {throw Error('disabled');}, setItem() {throw Error('disabled');}}});"});
  await evaluate("document.body.dataset.beforeReload = 'true'");
  await send('Page.reload');
  await wait("document.body.dataset.beforeReload !== 'true' && document.querySelector('.app-topbar')");
  await wait(`document.querySelector('.app-navigation-favorites a[href="/extensions/studio"]')`);
  await send('Page.removeScriptToEvaluateOnNewDocument', {identifier: script.identifier});
  await send('Page.navigate', {url: origin + '/extensions/feed'});
  await wait(`document.querySelector('iframe')?.contentWindow.location.pathname === '/api/extensions/feed/service/' && document.querySelector('iframe')?.contentDocument?.body?.textContent.includes('Extension opened: feed')`);
  await wait(`document.querySelector('iframe').contentDocument.querySelectorAll('a').length === 0`);
  await send('Page.navigate', {url: origin + '/api/extensions/feed/service/'});
  await wait(`document.querySelector('a[aria-label="xangiホーム"]')`);
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(JSON.stringify({cacheVisibleMs, delayedApiMs: 2500, passed: ['desktop/mobile/short viewport', 'persistent rail', 'switch extension', 'iframe interaction', 'reload direct route', 'keyboard scroll', 'no horizontal overflow', 'monitor label', 'cached favorites before delayed response', 'background refresh', 'cache survives network error', 'damaged/disabled storage fallback', 'embedded home hidden', 'no exceptions'], output}, null, 2));
} finally {
  ws?.close();
  browser.kill();
  vite.httpServer.closeAllConnections();
  await vite.close();
}
