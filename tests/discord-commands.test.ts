import { describe, it, expect, vi } from 'vitest';
import { buildSlashCommands } from '../src/discord/slash-commands.js';
import type { Config } from '../src/config.js';
import type { Skill } from '../src/skills.js';

/**
 * annotateChannelMentions のテスト用に関数を再実装
 * （元の関数は startDiscord 内のローカル関数のため）
 */
function annotateChannelMentions(text: string): string {
  return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
}

/**
 * コードブロック判定のテスト用
 */
function isInCodeBlock(lines: string[], targetIndex: number): boolean {
  let inCodeBlock = false;
  for (let i = 0; i <= targetIndex; i++) {
    if (lines[i].trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }
  return inCodeBlock;
}

describe('Discord Commands', () => {
  describe('annotateChannelMentions', () => {
    it('should add channel ID annotation', () => {
      const input = '<#1234567890> に投稿して';
      const result = annotateChannelMentions(input);
      expect(result).toBe('<#1234567890> [チャンネルID: 1234567890] に投稿して');
    });

    it('should handle multiple channel mentions', () => {
      const input = '<#111> と <#222> に送って';
      const result = annotateChannelMentions(input);
      expect(result).toBe('<#111> [チャンネルID: 111] と <#222> [チャンネルID: 222] に送って');
    });

    it('should not modify text without channel mentions', () => {
      const input = '普通のテキスト';
      const result = annotateChannelMentions(input);
      expect(result).toBe('普通のテキスト');
    });

    it('should handle empty string', () => {
      const result = annotateChannelMentions('');
      expect(result).toBe('');
    });
  });

  describe('isInCodeBlock', () => {
    it('should detect code block', () => {
      const lines = ['text', '```', 'code', '```', 'text'];
      expect(isInCodeBlock(lines, 0)).toBe(false);
      expect(isInCodeBlock(lines, 2)).toBe(true);
      expect(isInCodeBlock(lines, 4)).toBe(false);
    });

    it('should handle nested code blocks', () => {
      const lines = ['```', 'code1', '```', 'text', '```', 'code2', '```'];
      expect(isInCodeBlock(lines, 1)).toBe(true);
      expect(isInCodeBlock(lines, 3)).toBe(false);
      expect(isInCodeBlock(lines, 5)).toBe(true);
    });
  });

  describe('/autoreply command guard', () => {
    /**
     * コマンド登録ロジック: allowAutoreplyCommand が true の場合のみ autoreply コマンドを登録
     */
    function buildCommandNames(allowAutoreplyCommand: boolean): string[] {
      const commands: string[] = ['new', 'stop', 'skip', 'restart', 'backend'];
      if (allowAutoreplyCommand) {
        commands.push('autoreply');
      }
      return commands;
    }

    /**
     * コマンド実行ガード: allowAutoreplyCommand が false なら拒否
     */
    function handleAutoreply(
      allowAutoreplyCommand: boolean,
      autoReplyChannels: Record<string, boolean>,
      channelId: string,
      mode: 'show' | 'on' | 'off' | 'default'
    ): { allowed: boolean; status?: string; channels?: Record<string, boolean> } {
      if (!allowAutoreplyCommand) {
        return { allowed: false };
      }
      const channels = { ...autoReplyChannels };
      if (mode === 'show') {
        return { allowed: true, status: channels[channelId] ? 'ON' : 'OFF', channels };
      }
      if (mode === 'default') {
        delete channels[channelId];
      } else if (mode === 'on') {
        channels[channelId] = true;
      } else {
        channels[channelId] = false;
      }
      return { allowed: true, status: mode.toUpperCase(), channels };
    }

    it('should not register autoreply command when allowAutoreplyCommand is false', () => {
      const commands = buildCommandNames(false);
      expect(commands).not.toContain('autoreply');
    });

    it('should register autoreply command when allowAutoreplyCommand is true', () => {
      const commands = buildCommandNames(true);
      expect(commands).toContain('autoreply');
    });

    it('should reject autoreply execution when allowAutoreplyCommand is false', () => {
      const result = handleAutoreply(false, {}, '123', 'on');
      expect(result.allowed).toBe(false);
      expect(result.status).toBeUndefined();
    });

    it('should allow autoreply execution and set ON when allowAutoreplyCommand is true', () => {
      const result = handleAutoreply(true, {}, '123', 'on');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('ON');
      expect(result.channels).toEqual({ '123': true });
    });

    it('should set OFF when channel is already in autoReplyChannels', () => {
      const result = handleAutoreply(true, { '123': true, '456': true }, '123', 'off');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('OFF');
      expect(result.channels).toEqual({ '123': false, '456': true });
    });

    it('should remove channel setting on default', () => {
      const result = handleAutoreply(true, { '123': false, '456': true }, '123', 'default');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('DEFAULT');
      expect(result.channels).toEqual({ '456': true });
    });

    it('should register autoreply mode choices when enabled', () => {
      const config = {
        agent: { allowedBackends: ['claude-code'] },
        discord: {
          allowAutoreplyCommand: true,
          allowRespondToBotsCommand: false,
          allowThreadModeCommand: false,
          allowLlmModeCommand: false,
        },
      } as Config;

      const commands = buildSlashCommands(config, []);
      const autoreply = commands.find((cmd) => cmd.name === 'autoreply') as any;
      const modeOption = autoreply.options.find((opt: any) => opt.name === 'mode');

      expect(autoreply).toBeTruthy();
      expect(modeOption.choices.map((choice: any) => choice.value)).toEqual([
        'show',
        'on',
        'off',
        'default',
      ]);
    });
  });

  describe('buildSlashCommands command limit', () => {
    it('keeps notify while staying within Discord command limit', () => {
      const config = {
        discord: {
          allowAutoreplyCommand: true,
          allowRespondToBotsCommand: true,
          allowThreadModeCommand: true,
          allowLlmModeCommand: true,
        },
      } as Config;
      const skills: Skill[] = Array.from({ length: 120 }, (_, i) => ({
        name: `skill-${i}`,
        description: `Skill ${i}`,
        path: `/tmp/skill-${i}`,
      }));

      const commands = buildSlashCommands(config, skills);
      const names = commands.map((cmd) => cmd.name);

      expect(commands.length).toBeLessThanOrEqual(100);
      expect(names).toContain('threadmode');
      expect(names).toContain('notify');
      expect(names).toContain('skill');
      expect(names.filter((name) => name.startsWith('skill-')).length).toBeLessThan(120);
    });
  });

  describe('/backend command choices', () => {
    it('registers only allowed backend choices', () => {
      const config = {
        agent: {
          allowedBackends: ['codex', 'grok'],
        },
        discord: {
          allowAutoreplyCommand: false,
          allowRespondToBotsCommand: false,
          allowThreadModeCommand: false,
          allowLlmModeCommand: false,
        },
      } as Config;

      const commands = buildSlashCommands(config, []);
      const backend = commands.find((cmd) => cmd.name === 'backend') as any;
      const setSubcommand = backend.options.find((opt: any) => opt.name === 'set');
      const typeOption = setSubcommand.options.find((opt: any) => opt.name === 'type');

      expect(typeOption.choices.map((choice: any) => choice.value)).toEqual(['codex', 'grok']);
    });
  });

  describe('/threadmode command registration', () => {
    it('registers threadmode command when enabled', () => {
      const config = {
        agent: { allowedBackends: ['claude-code'] },
        discord: {
          allowAutoreplyCommand: false,
          allowRespondToBotsCommand: false,
          allowThreadModeCommand: true,
          allowLlmModeCommand: false,
        },
      } as Config;

      const commands = buildSlashCommands(config, []);
      const threadmode = commands.find((cmd) => cmd.name === 'threadmode') as any;
      const modeOption = threadmode.options.find((opt: any) => opt.name === 'mode');

      expect(threadmode).toBeTruthy();
      expect(modeOption.choices.map((choice: any) => choice.value)).toEqual([
        'show',
        'on',
        'off',
        'default',
      ]);
    });

    it('does not register threadmode command when disabled', () => {
      const config = {
        agent: { allowedBackends: ['claude-code'] },
        discord: {
          allowAutoreplyCommand: false,
          allowRespondToBotsCommand: false,
          allowThreadModeCommand: false,
          allowLlmModeCommand: false,
        },
      } as Config;

      const commands = buildSlashCommands(config, []);
      expect(commands.map((cmd) => cmd.name)).not.toContain('threadmode');
    });
  });
});
