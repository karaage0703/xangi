import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSecretConversationCommand } from '../src/secret-conversation-command.js';
import {
  clearSessions,
  createSession,
  getActiveSessionId,
  getSessionEntry,
  initSessions,
  listAllSessions,
  incrementMessageCount,
} from '../src/sessions.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { processPrompt, resolveDiscordMessageTarget } from '../src/discord/message-handler.js';
import { processMessage } from '../src/slack.js';
import { createInteractionHandler } from '../src/discord/slash-commands.js';
import { isSecretSession } from '../src/secret.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secret-control-'));
  clearSessions();
  initSessions(dir);
});
afterEach(() => {
  clearSessions();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
const diskSessions = () =>
  existsSync(join(dir, 'sessions.json'))
    ? JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).sessions
    : {};

describe('secret controls without placeholder sessions', () => {
  it.each(['discord', 'slack'])(
    'starts %s directly as secret with a workspace snapshot',
    async (platform) => {
      const registry = await WorkspaceRegistry.open({
        dataDir: join(dir, 'registry'),
        defaultWorkspacePath: dir,
        allowedRoots: [dir],
      });
      const base = { platform, registry, contextKey: 'chat', bindingKey: 'parent' };
      await handleSecretConversationCommand({ ...base, userText: '/secret on' });
      const id = getActiveSessionId('chat')!;
      expect(getSessionEntry(id)).toMatchObject({
        secret: true,
        workspacePath: dir,
        agentBindingKey: 'parent',
      });
      expect(listAllSessions(true)).toHaveLength(1);
      expect(diskSessions()).toEqual({});
      await handleSecretConversationCommand({ ...base, userText: '/secret on' });
      expect(getActiveSessionId('chat')).toBe(id);
      await handleSecretConversationCommand({ ...base, userText: '/secret status' });
      expect(getActiveSessionId('chat')).toBe(id);
      await handleSecretConversationCommand({ ...base, userText: '/secret off' });
      await handleSecretConversationCommand({ ...base, userText: '/secret off' });
      expect(listAllSessions(true)).toEqual([]);
      expect(diskSessions()).toEqual({});
    }
  );

  it.each(['/secret status', '/secret off', '今シークレット？', 'シークレットを終了して'])(
    'does not create a session for %s',
    async (userText) => {
      const result = await handleSecretConversationCommand({
        platform: 'discord',
        contextKey: 'chat',
        bindingKey: 'chat',
        userText,
      });
      expect(result?.result).toContain('OFF');
      expect(listAllSessions(true)).toEqual([]);
      expect(diskSessions()).toEqual({});
    }
  );

  it('retains an existing ordinary conversation and never converts it in place', async () => {
    const old = createSession('chat', { platform: 'discord', title: '保存する履歴' });
    incrementMessageCount(old);
    await handleSecretConversationCommand({
      platform: 'discord',
      contextKey: 'chat',
      bindingKey: 'chat',
      userText: '/secret on',
    });
    expect(getSessionEntry(old)).toMatchObject({
      title: '保存する履歴',
      lifecycle: 'closed',
      messageCount: 1,
    });
    expect(isSecretSession(getActiveSessionId('chat'))).toBe(true);
    expect(Object.keys(diskSessions())).toEqual([old]);
  });

  it.each(['status', 'off'])('Discord slash %s does not create a session', async (mode) => {
    const handler = createInteractionHandler({
      config: {
        agent: { allowedBackends: ['codex'] },
        discord: { allowedUsers: ['user'] },
        scheduler: { enabled: false },
      },
      resolver: { getSelectableBackends: () => [] },
      agentRunner: { destroy: vi.fn() },
      scheduler: {},
      skillsRef: { current: [] },
      workdir: dir,
    } as never);
    const editReply = vi.fn();
    await handler({
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'secret',
      channelId: 'chat',
      channel: { isThread: () => false },
      user: { id: 'user' },
      options: { getString: () => mode },
      deferReply: vi.fn(),
      editReply,
      reply: vi.fn(),
    } as never);
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('OFF'));
    expect(listAllSessions(true)).toEqual([]);
  });

  it.each(['discord', 'slack'])(
    'handles %s natural controls before invoking the AI or creating a normal session',
    async (platform) => {
      const runner = { destroy: vi.fn(), runStream: vi.fn(), run: vi.fn() };
      const send = vi.fn().mockResolvedValue({ ts: '1' });
      for (const userText of ['今シークレット？', 'シークレットにして', 'シークレットを終了して']) {
        if (platform === 'discord') {
          const startThread = vi.fn();
          const message = {
            id: 'msg',
            content: `<@bot> ${userText}`,
            attachments: new Map(),
            client: { user: { id: 'bot' } },
            channel: { name: 'chat', isThread: () => false },
            reply: send,
            startThread,
          };
          const target = await resolveDiscordMessageTarget(
            message as never,
            'chat',
            { discord: { replyInThread: true } } as never,
            {}
          );
          expect(startThread).not.toHaveBeenCalled();
          await processPrompt(
            message as never,
            runner as never,
            userText,
            false,
            'chat',
            {} as never,
            target
          );
        } else {
          await processMessage(
            'chat',
            'chat',
            undefined,
            userText,
            '1',
            {
              conversations: { info: async () => ({}) },
              chat: { postMessage: send },
            } as never,
            runner as never,
            { agent: { config: {} } } as never,
            false
          );
        }
        expect(diskSessions()).toEqual({});
      }
      expect(send).toHaveBeenCalledTimes(3);
      expect(runner.run).not.toHaveBeenCalled();
      expect(runner.runStream).not.toHaveBeenCalled();
      expect(listAllSessions(true)).toEqual([]);
    }
  );
});
