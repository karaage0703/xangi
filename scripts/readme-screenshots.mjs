// Render the real Web Chat with in-memory fixtures; no xangi runtime or AI is started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'docs/images');
const profile = await mkdtemp(join(tmpdir(), 'xangi-readme-'));
const timestamp = '2026-11-01T09:00:00+09:00';
const sessions = [
  ['demo-notes', 'ノートアプリの開発相談', 'web'],
  ['demo-research', '週末の工作アイデア', 'discord'],
  ['demo-docs', '使い方ガイドの見直し', 'slack'],
  ['demo-plan', '読書メモを整理する', 'web'],
].map(([id, title, platform]) => ({
  id,
  title,
  platform,
  contextKey: id,
  createdAt: timestamp,
  updatedAt: timestamp,
  messageCount: 2,
  isActive: false,
  lifecycle: 'open',
}));
const messages = [
  { role: 'user', content: '小さなノートアプリを作りたい。まず何から始めればいい？' },
  {
    role: 'assistant',
    content: `まずは、**メモを書いて保存する**ところから始めましょう。

### 最初に作る3つの機能

1. **書く** — タイトルと本文を入力する
2. **残す** — ブラウザに保存して、あとから開く
3. **探す** — タイトルでメモを絞り込む

### 作業の進め方

- 画面のラフを作る
- 保存と再表示を確かめる
- スマートフォンでも使いやすく整える

タグやクラウド同期は、基本の操作ができてから追加できます。まずは画面の構成を一緒に考えましょう。`,
  },
].map((message, i) => ({
  ...message,
  id: `demo-message-${i}`,
  createdAt: timestamp,
  replySuggestions: i ? ['画面の構成を考えて', '保存方法を教えて', '最初のコードを書いて'] : [],
}));
const unexpected = [];
const fixture = {
  name: 'readme-fixtures',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!path.startsWith('/api/')) return next();
      if (req.method !== 'GET') {
        unexpected.push(`${req.method} ${path}`);
        res.writeHead(405).end();
        return;
      }
      if (path.endsWith('/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': screenshot fixture\n\n');
        return;
      }
      const data = {
        '/api/config': {
          uploadAccept: null,
          uploadMaxBytes: 67108864,
          timeoutExtendEnabled: true,
          allowedBackends: ['codex', 'claude-code'],
          completionShowElapsed: true,
        },
        '/api/sessions': { sessions, meta: { limit: 50, hasMore: false, total: sessions.length } },
        '/api/sessions/demo-notes': { ...sessions[0], messages, hasMore: false },
        '/api/sessions/demo-notes/turn-history': { history: [] },
        '/api/sessions/demo-notes/external-chat-link': {},
        '/api/agents': { agents: [] },
        '/api/teams': { teams: [] },
        '/api/projects': { projects: [] },
        '/api/extensions': { extensions: [] },
        '/api/extension-favorites': { favorites: [] },
        '/api/web-commands': { commands: [] },
      }[path];
      if (data === undefined) {
        unexpected.push(`${req.method} ${path}`);
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    });
  },
};
const vite = await createServer({
  configFile: false,
  root: join(root, 'web-ui'),
  plugins: [react(), fixture],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
let browser, ws;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = spawn(process.env.XANGI_TEST_CHROMIUM || '/snap/bin/chromium', [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ]);
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chromium startup timeout')), 15000);
    browser.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
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
    exceptions = [],
    external = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
    if (
      m.method === 'Network.requestWillBeSent' &&
      !m.params.request.url.startsWith('http://127.0.0.1:') &&
      !m.params.request.url.startsWith('data:')
    )
      external.push(m.params.request.url);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('UI timeout: ' + expression + '\n' + (await evaluate('document.body.innerText')));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  // Only the isolated local Vite server may receive browser requests.
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const local = request.url.startsWith(origin + '/') || request.url.startsWith('data:');
    void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId,
      ...(!local ? { errorReason: 'BlockedByClient' } : {}),
    });
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('xangi-theme','light');
    const NativeDate = Date;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : ['2026-11-01T09:10:00+09:00'])); }
      static now() { return new NativeDate('2026-11-01T09:10:00+09:00').getTime(); }
    };`,
  });
  const screenshots = [];
  for (const [name, width, height, mobile] of [
    ['chat-desktop', 1440, 960, false],
    ['chat-mobile', 390, 844, true],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await send('Page.navigate', {
      url: `http://127.0.0.1:${vite.httpServer.address().port}/chat/demo-notes`,
    });
    await wait(
      `document.querySelectorAll('.message').length === 2 && document.querySelector('.pane-input') && !document.querySelector('.pane-input').disabled`
    );
    await evaluate('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(`document.querySelector('.pane-messages').scrollTop=0`);
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    assert.equal(
      await evaluate("document.querySelector('.pane-messages').scrollTop"),
      0,
      name + ' starts at first message'
    );
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= innerWidth'),
      true,
      name + ' fits viewport'
    );
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, name + '.png'), Buffer.from(screenshot.data, 'base64'));
    screenshots.push({ name, width, height });
  }
  assert.deepEqual(unexpected, [], 'all API requests use known dummy fixtures');
  assert.deepEqual(exceptions, [], 'no browser exceptions');
  assert.deepEqual(external, [], 'no external resources requested');
  console.log(JSON.stringify({ ok: true, screenshots, unexpected, exceptions, external }, null, 2));
} finally {
  ws?.close();
  if (browser && browser.exitCode === null) {
    const stopped = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await stopped;
  }
  vite.httpServer?.closeAllConnections();
  await vite.close();
  await rm(profile, { recursive: true, force: true });
}
