/**
 * inter-instance-chat の HTTP API ハンドラ群。
 *
 * 既存の web-chat の HTTP server に「相乗り」する形で組み込む。
 * web-chat の createServer の中でこの handler 群を順に試して、
 * 該当しなければ素通しする。
 *
 * エンドポイント:
 *   GET  /inter-chat                  → web/inter-chat.html
 *   GET  /api/inter-chat/config       → 設定（selfId, ttl, ...）
 *   GET  /api/inter-chat/messages     → 全メッセージ（TTL内、ts昇順）
 *   POST /api/inter-chat/send         → 自分の jsonl に追記、{ text, from_label?, origin_chain? }
 *   GET  /api/inter-chat/stream       → SSE。新着メッセージを流す
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getInterChatConfig,
  sendMessage,
  readRecent,
  onMessage,
  isStarted,
  deleteOwnMessage,
  clearOwnMessages,
  type InterChatMessage,
} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** リクエスト本文を読み出す（小さい JSON 想定） */
function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(body));
}

/**
 * 戻り値:
 *   true  — このハンドラがレスポンスを返した（呼び出し元はそのまま return すべき）
 *   false — このリクエストは inter-chat 担当外（素通しする）
 */
export async function handleInterChatRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const rawUrl = req.url || '/';
  const url = rawUrl.split('?')[0];

  // HTML page
  if (url === '/inter-chat' || url === '/inter-chat/') {
    try {
      // dist/inter-instance-chat/ から見ると ../../web/inter-chat.html
      const candidates = [
        join(__dirname, '..', '..', 'web', 'inter-chat.html'),
        join(__dirname, '..', '..', '..', 'web', 'inter-chat.html'),
      ];
      let html: string | null = null;
      for (const p of candidates) {
        try {
          html = readFileSync(p, 'utf-8');
          break;
        } catch {
          // try next
        }
      }
      if (!html) {
        res.writeHead(500);
        res.end('web/inter-chat.html not found');
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }

  if (!url.startsWith('/api/inter-chat')) return false;

  const cfg = getInterChatConfig();
  if (!cfg.enabled) {
    jsonResponse(res, 503, {
      error: 'inter-instance-chat is disabled',
      hint: 'Set INTER_INSTANCE_CHAT_ENABLED=true to enable',
    });
    return true;
  }

  // GET /api/inter-chat/config
  if (req.method === 'GET' && url === '/api/inter-chat/config') {
    jsonResponse(res, 200, {
      enabled: cfg.enabled,
      selfInstanceId: cfg.selfInstanceId,
      selfLabel: cfg.selfLabel,
      dir: cfg.dir,
      ttlSec: cfg.ttlSec,
      compactIntervalSec: cfg.compactIntervalSec,
      usePolling: cfg.usePolling,
      started: isStarted(),
    });
    return true;
  }

  // GET /api/inter-chat/messages
  if (req.method === 'GET' && url === '/api/inter-chat/messages') {
    const messages = readRecent();
    jsonResponse(res, 200, { messages });
    return true;
  }

  // DELETE /api/inter-chat/messages/<msg_id> — 自分のメッセージ1件削除
  if (req.method === 'DELETE' && url.startsWith('/api/inter-chat/messages/')) {
    const msgId = decodeURIComponent(url.slice('/api/inter-chat/messages/'.length));
    if (!msgId) {
      jsonResponse(res, 400, { error: 'msg_id is required' });
      return true;
    }
    try {
      const removed = deleteOwnMessage(msgId);
      if (removed === 0) {
        // 自分のファイルにその msg_id がない（他インスタンス発 or 既に削除済）
        jsonResponse(res, 404, {
          error: 'message not found in own jsonl',
          hint: 'other-instance messages cannot be deleted (single writer)',
        });
        return true;
      }
      jsonResponse(res, 200, { removed });
    } catch (e) {
      jsonResponse(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // DELETE /api/inter-chat/messages?scope=self — 自分の全消去（scope=self 必須、誤爆防止）
  if (req.method === 'DELETE' && url === '/api/inter-chat/messages') {
    const params = new URLSearchParams(rawUrl.split('?')[1] || '');
    if (params.get('scope') !== 'self') {
      jsonResponse(res, 400, {
        error: 'scope=self is required',
        hint: 'only self instance jsonl can be cleared',
      });
      return true;
    }
    try {
      const removed = clearOwnMessages();
      jsonResponse(res, 200, { removed });
    } catch (e) {
      jsonResponse(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // POST /api/inter-chat/send
  if (req.method === 'POST' && url === '/api/inter-chat/send') {
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) {
        jsonResponse(res, 400, { error: 'text is required' });
        return true;
      }
      const from_label = typeof body.from_label === 'string' ? body.from_label : undefined;
      const origin_chain = Array.isArray(body.origin_chain)
        ? body.origin_chain.filter((s): s is string => typeof s === 'string')
        : undefined;
      const message = sendMessage(text, { from_label, origin_chain });
      jsonResponse(res, 200, { message });
    } catch (e) {
      jsonResponse(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // GET /api/inter-chat/stream — SSE
  if (req.method === 'GET' && url === '/api/inter-chat/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': inter-chat stream\n\n');

    const send = (msg: InterChatMessage): void => {
      try {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      } catch {
        // ignore (closed)
      }
    };

    const unsubscribe = onMessage((msg) => send(msg));

    // keepalive
    const ka = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        // ignore
      }
    }, 30000);
    ka.unref();

    req.on('close', () => {
      unsubscribe();
      clearInterval(ka);
    });
    return true;
  }

  // 該当しない /api/inter-chat/* → 404
  jsonResponse(res, 404, { error: `not found: ${url}` });
  return true;
}
