/**
 * Web チャット UI — 複数スレッド並存・並列ストリーミング対応版
 *
 * 各 Web セッションは contextKey = `web-chat:<appSessionId>` で独立。
 * 同時に複数のセッションを保持・操作できる。
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentRunner } from './agent-runner.js';
import {
  getSession,
  setSession,
  ensureSession,
  listAllSessions,
  getSessionEntry,
  getActiveSessionId,
  updateSessionTitle,
  incrementMessageCount,
  createWebSession,
  setProviderSessionId,
  removeSession,
  setAutoTalk,
  WEB_CHAT_CONTEXT_PREFIX,
} from './sessions.js';
import { readSessionMessages } from './transcript-logger.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { deriveTitleFromFirstMessage, stripPromptMetadata } from './session-title.js';
import { handleInterChatRequest } from './inter-instance-chat/web-server.js';
import { flowFromHostPlatform, getInterChatConfig } from './inter-instance-chat/index.js';
import { setupAutoTalk } from './inter-instance-chat/auto-talk.js';
import { resolveAccessUrls, formatAccessUrls } from './access-urls.js';
import { handleEventsStreamRequest } from './events-stream-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PORT = 18888;

/** appSessionId に対応する contextKey を返す */
function webContextKey(appSessionId: string): string {
  return `${WEB_CHAT_CONTEXT_PREFIX}${appSessionId}`;
}

/** appSessionId が web セッションかどうか */
function isWebSession(appSessionId: string): boolean {
  const entry = getSessionEntry(appSessionId);
  return entry?.platform === 'web';
}

/** resume 後の最初のメッセージで履歴注入を行う対象 appSessionId */
const pendingHistoryInjections = new Set<string>();

/** 同一 appSessionId への並行送信を抑止するためのビジー集合 */
const busySessions = new Set<string>();

interface WebChatOptions {
  agentRunner: AgentRunner;
  port?: number;
}

export function startWebChat(options: WebChatOptions): void {
  const { agentRunner } = options;
  const port = options.port || parseInt(process.env.WEB_CHAT_PORT || String(DEFAULT_PORT), 10);
  const workdir = process.env.WORKSPACE_PATH || process.cwd();

  // 自走モード（auto-talk）の準備。inter-chat 有効時のみ実体起動。
  const autoTalkHandle = getInterChatConfig().enabled ? setupAutoTalk({ agentRunner }) : null;

  const server = createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const url = rawUrl.split('?')[0];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // inter-instance-chat の HTML / API は専用ハンドラに委譲
    if (url === '/inter-chat' || url === '/inter-chat/' || url.startsWith('/api/inter-chat')) {
      try {
        const handled = await handleInterChatRequest(req, res);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    // events SSE pull (consumer がここに繋ぎに来る)
    if (url === '/api/events/stream') {
      try {
        const handled = handleEventsStreamRequest(req, res);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    if (url === '/' || url === '/index.html') {
      try {
        const htmlPath = join(__dirname, '..', 'web', 'index.html');
        const html = readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('web/index.html not found');
      }
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // GET /api/sessions — セッション一覧
    if (url === '/api/sessions' && req.method === 'GET') {
      // managed: sessions.json に登録された非アーカイブセッション。
      // タイトルが空なら最初のユーザーメッセージから導出し、それも無ければ
      // contextKey をそのまま見せる（Discord/Slack はチャンネル ID、Web は web-chat:<id>）。
      const managed = listAllSessions().map((s) => ({
        id: s.id,
        title: s.title || deriveTitleFromFirstMessage(workdir, s.id) || s.contextKey,
        platform: s.platform,
        contextKey: s.contextKey,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        // 🟢 = サーバ側で runner プロセスが pool に居る + そのセッションが
        // contextKey の current（Web は contextKey が appSessionId 個別なので常に current）
        isActive:
          Boolean(s.contextKey && agentRunner.hasRunner?.(s.contextKey)) &&
          (s.platform === 'web' || getActiveSessionId(s.contextKey) === s.id),
        autoTalk: s.autoTalk === true,
        autoTalkActive: autoTalkHandle?.isActive(s.id) ?? false,
      }));
      const managedIds = new Set(managed.map((s) => s.id));

      // logs/sessions/ ディレクトリにしか痕跡が無いセッション（移行・剪定済み）も拾う。
      // managed に同じ id があれば既に出してるのでスキップ。
      const sessionsDir = join(workdir, 'logs', 'sessions');
      const unmanaged: typeof managed = [];
      if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const id = file.replace('.jsonl', '');
          if (managedIds.has(id)) continue;
          const filePath = join(sessionsDir, file);
          const stat = statSync(filePath);
          const title = deriveTitleFromFirstMessage(workdir, id);
          if (!title) continue; // 本文が抽出できないログは出さない
          unmanaged.push({
            id,
            title,
            platform: 'discord',
            contextKey: '',
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            messageCount: 0,
            isActive: false,
            autoTalk: false,
            autoTalkActive: false,
          });
        }
      }

      unmanaged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const sessions = [...managed, ...unmanaged];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // GET /api/sessions/:id — セッション詳細
    if (url.startsWith('/api/sessions/') && !url.includes('/resume') && req.method === 'GET') {
      const appSessionId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const entry = getSessionEntry(appSessionId);
      const messages = readSessionMessages(workdir, appSessionId).map((m) => {
        const isObj = typeof m.content === 'object' && m.content !== null;
        const obj = isObj ? (m.content as Record<string, unknown>) : {};
        return {
          id: m.id,
          role: m.role,
          content: isObj ? (obj.result ?? JSON.stringify(m.content)) : m.content,
          createdAt: m.createdAt,
          usage: isObj
            ? {
                num_turns: obj.num_turns,
                duration_ms: obj.duration_ms,
                total_cost_usd: obj.total_cost_usd,
              }
            : undefined,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: appSessionId,
          title:
            entry?.title ||
            messages
              .find((m) => m.role === 'user')
              ?.content?.toString()
              .slice(0, 50) ||
            appSessionId,
          platform: entry?.platform,
          messages,
        })
      );
      return;
    }

    // PATCH /api/sessions/:id — タイトル変更
    if (url.startsWith('/api/sessions/') && req.method === 'PATCH') {
      const appSessionId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const body = await readBody(req);
      if (body.title) {
        updateSessionTitle(appSessionId, body.title);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/sessions — 新規 Web セッション（既存セッションはそのまま並存）
    if (url === '/api/sessions' && req.method === 'POST') {
      const newAppId = createWebSession({});
      console.log(`[web-chat] Created new web session ${newAppId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: newAppId }));
      return;
    }

    // POST /api/sessions/:id/resume — 既存セッションの内容を引き継いだ新 Web セッションを作る
    if (url.match(/^\/api\/sessions\/[^/]+\/resume$/) && req.method === 'POST') {
      const sourceId = decodeURIComponent(url.replace('/api/sessions/', '').replace('/resume', ''));
      const sourceEntry = getSessionEntry(sourceId);
      const providerSid = sourceEntry?.agent?.providerSessionId;

      const newAppId = createWebSession({
        title: sourceEntry?.title ? `${sourceEntry.title} (resumed)` : '',
      });
      if (providerSid) {
        setSession(webContextKey(newAppId), providerSid);
      }
      // 次の最初のメッセージで履歴注入
      pendingHistoryInjections.add(newAppId);
      // resume 元の appSessionId を引き継いで履歴を引っ張る
      pendingHistoryInjections.add(sourceId);

      console.log(`[web-chat] Resumed session ${sourceId} into new web session ${newAppId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: newAppId, sourceId }));
      return;
    }

    // POST /api/sessions/:id/stop — ランナーだけ停止（セッションは残す）
    // Web/Discord/Slack 共通。entry.contextKey をそのまま runner pool のキーとして使う。
    if (url.match(/^\/api\/sessions\/[^/]+\/stop$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', '').replace('/stop', ''));
      const entry = getSessionEntry(targetId);
      let stopped = false;
      if (entry?.contextKey) {
        // 進行中の処理があれば cancel、その上で runner プロセスを破棄
        agentRunner.cancel?.(entry.contextKey);
        stopped = Boolean(agentRunner.destroy?.(entry.contextKey));
      }
      busySessions.delete(targetId);
      console.log(
        `[web-chat] Stopped runner for session ${targetId} ` +
          `(platform=${entry?.platform}, stopped=${stopped})`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stopped }));
      return;
    }

    // POST /api/sessions/:id/autotalk — 自走モード ON/OFF
    // body: { enabled: boolean }
    if (url.match(/^\/api\/sessions\/[^/]+\/autotalk$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(
        url.replace('/api/sessions/', '').replace('/autotalk', '')
      );
      const body = await readBody(req);
      const enabled = body.enabled === true;
      const entry = getSessionEntry(targetId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      if (entry.platform !== 'web') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'autotalk is only available for web sessions' }));
        return;
      }
      const interCfg = getInterChatConfig();
      if (!interCfg.enabled) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'INTER_INSTANCE_CHAT_ENABLED=true が必要です（自走発話は inter-chat に流れます）',
          })
        );
        return;
      }
      setAutoTalk(targetId, enabled);
      if (autoTalkHandle) {
        if (enabled) autoTalkHandle.enable(targetId);
        else autoTalkHandle.disable(targetId);
      }
      console.log(`[web-chat] autotalk ${enabled ? 'ON' : 'OFF'} for session ${targetId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          appSessionId: targetId,
          autoTalk: enabled,
          active: autoTalkHandle?.isActive(targetId) ?? false,
        })
      );
      return;
    }

    // DELETE /api/sessions/:id — セッション削除
    if (
      url.startsWith('/api/sessions/') &&
      !url.includes('/resume') &&
      !url.includes('/stop') &&
      !url.includes('/autotalk') &&
      req.method === 'DELETE'
    ) {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const entry = getSessionEntry(targetId);
      // ランナーも破棄（web セッションの場合のみ）
      if (entry?.platform === 'web') {
        agentRunner.destroy?.(webContextKey(targetId));
      }
      removeSession(targetId);
      pendingHistoryInjections.delete(targetId);
      busySessions.delete(targetId);

      const logPath = join(workdir, 'logs', 'sessions', `${targetId}.jsonl`);
      if (existsSync(logPath)) {
        const { unlinkSync } = await import('fs');
        unlinkSync(logPath);
      }

      console.log(`[web-chat] Deleted session ${targetId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/upload — ファイルアップロード
    if (url === '/api/upload' && req.method === 'POST') {
      try {
        const uploadDir = join(workdir, 'tmp', 'web-uploads');
        mkdirSync(uploadDir, { recursive: true });

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);

        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No boundary in content-type' }));
          return;
        }
        const boundary = '--' + boundaryMatch[1];
        const parts = body.toString('binary').split(boundary);

        const files: { name: string; path: string }[] = [];
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headers = part.slice(0, headerEnd);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          if (!filenameMatch) continue;

          const filename = filenameMatch[1];
          const ext = extname(filename).toLowerCase();
          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
          const filePath = join(uploadDir, safeName);

          const dataStart = headerEnd + 4;
          const dataEnd = part.length - 2;
          const fileData = Buffer.from(part.slice(dataStart, dataEnd), 'binary');
          writeFileSync(filePath, fileData);

          files.push({ name: filename, path: filePath });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
      } catch (err) {
        console.error('[web-chat] Upload error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload failed' }));
      }
      return;
    }

    if (url.startsWith('/api/files/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.replace('/api/files/', ''));
      const filePath = join(workdir, 'tmp', 'web-uploads', filename);
      if (!existsSync(filePath) || filename.includes('..')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }

    if (url.startsWith('/api/workspace-file') && req.method === 'GET') {
      const urlObj = new URL(rawUrl, `http://${req.headers.host}`);
      const filePath = urlObj.searchParams.get('path') || '';
      if (!filePath || !filePath.startsWith(workdir) || filePath.includes('..')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }

    // POST /api/chat — メッセージ送信（SSE）
    // body: { appSessionId?: string, message: string }
    if (url === '/api/chat' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const message = (body.message || '').toString();

        if (!message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        // appSessionId 解決
        let appSessionId: string = (body.appSessionId || '').toString().trim();
        if (!appSessionId) {
          // 後方互換: 最後に更新された web セッションを使う、なければ新規作成
          const latestWeb = listAllSessions().find((s) => s.platform === 'web');
          appSessionId = latestWeb?.id || createWebSession({});
        }

        // entry 確認 / web 以外への送信は弾く
        const entry = getSessionEntry(appSessionId);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Session ${appSessionId} not found` }));
          return;
        }
        if (entry.platform !== 'web') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `Session ${appSessionId} is not a web session (platform: ${entry.platform}). Use the resume endpoint to fork it.`,
            })
          );
          return;
        }

        // 並行送信ロック
        if (busySessions.has(appSessionId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session is busy' }));
          return;
        }
        busySessions.add(appSessionId);

        try {
          const ctxKey = webContextKey(appSessionId);
          // 安全網: contextKey と active が紐付いていることを保証
          ensureSession(ctxKey, { platform: 'web' });
          const sessionId = getSession(ctxKey);

          // 履歴注入（resume 直後の初回送信）
          let historyContext = '';
          if (pendingHistoryInjections.has(appSessionId)) {
            const pastMessages = readSessionMessages(workdir, appSessionId);
            const recent = pastMessages.slice(-10);
            if (recent.length > 0) {
              const lines = recent
                .map((m) => {
                  const content =
                    typeof m.content === 'object'
                      ? ((m.content as Record<string, unknown>).result as string) || ''
                      : String(m.content);
                  const cleaned = stripPromptMetadata(content);
                  return `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${cleaned.slice(0, 200)}`;
                })
                .join('\n');
              historyContext = `\n[以下はこのセッションの直近の会話履歴です。この文脈を踏まえて返答してください]\n${lines}\n[履歴ここまで]\n\n`;
            }
            pendingHistoryInjections.delete(appSessionId);
          }

          const prompt = `[プラットフォーム: Web]\n${historyContext}${message}`;

          console.log(`[web-chat] Message (session ${appSessionId}): ${message.slice(0, 100)}`);

          // INTER_INSTANCE_CHAT_ENABLED=true なら自分の jsonl にも流す（他 xangi へ伝播）
          flowFromHostPlatform(message, 'user');

          const threadId = threadIdFor('web', appSessionId);
          const turnId = turnIdFor('web', `${Date.now()}`);
          const sessionTitle = getSessionEntry(appSessionId)?.title;
          const threadLabel = sessionTitle || 'Browser session';
          const eventCtx = {
            threadId,
            turnId,
            threadLabel,
            platform: 'web' as const,
            userText: message,
          };

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });

          const sendSSE = (event: string, data: unknown) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          try {
            const result = await runWithBubbleEvents(
              agentRunner,
              prompt,
              eventCtx,
              {
                onText: (_chunk, fullText) => {
                  sendSSE('text', { fullText });
                },
                onToolUse: (toolName, toolInput) => {
                  const inputSummary =
                    Object.keys(toolInput).length > 0
                      ? ` ${JSON.stringify(toolInput).slice(0, 100)}`
                      : '';
                  sendSSE('tool', { toolName, inputSummary });
                },
                onComplete: (completedResult) => {
                  setProviderSessionId(appSessionId, completedResult.sessionId);
                  setSession(ctxKey, completedResult.sessionId);
                  incrementMessageCount(appSessionId);

                  const e = getSessionEntry(appSessionId);
                  if (!e?.title) {
                    updateSessionTitle(appSessionId, message.slice(0, 50));
                  }

                  // INTER_INSTANCE_CHAT_ENABLED=true なら agent 応答も自分の jsonl に流す
                  flowFromHostPlatform(completedResult.result, 'agent');
                },
                onError: (error) => {
                  sendSSE('error', { message: error.message });
                },
              },
              {
                sessionId,
                channelId: ctxKey,
                appSessionId,
              }
            );

            const msgs = readSessionMessages(workdir, appSessionId);
            const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
            const usageObj =
              lastAssistant && typeof lastAssistant.content === 'object'
                ? (lastAssistant.content as Record<string, unknown>)
                : {};
            const usage = {
              num_turns: usageObj.num_turns,
              duration_ms: usageObj.duration_ms,
              total_cost_usd: usageObj.total_cost_usd,
            };

            sendSSE('done', {
              response: result.result,
              sessionId: appSessionId,
              usage,
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            sendSSE('error', { message: errorMsg });
          }
          res.end();
        } finally {
          busySessions.delete(appSessionId);
        }
      } catch (err) {
        console.error('[web-chat] Error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web-chat] Chat UI: http://localhost:${port}`);
    // Tailscale が動いてれば LAN/Tailnet 経由のアクセス URL も出す（best-effort）
    resolveAccessUrls(port)
      .then((urls) => {
        console.log(formatAccessUrls('web-chat', urls));
        // pull 型 events SSE の URL も併せて出す。consumer (pet 等) はこれに繋ぐ。
        const eventsUrls = urls.map((u) => `${u}/api/events/stream`);
        console.log(formatAccessUrls('xangi-events (SSE)', eventsUrls));
      })
      .catch(() => {
        // resolveAccessUrls 内で握り潰すが念のため
      });
  });
}

// 単体テストから参照される
export const __test__ = {
  pendingHistoryInjections,
  busySessions,
  webContextKey,
  isWebSession,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readBody(req: import('http').IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
