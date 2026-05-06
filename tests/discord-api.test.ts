import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveHistoryChannelId } from '../src/cli/discord-api.js';
import { ValidationError } from '../src/errors.js';

describe('resolveHistoryChannelId', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.XANGI_CHANNEL_ID;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.XANGI_CHANNEL_ID;
    } else {
      process.env.XANGI_CHANNEL_ID = savedEnv;
    }
  });

  // ─── 経路 1: bin/xangi-cmd 経由 (context が必ず付く) ─────────────────────

  it('uses context.channelId when xangi上で実行中 (bin/xangi-cmd 経由)', () => {
    // bin/xangi-cmd は XANGI_CHANNEL_ID を読んで context.channelId に詰めて
    // tool-server に POST する。tool-server は context を渡して discordApi を呼ぶ。
    process.env.XANGI_CHANNEL_ID = 'env-channel-leak'; // 親プロセスの env
    const result = resolveHistoryChannelId({}, { channelId: 'context-channel-actual' });
    expect(result).toBe('context-channel-actual');
  });

  it('does NOT fall back to env when context is provided but channelId missing', () => {
    // 「context: {}」で叩かれた場合、env が leak しないこと（誤投稿防止）
    process.env.XANGI_CHANNEL_ID = 'env-channel-leak';
    expect(() => resolveHistoryChannelId({}, {})).toThrow(ValidationError);
    expect(() => resolveHistoryChannelId({}, {})).toThrow(/channel が未指定/);
  });

  // ─── 経路 2: CLI 単体実行 (context が undefined) ────────────────────────

  it('falls back to env XANGI_CHANNEL_ID when context is undefined (CLI 単体実行)', () => {
    process.env.XANGI_CHANNEL_ID = 'cli-env-channel';
    const result = resolveHistoryChannelId({});
    expect(result).toBe('cli-env-channel');
  });

  it('throws when context is undefined and env is empty', () => {
    delete process.env.XANGI_CHANNEL_ID;
    expect(() => resolveHistoryChannelId({})).toThrow(ValidationError);
    expect(() => resolveHistoryChannelId({})).toThrow(/channel が未指定/);
  });

  // ─── 共通: --channel フラグは常に最優先 ─────────────────────────────────

  it('--channel flag takes precedence over both context and env', () => {
    process.env.XANGI_CHANNEL_ID = 'env-channel';
    const result = resolveHistoryChannelId(
      { channel: 'flag-channel' },
      { channelId: 'context-channel' }
    );
    expect(result).toBe('flag-channel');
  });

  it('--channel flag works without any context or env', () => {
    delete process.env.XANGI_CHANNEL_ID;
    const result = resolveHistoryChannelId({ channel: 'flag-only' });
    expect(result).toBe('flag-only');
  });
});
