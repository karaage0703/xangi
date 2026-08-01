import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildXangiCommands,
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_TRIGGER,
} from '../src/prompts/xangi-commands.js';

describe('buildXangiCommands', () => {
  const originalTriggerEnabled = process.env.TRIGGER_ENABLED;

  beforeEach(() => {
    delete process.env.TRIGGER_ENABLED;
  });

  afterEach(() => {
    if (originalTriggerEnabled === undefined) delete process.env.TRIGGER_ENABLED;
    else process.env.TRIGGER_ENABLED = originalTriggerEnabled;
  });

  it('操作マニュアルを常駐させずオンデマンドhelpへ誘導する', () => {
    const prompt = buildXangiCommands('discord');

    expect(prompt).toContain('xangi-cmd help <topic|command>');
    expect(prompt).not.toContain('毎日 9:00 おはよう');
    expect(prompt).not.toContain('xangi-cmd discord_send --channel');
    expect(prompt).not.toContain('./bin/xangi service start');
  });

  it('実行時に必要な長時間処理・自己再起動・モデル契約を残す', () => {
    expect(XANGI_COMMANDS_COMMON).toContain('ワークスペース指定の永続方式');
    expect(XANGI_COMMANDS_COMMON).toContain('xangi-cmd system_restart');
    expect(XANGI_COMMANDS_COMMON).toContain('xangi-cmd models --backend <backend>');
    expect(XANGI_COMMANDS_COMMON).toContain('--use <exact-model-id>');
    expect(XANGI_COMMANDS_COMMON).toContain('次のturnから適用');
    expect(XANGI_COMMANDS_COMMON).not.toContain('ユーザー向け操作方法');
  });

  it('platform固有ルールを混在させない', () => {
    const discord = buildXangiCommands('discord');
    const slack = buildXangiCommands('slack');
    const web = buildXangiCommands('web');

    expect(discord).toContain('## Discord固有ルール');
    expect(discord).not.toContain('## Slack固有ルール');
    expect(slack).toContain('## Slack固有ルール');
    expect(slack).not.toContain('## Discord固有ルール');
    expect(web).toContain('## Web固有ルール');
    expect(web).not.toContain('## Discord固有ルール');
    expect(web).not.toContain('## Slack固有ルール');
  });

  it('platform未指定では固有ルールを注入しない', () => {
    const prompt = buildXangiCommands();

    expect(prompt).toContain('## オンデマンドヘルプ');
    expect(prompt).not.toContain('## Discord固有ルール');
    expect(prompt).not.toContain('## Slack固有ルール');
    expect(prompt).not.toContain('## ファイル送信');
  });

  it('Discordの非自明な表示・全文取得・退出契約を残す', () => {
    const prompt = buildXangiCommands('discord');

    expect(prompt).toContain('3スペース以上字下げ');
    expect(prompt).toContain('discord_message');
    expect(prompt).toContain('Discord APIを直接curlしない');
    expect(prompt).toContain('discord_thread_leave');
  });

  it('LINEとTelegramの出力制約だけを簡潔に注入する', () => {
    const line = buildXangiCommands('line');
    const telegram = buildXangiCommands('telegram');

    expect(line).toContain('Markdownを描画しない');
    expect(line).toContain('MEDIA: 添付は使わず');
    expect(line).not.toContain('誤:');
    expect(telegram).toContain('4096文字');
    expect(telegram).toContain('MEDIA: 添付は使わない');
  });

  it('TRIGGER_ENABLED=trueの時だけDiscordとSlackとWebへtrigger契約を注入する', () => {
    expect(buildXangiCommands('discord')).not.toContain('## イベントトリガー');
    process.env.TRIGGER_ENABLED = 'true';

    expect(buildXangiCommands('discord')).toContain('## イベントトリガー');
    expect(buildXangiCommands('slack')).toContain('## イベントトリガー');
    expect(buildXangiCommands('web')).toContain('## イベントトリガー');
    expect(buildXangiCommands()).not.toContain('## イベントトリガー');
  });

  it('triggerは成功・失敗、状態保存、scheduleとの使い分けを保持する', () => {
    expect(XANGI_COMMANDS_TRIGGER).toContain('成功・失敗どちらでも');
    expect(XANGI_COMMANDS_TRIGGER).toContain('終了状態とログを保存');
    expect(XANGI_COMMANDS_TRIGGER).toContain('定刻確認はschedule');
  });

  it('TRIGGER_ENABLED=trueでもlineには注入しない', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('line')).not.toContain('## イベントトリガー');
  });

  it('常駐promptを操作マニュアルより十分小さく保つ', () => {
    expect(buildXangiCommands('discord').length).toBeLessThan(2_500);
    expect(buildXangiCommands('slack').length).toBeLessThan(2_000);
    expect(buildXangiCommands('web').length).toBeLessThan(1_600);
  });
});
