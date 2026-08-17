import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  buildSlashCommands,
  createInteractionHandler,
  createDiscordModelDiscoveryCache,
  formatThreadLeaveError,
  getDiscordAutocompleteChoices,
  handleSkillCommand,
  removeUserFromDiscordThread,
} from '../src/discord/slash-commands.js';
import type { Config } from '../src/config.js';
import type { Skill } from '../src/skills.js';
import type { BackendResolver } from '../src/backend-resolver.js';
import type { AgentRunner } from '../src/agent-runner.js';
import {
  discordReplySuggestionsByMessageId,
  discordToolHistoryByMessageId,
} from '../src/discord/ui.js';
import { clearSessions, createSession, getActiveSessionId, initSessions } from '../src/sessions.js';
import {
  clearSettingsCache,
  initSettings,
  loadSettings,
} from '../src/settings.js';

let discordCommandsTempDir: string;

beforeEach(() => {
  discordCommandsTempDir = mkdtempSync(join(tmpdir(), 'xangi-discord-commands-'));
  initSessions(discordCommandsTempDir);
  initSettings(discordCommandsTempDir);
});

afterEach(() => {
  clearSessions();
  clearSettingsCache();
  rmSync(discordCommandsTempDir, { recursive: true, force: true });
});

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
  describe('removeUserFromDiscordThread', () => {
    it('removes the clicking user from a thread', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const channel = { isThread: () => true, members: { remove } };

      await expect(removeUserFromDiscordThread(channel as never, 'user-123')).resolves.toBe(true);
      expect(remove).toHaveBeenCalledWith('user-123');
    });

    it('closes the thread session after the clicking user leaves', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'xangi-thread-leave-'));
      try {
        initSessions(testDir);
        createSession('thread-123', { platform: 'discord' });
        const remove = vi.fn().mockResolvedValue(undefined);
        const destroy = vi.fn();
        const editReply = vi.fn().mockResolvedValue(undefined);
        const handler = createInteractionHandler({
          config: { discord: { allowedUsers: ['user-123'] } } as Config,
          resolver: { getSelectableBackends: () => [] } as unknown as BackendResolver,
          agentRunner: { destroy } as never,
          scheduler: {} as never,
          workdir: testDir,
          skillsRef: { current: [] },
        });
        const interaction = {
          isAutocomplete: () => false,
          isButton: () => true,
          customId: 'xangi_thread_leave',
          channelId: 'thread-123',
          user: { id: 'user-123' },
          channel: { isThread: () => true, members: { remove } },
          message: { id: 'message-456' },
          deferReply: vi.fn().mockResolvedValue(undefined),
          editReply,
        };

        await handler(interaction as never);

        expect(remove).toHaveBeenCalledWith('user-123');
        expect(getActiveSessionId('thread-123')).toBeUndefined();
        expect(destroy).toHaveBeenCalledWith('thread-123');
        expect(editReply).toHaveBeenCalledWith(
          '🚪 セッションを終了して、このスレッドから退出しました'
        );
      } finally {
        clearSessions();
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('keeps the session active when leaving the thread fails', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'xangi-thread-leave-failure-'));
      try {
        initSessions(testDir);
        const sessionId = createSession('thread-123', { platform: 'discord' });
        const destroy = vi.fn();
        const editReply = vi.fn().mockResolvedValue(undefined);
        const handler = createInteractionHandler({
          config: { discord: { allowedUsers: ['user-123'] } } as Config,
          resolver: { getSelectableBackends: () => [] } as unknown as BackendResolver,
          agentRunner: { destroy } as never,
          scheduler: {} as never,
          workdir: testDir,
          skillsRef: { current: [] },
        });
        const interaction = {
          isAutocomplete: () => false,
          isButton: () => true,
          customId: 'xangi_thread_leave',
          channelId: 'thread-123',
          user: { id: 'user-123' },
          channel: {
            isThread: () => true,
            members: { remove: vi.fn().mockRejectedValue({ code: 50013 }) },
          },
          message: { id: 'message-456' },
          deferReply: vi.fn().mockResolvedValue(undefined),
          editReply,
        };

        await handler(interaction as never);

        expect(getActiveSessionId('thread-123')).toBe(sessionId);
        expect(destroy).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith('❌ Botに「スレッドの管理」権限が必要です');
      } finally {
        clearSessions();
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('does not remove users from a normal channel', async () => {
      const remove = vi.fn();
      const channel = { isThread: () => false, members: { remove } };

      await expect(removeUserFromDiscordThread(channel as never, 'user-123')).resolves.toBe(false);
      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe('formatThreadLeaveError', () => {
    it('explains the required Discord permission for access errors', () => {
      expect(formatThreadLeaveError({ code: 50001 })).toContain('スレッドの管理');
      expect(formatThreadLeaveError({ code: 50013 })).toContain('スレッドの管理');
    });

    it('uses a generic message for other errors', () => {
      expect(formatThreadLeaveError(new Error('network'))).toBe(
        '❌ スレッドから退出できませんでした'
      );
    });
  });

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

    it('stores a thread autoreply override under the thread ID', async () => {
      const reply = vi.fn().mockResolvedValue(undefined);
      const handler = createInteractionHandler({
        config: {
          agent: {},
          discord: { allowedUsers: ['user-123'], allowAutoreplyCommand: true },
          slack: { autoReplyChannels: [] },
          web: { replySuggestions: false, replySuggestionCount: 3 },
        } as Config,
        resolver: { getSelectableBackends: () => [] } as unknown as BackendResolver,
        agentRunner: {} as AgentRunner,
        scheduler: {} as never,
        workdir: discordCommandsTempDir,
        skillsRef: { current: [] },
      });
      const interaction = {
        isAutocomplete: () => false,
        isButton: () => false,
        isChatInputCommand: () => true,
        commandName: 'autoreply',
        channelId: 'thread-456',
        channel: { isThread: () => true, parentId: 'parent-123' },
        user: { id: 'user-123' },
        options: { getString: vi.fn().mockReturnValue('on') },
        reply,
      };

      await handler(interaction as never);

      expect(loadSettings().discordAutoReplyChannels).toEqual({ 'thread-456': true });
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('autoreplyをonに設定しました'));
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

  describe('/skill command registration', () => {
    it('uses one optional-name command for both listing and execution', () => {
      const config = {
        agent: { allowedBackends: ['claude-code'] },
        discord: {},
      } as Config;

      const commands = buildSlashCommands(config, []);
      const names = commands.map((command) => command.name);
      const skill = commands.find((command) => command.name === 'skill') as any;
      const nameOption = skill.options.find((option: any) => option.name === 'name');

      expect(names).not.toContain('skills');
      expect(nameOption.required).toBe(false);
    });

    it('streams progress and exposes History and reply suggestions without leaking markup', async () => {
      const editReply = vi.fn().mockResolvedValue({ id: 'skill-reply-1' });
      const followUp = vi.fn().mockResolvedValue({ id: 'skill-followup-1' });
      const interaction = {
        id: 'skill-interaction-1',
        options: { getString: vi.fn().mockReturnValue('対象') },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        followUp,
        channel: { isThread: () => false },
      };
      const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
        callbacks.onText?.('途中表示', '途中表示');
        callbacks.onToolUse?.('Bash', { command: 'pwd' });
        callbacks.onText?.('最終回答\n<xangi', '最終回答\n<xangi');
        callbacks.onText?.('_reply', '_reply');
        const result = {
          result:
            '最終回答\n<xangi_reply_suggestions>["続けて","詳しく","別案"]</xangi_reply_suggestions>',
          sessionId: 'provider-skill-1',
        };
        callbacks.onComplete?.(result);
        return result;
      });
      const agentRunner = {
        runStream,
        getTimeoutState: vi.fn().mockReturnValue(undefined),
      } as unknown as AgentRunner;
      const config = {
        agent: { config: { skipPermissions: false } },
        discord: {
          streaming: true,
          showThinking: true,
          showButtons: true,
          toolHistoryMode: 'button',
          showLiveToolUse: true,
          showToolButton: true,
          replySuggestions: true,
          replySuggestionCount: 3,
        },
      } as Config;

      await handleSkillCommand(
        interaction as never,
        agentRunner,
        config,
        'channel-skill-1',
        'channel-skill-1',
        'xs-test'
      );
      await Promise.resolve();

      expect(runStream.mock.calls[0]?.[0]).toContain('スキル「xs-test」を実行してください');
      expect(runStream.mock.calls[0]?.[0]).toContain('<xangi_reply_suggestions>');
      expect(
        editReply.mock.calls.some(([payload]) => String(payload.content).includes('途中表示'))
      ).toBe(true);
      const finalPayload = editReply.mock.calls.at(-1)?.[0] as {
        content: string;
        components: Array<{ components: Array<{ data: { custom_id?: string } }> }>;
      };
      expect(finalPayload.content).toBe('最終回答');
      expect(finalPayload.content).not.toContain('xangi_reply_suggestions');
      const customIds = finalPayload.components[0].components.map(
        (component) => component.data.custom_id
      );
      expect(customIds.some((id) => id?.startsWith('xangi_tools|'))).toBe(true);
      expect(customIds).toContain('xangi_reply_suggestions');
      expect(discordToolHistoryByMessageId.get('skill-reply-1')).toEqual([
        expect.objectContaining({ kind: 'text', text: '途中表示' }),
        expect.objectContaining({ kind: 'tool', toolName: 'Bash' }),
      ]);
      expect(discordReplySuggestionsByMessageId.get('skill-reply-1')).toEqual([
        '続けて',
        '詳しく',
        '別案',
      ]);
      expect(followUp).not.toHaveBeenCalled();

      discordToolHistoryByMessageId.delete('skill-reply-1');
      discordReplySuggestionsByMessageId.delete('skill-reply-1');
    });
  });

  describe('/replysuggestions command registration', () => {
    it('registers the global on/off/show/default choices', () => {
      const config = {
        agent: { allowedBackends: ['claude-code'] },
        discord: {},
        slack: {},
        web: { replySuggestions: true, replySuggestionCount: 3 },
      } as Config;

      const commands = buildSlashCommands(config, []);
      const command = commands.find((cmd) => cmd.name === 'replysuggestions') as any;
      const modeOption = command.options.find((opt: any) => opt.name === 'mode');

      expect(modeOption.choices.map((choice: any) => choice.value)).toEqual([
        'show',
        'on',
        'off',
        'default',
      ]);
    });
  });

  describe('/backend command choices', () => {
    it('registers dynamic autocomplete for backend choices', () => {
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

      expect(typeOption.autocomplete).toBe(true);
      expect(typeOption.choices).toBeUndefined();

      const models = commands.find((cmd) => cmd.name === 'models') as any;
      const modelsBackend = models.options.find((opt: any) => opt.name === 'backend');
      expect(modelsBackend.required).toBe(false);
      expect(modelsBackend.autocomplete).toBe(true);
      expect(modelsBackend.choices).toBeUndefined();
    });

    it('registers dynamic autocomplete for model and effort', () => {
      const config = {
        agent: { allowedBackends: ['codex'] },
        discord: {},
      } as Config;

      const commands = buildSlashCommands(config, []);
      const backend = commands.find((cmd) => cmd.name === 'backend') as any;
      const setSubcommand = backend.options.find((opt: any) => opt.name === 'set');
      const modelOption = setSubcommand.options.find((opt: any) => opt.name === 'model');
      const effortOption = setSubcommand.options.find((opt: any) => opt.name === 'effort');

      expect(modelOption.autocomplete).toBe(true);
      expect(modelOption.choices).toBeUndefined();
      expect(effortOption.autocomplete).toBe(true);
      expect(effortOption.choices).toBeUndefined();
    });

    it('returns only currently selectable backend candidates', async () => {
      const resolver = {
        getSelectableBackends: () => ['codex', 'grok'] as AgentBackend[],
      } as BackendResolver;

      await expect(
        getDiscordAutocompleteChoices(
          {
            commandName: 'backend',
            focusedName: 'type',
            focusedValue: 'co',
          },
          [],
          resolver
        )
      ).resolves.toEqual([{ name: 'Codex', value: 'codex' }]);
    });

    it('discovers model candidates for the selected backend', async () => {
      const resolver = {
        isBackendSelectable: (backend: string) => backend === 'local-llm',
        getAllowedModels: () => undefined,
      } as BackendResolver;
      const discover = vi.fn().mockResolvedValue({
        backend: 'local-llm',
        source: 'OpenAI-compatible /v1/models',
        status: 'available',
        models: [{ id: 'gemma-4-26b-a4b' }],
      });

      await expect(
        getDiscordAutocompleteChoices(
          {
            commandName: 'backend',
            focusedName: 'model',
            focusedValue: 'gemma',
            backend: 'local-llm',
          },
          [],
          resolver,
          discover
        )
      ).resolves.toEqual([{ name: 'gemma-4-26b-a4b', value: 'gemma-4-26b-a4b' }]);
    });

    it('returns only effort candidates supported by both xangi and the selected model', async () => {
      const resolver = {
        isBackendSelectable: (backend: string) => backend === 'codex',
        getAllowedModels: () => undefined,
      } as BackendResolver;
      const discover = vi.fn().mockResolvedValue({
        backend: 'codex',
        source: 'codex app-server model/list',
        status: 'available',
        models: [
          {
            id: 'gpt-test',
            supportedEfforts: ['medium', 'high', 'xhigh'],
          },
        ],
      });

      await expect(
        getDiscordAutocompleteChoices(
          {
            commandName: 'backend',
            focusedName: 'effort',
            focusedValue: '',
            backend: 'codex',
            model: 'gpt-test',
          },
          [],
          resolver,
          discover
        )
      ).resolves.toEqual([
        { name: 'デフォルト', value: 'none' },
        { name: 'medium', value: 'medium' },
        { name: 'high', value: 'high' },
      ]);
    });

    it('reuses a cached backend discovery result', async () => {
      const discovery = {
        backend: 'cursor' as const,
        source: 'cursor-agent models',
        status: 'available' as const,
        models: [{ id: 'cursor-model' }],
      };
      const discover = vi.fn().mockResolvedValue(discovery);
      const cachedDiscover = createDiscordModelDiscoveryCache(discover, 60_000);

      await expect(cachedDiscover('cursor')).resolves.toBe(discovery);
      await expect(cachedDiscover('cursor')).resolves.toBe(discovery);
      expect(discover).toHaveBeenCalledTimes(1);
    });

    it('returns stale candidates immediately while refreshing in the background', async () => {
      let now = 0;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const initial = {
        backend: 'cursor' as const,
        source: 'cursor-agent models',
        status: 'available' as const,
        models: [{ id: 'old-model' }],
      };
      const refreshed = { ...initial, models: [{ id: 'new-model' }] };
      let finishRefresh: ((value: typeof refreshed) => void) | undefined;
      const discover = vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockImplementationOnce(
          () =>
            new Promise<typeof refreshed>((resolve) => {
              finishRefresh = resolve;
            })
        );
      const cachedDiscover = createDiscordModelDiscoveryCache(discover, 1);

      await expect(cachedDiscover('cursor')).resolves.toBe(initial);
      now = 2;
      await expect(cachedDiscover('cursor')).resolves.toBe(initial);
      expect(discover).toHaveBeenCalledTimes(2);

      finishRefresh?.(refreshed);
      await vi.waitFor(async () => {
        await expect(cachedDiscover('cursor')).resolves.toBe(refreshed);
      });
      nowSpy.mockRestore();
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
