import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDiscordMessageTarget } from '../src/discord/message-handler.js';
import { ensureSessionWithWorkspace } from '../src/session-workspace.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import {
  clearSessions,
  createSession,
  getActiveSessionId,
  getSessionEntry,
  initSessions,
  listAllSessions,
} from '../src/sessions.js';
import { isSecretSession, isSecretThread } from '../src/secret.js';
import { handleSecretCommand } from '../src/secret-command.js';
import { initSettings, loadSettings } from '../src/settings.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-secret-thread-'));
  clearSessions();
  initSessions(dir);
  initSettings(dir);
});
afterEach(() => {
  clearSessions();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { secret?: boolean; enabled?: boolean; existingThread?: boolean } = {}) {
  const channelId = options.existingThread ? 'existing-thread' : 'parent';
  const parentId = createSession(channelId, {
    platform: 'discord',
    secret: options.secret ?? true,
    workspaceId: 'default',
    workspacePath: dir,
    agentBindingKey: 'parent',
  });
  const send = vi.fn();
  const startThread = vi.fn().mockResolvedValue({ id: 'new-thread', name: 'シークレット', send });
  const message = {
    content: 'PRIVATE-THREAD-CONTENT',
    startThread,
    reply: vi.fn(),
    channel: {
      id: channelId,
      name: 'channel',
      parentId: options.existingThread ? 'parent' : null,
      isThread: () => options.existingThread ?? false,
    },
  };
  const resolve = () =>
    resolveDiscordMessageTarget(
      message as never,
      channelId,
      { discord: { replyInThread: options.enabled ?? true } } as never,
      loadSettings()
    );
  return { parentId, message, startThread, resolve };
}

describe('Discord secret thread routing', () => {
  it('creates a thread and registers it as secret before session resolution or any turn writes', async () => {
    const registry = await WorkspaceRegistry.open({
      dataDir: join(dir, 'registry-state'),
      defaultWorkspacePath: dir,
      allowedRoots: [dir],
    });
    const { parentId, startThread, resolve } = fixture();
    const target = await resolve();
    expect(startThread).toHaveBeenCalledWith({ name: 'シークレット' });
    expect(target.conversationChannelId).toBe('new-thread');
    expect(target.settingsChannelId).toBe('parent');
    const childId = getActiveSessionId('new-thread')!;
    expect(isSecretSession(childId)).toBe(true);
    expect(isSecretThread('discord:new-thread')).toBe(true);
    expect(getSessionEntry(childId)).toMatchObject({
      workspacePath: dir,
      agentBindingKey: 'parent',
    });
    const resolved = await ensureSessionWithWorkspace({
      registry,
      platform: 'discord',
      contextKey: 'new-thread',
      bindingKey: 'parent',
    });
    expect(resolved.appSessionId).toBe(childId);
    expect(getActiveSessionId('parent')).toBe(parentId);
    const persisted = readFileSync(join(dir, 'sessions.json'), 'utf8');
    expect(persisted).not.toContain(childId);
    expect(persisted).not.toContain('PRIVATE-THREAD-CONTENT');
    expect(JSON.parse(persisted).sessions).toEqual({});

    handleSecretCommand({ appSessionId: childId, userText: '/secret off' });
    expect(getActiveSessionId('new-thread')).toBeUndefined();
    expect(listAllSessions().filter((s) => !isSecretSession(s.id))).toEqual([]);
    expect(getActiveSessionId('parent')).toBe(parentId);
  });

  it('keeps the source secret conversation when thread creation fails', async () => {
    const { parentId, startThread, resolve } = fixture();
    startThread.mockRejectedValueOnce(new Error('Missing Permissions'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = await resolve();
    expect(startThread).toHaveBeenCalledOnce();
    expect(target.conversationChannelId).toBe('parent');
    expect(getActiveSessionId('parent')).toBe(parentId);
    expect(getActiveSessionId('new-thread')).toBeUndefined();
  });

  it.each([{ enabled: false }, { existingThread: true }])(
    'does not create another thread for %j',
    async (options) => {
      const { parentId, startThread, resolve } = fixture(options);
      const target = await resolve();
      expect(startThread).not.toHaveBeenCalled();
      expect(getActiveSessionId(target.conversationChannelId)).toBe(parentId);
    }
  );

  it('keeps ordinary threads ordinary and derives their title from the message', async () => {
    const { startThread, resolve } = fixture({ secret: false });
    const target = await resolve();
    expect(startThread).toHaveBeenCalledWith({ name: 'PRIVATE-THREAD-CONTENT' });
    const { appSessionId } = await ensureSessionWithWorkspace({
      platform: 'discord',
      contextKey: target.conversationChannelId,
      bindingKey: target.settingsChannelId,
    });
    expect(isSecretSession(appSessionId)).toBe(false);
  });

  it('honors a per-channel thread-mode override while secret', async () => {
    const { message, startThread } = fixture();
    const target = await resolveDiscordMessageTarget(
      message as never,
      'parent',
      { discord: { replyInThread: false } } as never,
      { ...loadSettings(), discordThreadModeChannels: { parent: true } }
    );
    expect(startThread).toHaveBeenCalledOnce();
    expect(isSecretSession(getActiveSessionId(target.conversationChannelId))).toBe(true);
  });

  it('honors a per-channel OFF override over the enabled default', async () => {
    const { parentId, message, startThread } = fixture();
    const target = await resolveDiscordMessageTarget(
      message as never,
      'parent',
      { discord: { replyInThread: true } } as never,
      { ...loadSettings(), discordThreadModeChannels: { parent: false } }
    );
    expect(startThread).not.toHaveBeenCalled();
    expect(getActiveSessionId(target.conversationChannelId)).toBe(parentId);
  });

  it('retains the captured secret state if the parent ends while Discord creates the thread', async () => {
    const { parentId, startThread, resolve } = fixture();
    startThread.mockImplementationOnce(async () => {
      handleSecretCommand({ appSessionId: parentId, userText: '/secret off' });
      return { id: 'new-thread', name: 'シークレット', send: vi.fn() };
    });
    const target = await resolve();
    expect(getActiveSessionId('parent')).toBeUndefined();
    expect(isSecretSession(getActiveSessionId(target.conversationChannelId))).toBe(true);
  });
});
