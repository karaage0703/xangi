import { describe, expect, it } from 'vitest';
import { buildXangiCommands } from '../src/prompts/xangi-commands.js';

describe('schedule discovery in agent prompts', () => {
  it.each([undefined, 'discord', 'slack', 'line', 'telegram', 'web'] as const)(
    'provides schedule help and result verification for %s',
    (platform) => {
      const prompt = buildXangiCommands(platform);
      expect(prompt).toContain('xangi tool help schedule_add');
      expect(prompt).toContain('実行結果を確認してから登録完了');
      expect(prompt).toContain('失敗時は実際のエラー');
    }
  );
});
