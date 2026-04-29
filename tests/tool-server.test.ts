import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startToolServer, stopToolServer } from '../src/tool-server.js';

/**
 * tool-server のステータスコード退行検出テスト。
 *
 * 過去にバリデーションエラー（クライアント入力ミス）も内部例外も
 * 一律 HTTP 500 で返していた。今は ValidationError → 400、
 * その他 → 500 の区別がある。これが退行しないことを保証する。
 */
describe('tool-server HTTP status codes', () => {
  let serverUrl: string;

  beforeAll(() => {
    // 親シェルから引き継いだ XANGI_TOOL_SERVER を捨てる（実機xangiのURLを誤って叩かないため）
    delete process.env.XANGI_TOOL_SERVER;
    startToolServer();
    // listen() コールバック内で XANGI_TOOL_SERVER が再設定される。それを待つ
    return new Promise<void>((resolve) => {
      const wait = () => {
        if (process.env.XANGI_TOOL_SERVER) {
          serverUrl = process.env.XANGI_TOOL_SERVER;
          resolve();
        } else {
          setTimeout(wait, 10);
        }
      };
      wait();
    });
  });

  afterAll(() => {
    stopToolServer();
  });

  it('returns 400 for ValidationError (channel未指定 in discord_history)', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_history',
        flags: { count: '3' },
        context: {}, // channelId 未指定
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('channel が未指定');
  });

  it('returns 400 for unknown command', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_nonexistent',
        flags: {},
        context: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('Unknown discord command');
  });

  it('returns 400 for missing required flag (discord_send without --message)', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_send',
        flags: { channel: '12345' }, // message 欠如
        context: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('--message is required');
  });

  it('returns 400 when command is missing', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flags: {}, context: {} }),
    });

    expect(res.status).toBe(400);
  });
});
