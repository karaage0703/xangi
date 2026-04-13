/**
 * WebチャットUI — ChatGPT風サイドバー付き
 *
 * ブラウザからlocalhost:PORT にアクセスしてAIとチャット。
 * セッション単位のログ（logs/sessions/<appSessionId>.jsonl）で管理。
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentRunner } from './agent-runner.js';
import {
  getSession,
  setSession,
  deleteSession,
  ensureSession,
  listAllSessions,
  getSessionEntry,
  getActiveSessionId,
  updateSessionTitle,
  incrementMessageCount,
  createSession,
  setProviderSessionId,
  activateSession,
  removeSession,
} from './sessions.js';
import { readSessionMessages } from './transcript-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PORT = 18888;
const WEB_CHANNEL_ID = 'web-chat';

// resume後の最初のメッセージにセッション履歴を注入するためのフラグ
let resumedAppSessionId: string | null = null;

interface WebChatOptions {
  agentRunner: AgentRunner;
  port?: number;
}

export function startWebChat(options: WebChatOptions): void {
  const { agentRunner } = options;
  const port = options.port || parseInt(process.env.WEB_CHAT_PORT || String(DEFAULT_PORT), 10);
  const workdir = process.env.WORKSPACE_PATH || process.cwd();

  const server = createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const url = rawUrl.split('?')[0];

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 静的ファイル配信
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

    // ヘルスチェック
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // GET /api/sessions — セッション一覧
    if (url === '/api/sessions' && req.method === 'GET') {
      // sessions.jsonに登録されてるセッション（タイトルが意味のないものは除外）
      const managed = listAllSessions()
        .filter((s) => {
          const t = s.title || s.contextKey;
          return t && !/^\d{10,}$/.test(t);
        })
        .map((s) => ({
          id: s.id,
          title: s.title || s.contextKey,
          platform: s.platform,
          contextKey: s.contextKey,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
          isActive: getActiveSessionId(s.contextKey) === s.id,
        }));
      const managedIds = new Set(managed.map((s) => s.id));

      // logs/sessions/ ディレクトリのログファイルも含める（移行データ等）
      const sessionsDir = join(workdir, 'logs', 'sessions');
      const unmanaged: typeof managed = [];
      if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const id = file.replace('.jsonl', '');
          if (managedIds.has(id)) continue;
          const filePath = join(sessionsDir, file);
          const stat = statSync(filePath);
          // 最初の行からタイトルを取得
          let title = id;
          try {
            const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0];
            if (firstLine) {
              const entry = JSON.parse(firstLine);
              if (entry.role === 'user' && typeof entry.content === 'string') {
                title = entry.content
                  .replace(/^\[プラットフォーム: [^\]]*\]\n?/, '')
                  .replace(/^\[チャンネル: [^\]]*\]\n?/, '')
                  .replace(/^\[発言者: [^\]]*\]\n?/, '')
                  .replace(/^\[現在時刻: [^\]]*\]\n?/, '')
                  .trim()
                  .slice(0, 50);
              }
            }
          } catch {
            /* ignore */
          }
          // タイトルが意味のないもの（チャンネルID、空、IDのまま）はスキップ
          if (!title || title === id || /^\d{10,}$/.test(title)) continue;
          unmanaged.push({
            id,
            title,
            platform: 'discord',
            contextKey: '',
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            messageCount: 0,
            isActive: false,
          });
        }
      }

      // managedを先に、unmanagedを更新日時降順で
      unmanaged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const sessions = [...managed, ...unmanaged];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // GET /api/sessions/:id — セッション詳細（メッセージ一覧）
    if (url.startsWith('/api/sessions/') && req.method === 'GET') {
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

    // POST /api/sessions — 新規セッション
    if (url === '/api/sessions' && req.method === 'POST') {
      agentRunner.destroy?.(WEB_CHANNEL_ID);
      deleteSession(WEB_CHANNEL_ID);
      const newAppId = createSession(WEB_CHANNEL_ID, { platform: 'web' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: newAppId }));
      return;
    }

    // POST /api/sessions/:id/resume — セッション再開
    if (url.match(/^\/api\/sessions\/[^/]+\/resume$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', '').replace('/resume', ''));
      const entry = getSessionEntry(targetId);
      const providerSid = entry?.agent?.providerSessionId;

      // activeByContextを切り替え（ランナーは破棄しない = プロセスの文脈を維持）
      if (providerSid) {
        setSession(WEB_CHANNEL_ID, providerSid);
      }
      activateSession(WEB_CHANNEL_ID, targetId);
      resumedAppSessionId = targetId;

      console.log(`[web-chat] Resumed session ${targetId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: targetId }));
      return;
    }

    // DELETE /api/sessions/:id — セッション削除
    if (url.startsWith('/api/sessions/') && !url.includes('/resume') && req.method === 'DELETE') {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', ''));
      removeSession(targetId);

      // ログファイルも削除
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

        // multipart/form-data をパース（簡易実装）
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

          // バイナリデータを取り出し（末尾の\r\nを除去）
          const dataStart = headerEnd + 4;
          const dataEnd = part.length - 2; // trailing \r\n
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

    // GET /api/files/* — アップロード済みファイルを配信
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

    // GET /api/workspace-file?path= — ワークスペース内ファイルを配信（MEDIA:表示用）
    if (url.startsWith('/api/workspace-file') && req.method === 'GET') {
      const urlObj = new URL(rawUrl, `http://${req.headers.host}`);
      const filePath = urlObj.searchParams.get('path') || '';
      // セキュリティ: ワークスペース内のファイルのみ許可
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

    // POST /api/chat — メッセージ送信（SSEストリーミング）
    if (url === '/api/chat' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const message = body.message || '';

        if (!message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        console.log(`[web-chat] Message: ${message.slice(0, 100)}`);

        const appSessionId = ensureSession(WEB_CHANNEL_ID, { platform: 'web' });
        const sessionId = getSession(WEB_CHANNEL_ID);

        // resume後の最初のメッセージ: 過去の会話履歴を注入
        let historyContext = '';
        if (resumedAppSessionId) {
          const pastMessages = readSessionMessages(workdir, resumedAppSessionId);
          // 直近10件の会話を要約として注入
          const recent = pastMessages.slice(-10);
          if (recent.length > 0) {
            const lines = recent
              .map((m) => {
                const content =
                  typeof m.content === 'object'
                    ? ((m.content as Record<string, unknown>).result as string) || ''
                    : String(m.content);
                const cleaned = content
                  .replace(/^\[プラットフォーム: [^\]]*\]\n?/m, '')
                  .replace(/^\[チャンネル: [^\]]*\]\n?/m, '')
                  .replace(/^\[発言者: [^\]]*\]\n?/m, '')
                  .replace(/^\[現在時刻: [^\]]*\]\n?/m, '')
                  .trim();
                return `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${cleaned.slice(0, 200)}`;
              })
              .join('\n');
            historyContext = `\n[以下はこのセッションの直近の会話履歴です。この文脈を踏まえて返答してください]\n${lines}\n[履歴ここまで]\n\n`;
          }
          resumedAppSessionId = null;
        }

        const prompt = `[プラットフォーム: Web]\n${historyContext}${message}`;

        // SSEヘッダー
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
          const result = await agentRunner.runStream(
            prompt,
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
                // providerSessionIdを後付け保存
                setProviderSessionId(appSessionId, completedResult.sessionId);
                setSession(WEB_CHANNEL_ID, completedResult.sessionId);
                incrementMessageCount(appSessionId);

                // 初回メッセージでタイトル自動設定
                const entry = getSessionEntry(appSessionId);
                if (!entry?.title) {
                  updateSessionTitle(appSessionId, message.slice(0, 50));
                }
              },
              onError: (error) => {
                sendSSE('error', { message: error.message });
              },
            },
            {
              sessionId,
              channelId: WEB_CHANNEL_ID,
              appSessionId,
            }
          );

          // 完了イベント（usage情報付き）
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
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readBody(req: import('http').IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
