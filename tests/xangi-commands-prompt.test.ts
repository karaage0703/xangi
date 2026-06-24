import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildXangiCommands, XANGI_COMMANDS_TRIGGER } from '../src/prompts/xangi-commands.js';

const TRIGGER_HEADING = '## イベントトリガー（完了時に自分を起こす）';

describe('buildXangiCommands trigger section', () => {
  const original = process.env.TRIGGER_ENABLED;

  beforeEach(() => {
    delete process.env.TRIGGER_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRIGGER_ENABLED;
    } else {
      process.env.TRIGGER_ENABLED = original;
    }
  });

  it('TRIGGER_ENABLED 未設定なら trigger セクションを注入しない', () => {
    expect(buildXangiCommands('discord')).not.toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=false なら注入しない', () => {
    process.env.TRIGGER_ENABLED = 'false';
    expect(buildXangiCommands('discord')).not.toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=true なら discord に注入する', () => {
    process.env.TRIGGER_ENABLED = 'true';
    const prompt = buildXangiCommands('discord');
    expect(prompt).toContain(TRIGGER_HEADING);
    expect(prompt).toContain('xangi-cmd trigger');
  });

  it('TRIGGER_ENABLED=true なら slack にも注入する', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('slack')).toContain(TRIGGER_HEADING);
  });

  it('discord にはセッション再開時の履歴取得指示を注入する', () => {
    const prompt = buildXangiCommands('discord');
    expect(prompt).toContain('## セッション再開時の文脈把握（重要）');
    expect(prompt).toContain('xangi-cmd discord_history --count 10');
  });

  it('slack には Discord 履歴取得コマンドを注入しない', () => {
    const prompt = buildXangiCommands('slack');
    expect(prompt).not.toContain('xangi-cmd discord_history --count 10');
    expect(prompt).toContain('SlackチャンネルIDはDiscord snowflakeではありません');
  });

  it('TRIGGER_ENABLED=true なら platform 未指定 (後方互換) にも注入する', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands()).toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=true でも web には注入しない (トリガーの投稿先にできない)', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('web')).not.toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=true でも line には注入しない', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('line')).not.toContain(TRIGGER_HEADING);
  });

  it('セクション本文に失敗時も発火させる `;` 区切りの案内がある', () => {
    expect(XANGI_COMMANDS_TRIGGER).toContain('`;` にする');
    expect(XANGI_COMMANDS_TRIGGER).toContain('--source');
  });
});

describe('buildXangiCommands discord formatting section', () => {
  it('discord には番号付き見出し直下の箇条書きインデント案内を含める', () => {
    const prompt = buildXangiCommands('discord');

    expect(prompt).toContain('## Discord表示フォーマット');
    expect(prompt).toContain('番号付き見出しの直下に箇条書きを置く場合');
    expect(prompt).toContain('   - 詳細');
  });

  it('discord 以外には Discord 表示フォーマット案内を含めない', () => {
    expect(buildXangiCommands('web')).not.toContain('## Discord表示フォーマット');
    expect(buildXangiCommands('line')).not.toContain('## Discord表示フォーマット');
  });
});
