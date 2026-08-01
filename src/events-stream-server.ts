/**
 * Pull 型 events 配信用の SSE エンドポイント。
 *
 * web-chat の HTTP サーバに「相乗り」する形で `GET /api/events/stream` を
 * ハンドルする。consumer (デスクトップアバター・可視化ツール等) はこの URL に
 * 接続して、xangi の応答ライフサイクル (turn.started / message.delta /
 * turn.complete / turn.aborted / agent.error) を受け取る。
 *
 * 設計:
 * - 基本は全イベントをブロードキャストする。`thread_id` queryを指定した接続は
 *   サーバ側でthreadを絞り、instance_id等はconsumer側でself-filterする。
 * - 30 秒ごとに `: keepalive` コメント行を流して中継 proxy の idle 切断を防ぐ。
 * - クライアント切断 (req close / error) を検知したら subscriber を解除して
 *   keepalive timer を止める。
 * - 接続直後に現在の instance_id / host_hint を `event: ready` の形で 1 度流す
 *   (consumer の initial UI 構築 / self-filter 設定用)。
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { subscribeEvents, getEventsConfig, type PublishedEvent } from './events-emitter.js';

const KEEPALIVE_MS = 30_000;

/**
 * 戻り値:
 *   true  — このハンドラがレスポンスを返した (呼び出し元はそのまま return すべき)
 *   false — このリクエストは events-stream 担当外 (素通しする)
 */
export function handleEventsStreamRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const rawUrl = req.url || '/';
  const parsedUrl = new URL(rawUrl, 'http://xangi.local');
  const url = parsedUrl.pathname;
  const threadFilter =
    parsedUrl.searchParams.get('thread_id') || parsedUrl.searchParams.get('threadId') || '';

  if (req.method !== 'GET' || url !== '/api/events/stream') {
    return false;
  }

  const cfg = getEventsConfig();
  if (!cfg.enabled) {
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(
      JSON.stringify({
        error: 'events emission is disabled',
        hint: 'Set XANGI_EVENTS_ENABLED=true (default) to enable',
      })
    );
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // nginx / Cloudflare 等の中継 proxy 越しでもストリームを止めない。
    'X-Accel-Buffering': 'no',
  });

  // 接続確立を即時に伝える (consumer 側の onopen トリガ用)。
  res.write(': events stream\n\n');
  res.write(
    `event: ready\ndata: ${JSON.stringify({
      instance_id: cfg.instanceId,
      host_hint: cfg.hostHint,
      thread_id: threadFilter || undefined,
    })}\n\n`
  );

  const writeEvent = (payload: PublishedEvent): void => {
    if (threadFilter && payload.thread_id !== threadFilter) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // ソケットが既に閉じている場合などは無視。close ハンドラ側で掃除する。
    }
  };

  const unsubscribe = subscribeEvents(writeEvent);

  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // ignore
    }
  }, KEEPALIVE_MS);
  keepalive.unref();

  const cleanup = (): void => {
    unsubscribe();
    clearInterval(keepalive);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  return true;
}
