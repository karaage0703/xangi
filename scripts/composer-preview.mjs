import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../web-ui/', import.meta.url));

// Test only. This harness renders the real ChatPane without starting an agent,
// loading .env, or connecting to an installed Xangi service.
export async function createComposerPreview({
  port = 0,
  host = '127.0.0.1',
  allowedHosts = [],
} = {}) {
  const requests = [];
  const token = 'test-fixture-only';
  const extension = createHttpServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('../tests/browser/fixtures/composer.html', import.meta.url)));
  });
  await new Promise((done) => extension.listen(0, '127.0.0.1', done));
  const extensionBase = `http://127.0.0.1:${extension.address().port}`;

  const plugin = {
    name: 'local-composer-preview',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0].endsWith('/Chat.tsx')) return code + '\nexport { ChatPane };';
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith('/api/extensions/test-input/service/')) {
          const path = req.url.slice('/api/extensions/test-input/service'.length).split('?')[0];
          const response = await fetch(extensionBase + path, {
            headers: { authorization: `Bearer ${token}` },
          });
          res.statusCode = response.status;
          for (const [key, value] of response.headers)
            if (!['content-length', 'connection', 'transfer-encoding'].includes(key))
              res.setHeader(key, value);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        if (req.url?.startsWith('/api/')) {
          requests.push({ url: req.url, method: req.method });
          res.setHeader('Content-Type', 'application/json');
          if (req.method !== 'GET') {
            res.statusCode = 409;
            res.end(
              JSON.stringify({
                error: '入力連携テスト画面ではAIへ送信しません。下書きの内容を確認してください。',
              })
            );
          } else if (req.url.includes('external-chat-link')) {
            res.statusCode = 404;
            res.end('{}');
          } else if (req.url.includes('turn-history')) res.end(JSON.stringify({ history: [] }));
          else if (
            req.url.startsWith('/api/sessions/composer-test?') ||
            req.url.startsWith('/api/sessions/composer-other?')
          ) {
            res.end(
              JSON.stringify({
                id: req.url.includes('composer-other') ? 'composer-other' : 'composer-test',
                title: '入力連携テスト',
                platform: 'web',
                lifecycle: 'open',
                messages: [],
                hasMore: false,
              })
            );
          } else if (req.url.startsWith('/api/events/stream')) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.end(': local preview\n\n');
          } else res.end(JSON.stringify({ commands: [], models: [], workspaces: [] }));
          return;
        }
        if (req.url?.split('?')[0] !== '/composer-test') return next();
        const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xangi 入力連携テスト</title>
          <style>.composer-preview{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr);max-width:1000px;margin:auto}.composer-preview-header{padding:12px 16px;border-bottom:1px solid var(--border)}.composer-preview-header h1{font-size:18px;margin:0 0 6px}.composer-preview-header p{font-size:13px;margin:4px 0;color:var(--ink-secondary)}.composer-preview-body{min-height:0;display:grid}</style>
          </head><body><div id="root"></div><script type="module">
          import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';import {ChatPane} from '/src/Chat.tsx';
          const noop=()=>{};window.__composerPreviewActive=true;
          function Preview(){const [enabled,setEnabled]=React.useState(true);window.__disableExtension=()=>setEnabled(false);const [session,setSession]=React.useState('composer-test');window.__composerPreviewSwitch=()=>setSession(s=>s==='composer-test'?'composer-other':'composer-test');return React.createElement('main',{className:'composer-preview'},
            React.createElement('header',{className:'composer-preview-header'},React.createElement('h1',null,'Xangi 入力連携テスト'),React.createElement('p',null,'テスト用の入力拡張と実際のChatPaneを組み合わせて表示します。'),React.createElement('p',null,'汎用のテキスト入力拡張を模擬します。この画面から実際のAIへは送信しません。')),
            React.createElement('div',{className:'composer-preview-body'},React.createElement(ChatPane,{composerExtensions:enabled?[{id:'test-input',displayName:'入力連携'}]:[],pane:{key:'composer-test',sessionId:session},active:true,config:{uploadAccept:null,uploadMaxBytes:67108864,allowedBackends:[],completionShowElapsed:true},refreshVersion:0,onFocus:noop,onClose:noop,onSessionChange:noop,onBusyChange:noop,onSessionsInvalidated:async()=>{},onComplete:noop,onAbortReady:noop})))}
          createRoot(document.getElementById('root')).render(React.createElement(Preview));
          </script></body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await server.transformIndexHtml('/composer-test', html));
      });
    },
  };
  const vite = await createServer({
    configFile: false,
    root,
    base: '/',
    plugins: [react(), plugin],
    server: { host, port, strictPort: true, allowedHosts },
    logLevel: 'error',
  });
  await vite.listen();
  const address = vite.httpServer.address();
  return {
    url: `http://localhost:${address.port}/composer-test`,
    requests,
    close: async () => {
      vite.httpServer.closeAllConnections();
      await vite.close();
      extension.closeAllConnections();
      await new Promise((done) => extension.close(done));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const preview = await createComposerPreview({
    port: Number(process.env.COMPOSER_PREVIEW_PORT || 5173),
    allowedHosts: (process.env.COMPOSER_PREVIEW_ALLOWED_HOSTS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
  console.log(`Voice input preview: ${preview.url}`);
  const close = () => void preview.close().then(() => process.exit());
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
