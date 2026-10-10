import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveSession,
  clearSessions,
  closeSession,
  createSession,
  createWebSession,
  ensureSession,
  getActiveSessionId,
  getSessionEntry,
  initSessions,
  listAllSessions,
  setProviderSessionId,
  updateSessionTitle,
} from '../src/sessions.js';
import {
  initTranscriptStorage,
  resetTranscriptStorageForTests,
  logPrompt,
  logResponse,
  logError,
  logCompactionCheckpoint,
  readSessionMessages,
  readSessionMessagesPage,
  updateMessageContent,
  setSecretTurnInput,
} from '../src/transcript-logger.js';
import { handleSecretCommand } from '../src/secret-command.js';
import { runSlackSecretCommand } from '../src/slack.js';
import { buildSlashCommands, createInteractionHandler } from '../src/discord/slash-commands.js';
import { executeWebCommand, WEB_COMMANDS } from '../src/web-slash-commands.js';
import { isSecretSession, isSecretThread, parseSecretCommand } from '../src/secret.js';
import { ToolTrajectoryLogger } from '../src/tool-trajectory/logger.js';
import {
  startActivity,
  updateActivityText,
  updateActivityTool,
  completeActivity,
  getActivity,
  clearActivities,
} from '../src/activity-store.js';
import { events, subscribeEvents } from '../src/events-emitter.js';
import { TurnLatencyRecorder } from '../src/turn-latency.js';
import { StopHookRunner, UserPromptSubmitHookRunner } from '../src/hooks.js';
import { privacyConsole, withPrivateDiagnostics } from '../src/privacy-console.js';

let dir: string;
const secret = 'PRIVATE-SENTINEL-never-on-disk';
function diskText(path = dir): string {
  return readdirSync(path, { withFileTypes: true })
    .map((e) =>
      e.isDirectory() ? diskText(join(path, e.name)) : readFileSync(join(path, e.name), 'utf8')
    )
    .join('\n');
}
beforeEach(() => {
  clearSessions();
  resetTranscriptStorageForTests();
  clearActivities();
  dir = mkdtempSync(join(tmpdir(), 'xangi-secret-'));
  initSessions(dir);
  initTranscriptStorage(dir, dir);
  vi.stubEnv('WORKSPACE_PATH', dir);
});
afterEach(() => {
  clearSessions();
  resetTranscriptStorageForTests();
  clearActivities();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('secret persistence boundary', () => {
  it.each(['discord', 'slack', 'telegram', 'line'])(
    'switches %s with natural requests and confirms actual state',
    (platform) => {
      const old = createSession('natural-chat', { platform });
      const result = handleSecretCommand({ appSessionId: old, userText: 'シークレットにして' });
      expect(result?.result).toContain('次のメッセージ');
      const id = getActiveSessionId('natural-chat')!;
      expect(isSecretSession(id)).toBe(true);
      expect(
        handleSecretCommand({ appSessionId: id, userText: '今シークレット？' })?.result
      ).toContain('シークレットモード');
      logPrompt(dir, id, secret);
      expect(
        handleSecretCommand({ appSessionId: id, userText: 'シークレットを終了して' })?.result
      ).toContain('破棄');
      expect(getActiveSessionId('natural-chat')).toBeUndefined();
      const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
      expect(Object.keys(stored.sessions)).toEqual([old]);
      const next = ensureSession('natural-chat', { platform });
      expect(isSecretSession(next)).toBe(false);
      expect(getSessionEntry(next)?.platform).toBe(platform);
      logPrompt(dir, next, '通常の会話');
      expect(readSessionMessages(dir, next)).toHaveLength(1);
      expect(readSessionMessages(dir, id)).toEqual([]);
      expect(diskText()).not.toContain(secret);
    }
  );
  it('registers and handles Discord /secret without invoking an AI', async () => {
    const config = {
      agent: { allowedBackends: ['codex'] },
      discord: { allowedUsers: ['user'] },
      scheduler: { enabled: false },
    };
    const command = buildSlashCommands(config as never, []).find((c) => c.name === 'secret');
    expect(command).toBeDefined();
    const runner = { destroy: vi.fn(), run: vi.fn() };
    const handler = createInteractionHandler({
      config,
      resolver: { getSelectableBackends: () => [] },
      agentRunner: runner,
      scheduler: {},
      skillsRef: { current: [] },
      workdir: dir,
    } as never);
    const interaction = {
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'secret',
      channelId: 'discord-private',
      channel: { isThread: () => true, parentId: 'parent' },
      user: { id: 'user' },
      options: { getString: () => 'on' },
      deferReply: vi.fn(),
      editReply: vi.fn(),
      reply: vi.fn(),
    };
    await handler(interaction as never);
    expect(isSecretSession(getActiveSessionId('discord-private'))).toBe(true);
    expect(listAllSessions(true)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).sessions).toEqual({});
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('/secret off'));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('opens a dedicated Slack thread, checks it, and discards it on /secret off', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '123.456' });
    const options = {
      command: { channel_id: 'C', user_id: 'U', text: 'on' },
      respond: vi.fn(),
      client: { chat: { postMessage } },
      agentRunner: { destroy: vi.fn() },
      secretThreads: new Map<string, string>(),
    };
    await runSlackSecretCommand(options as never);
    const id = getActiveSessionId('C:123.456')!;
    expect(listAllSessions(true)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).sessions).toEqual({});
    expect(isSecretSession(id)).toBe(true);
    expect(getActiveSessionId('C')).toBeUndefined();
    expect(postMessage.mock.calls[1][0]).toMatchObject({ thread_ts: '123.456' });
    logPrompt(dir, id, secret);
    options.command.text = 'status';
    await runSlackSecretCommand(options as never);
    expect(postMessage).toHaveBeenCalledTimes(2);
    options.command.text = 'off';
    await runSlackSecretCommand(options as never);
    expect(readSessionMessages(dir, id)).toEqual([]);
    expect(options.secretThreads.size).toBe(0);
    expect(getActiveSessionId('C:123.456')).toBeUndefined();
    expect(listAllSessions(true)).toEqual([]);
    expect(diskText()).not.toContain(secret);
  });

  it('exposes /secret in the Web palette and routes it to the deterministic chat control', async () => {
    expect(WEB_COMMANDS.find((c) => c.name === 'secret')?.options?.[0].choices).toEqual([
      { name: 'on', value: 'on' },
      { name: 'off', value: 'off' },
      { name: 'status', value: 'status' },
    ]);
    await expect(executeWebCommand('/secret status', { workdir: dir })).resolves.toMatchObject({
      kind: 'chat',
      message: '/secret status',
    });
    await expect(executeWebCommand('/secret show', { workdir: dir })).rejects.toThrow('使い方');
    const result = await executeWebCommand('/secret on', { workdir: dir });
    expect(result).toMatchObject({ kind: 'chat', message: '/secret on' });
    await expect(executeWebCommand('/secret on secret-text', { workdir: dir })).rejects.toThrow(
      '使い方'
    );
  });
  it('delivers private device replies only to the explicitly scoped subscriber', () => {
    const id = createWebSession({ secret: true });
    const global = vi.fn();
    const own = vi.fn();
    const other = vi.fn();
    const unsubscribers = [
      subscribeEvents(global, { whenDisabled: true }),
      subscribeEvents(own, { whenDisabled: true, secretSessionId: id }),
      subscribeEvents(other, { whenDisabled: true, secretSessionId: 'secret_other' }),
    ];
    try {
      events.turnComplete({ threadId: `web:${id}`, turnId: 'device-private', text: secret });
      expect(own).toHaveBeenCalledOnce();
      expect(global).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  });
  it.each(['discord', 'slack', 'line', 'telegram', 'web'])(
    'keeps %s transcripts, edits, errors, and metadata only in memory',
    (platform) => {
      const id = createSession('conversation', {
        platform,
        secret: true,
        title: 'シークレット',
      });
      setSecretTurnInput(id, secret);
      const user = logPrompt(dir, id, 'expanded wrapper');
      logResponse(dir, id, { result: secret });
      logError(dir, id, secret);
      setProviderSessionId(id, secret, 'codex');
      updateSessionTitle(id, secret);
      expect(updateMessageContent(dir, id, user.id, `${secret}-edited`)?.content).toContain(secret);
      expect(readSessionMessagesPage(dir, id, 1).hasMore).toBe(true);
      expect(
        logCompactionCheckpoint(dir, id, {
          version: 1,
          summary: secret,
          firstKeptMessageId: user.id,
          createdAt: '',
          estimatedTokensBefore: 2,
          estimatedTokensAfter: 1,
          messageCountBefore: 2,
          messageCountAfter: 1,
          trigger: 'tokens',
        })
      ).toBe(false);
      new ToolTrajectoryLogger({ workdir: dir, enabled: true, hashSalt: 'test' }).logToolCall(
        { appSessionId: id },
        { tool_name: 'exec', args: { command: secret }, duration_ms: 1, status: 'success' }
      );
      expect(readSessionMessages(dir, id)).toHaveLength(3);
      expect(diskText()).not.toContain(secret);
      expect(diskText()).not.toContain(id);
      closeSession(id);
      logPrompt(dir, id, secret);
      logResponse(dir, id, { result: secret });
      expect(readSessionMessages(dir, id)).toEqual([]);
      expect(getSessionEntry(id)).toBeUndefined();
      expect(diskText()).not.toContain(secret);
    }
  );

  it('preserves ordinary sessions, prevents private forks becoming saved, and forgets on restart', () => {
    const normal = createWebSession({ title: 'ordinary' });
    logPrompt(dir, normal, 'ordinary message');
    const id = createWebSession({ secret: true });
    logPrompt(dir, id, secret);
    const fork = createWebSession({ resumedFromSessionId: id });
    expect(isSecretSession(fork)).toBe(true);
    initSessions(dir);
    expect(getSessionEntry(id)).toBeUndefined();
    expect(getSessionEntry(fork)).toBeUndefined();
    expect(readSessionMessages(dir, id)).toEqual([]);
    expect(readSessionMessages(dir, normal)[0].content).toBe('ordinary message');
    expect(diskText()).not.toContain(secret);
  });

  it.each(['discord', 'slack', 'line', 'telegram'])(
    'switches %s on/off without AI and persists only the external-history boundary',
    (platform) => {
      const old = createSession('chat', { platform });
      const on = handleSecretCommand({ appSessionId: old, userText: '/secret on' });
      expect(on?.result).toContain('次のメッセージ');
      const privateId = getActiveSessionId('chat')!;
      expect(isSecretSession(privateId)).toBe(true);
      logPrompt(dir, privateId, secret);
      const off = handleSecretCommand({ appSessionId: privateId, userText: '/secret off' });
      expect(off?.result).toContain('破棄');
      expect(readSessionMessages(dir, privateId)).toEqual([]);
      expect(getActiveSessionId('chat')).toBeUndefined();
      initSessions(dir);
      expect(getActiveSessionId('chat')).toBeUndefined();
      const ordinary = ensureSession('chat', { platform });
      expect(isSecretSession(ordinary)).toBe(false);
      expect(getSessionEntry(ordinary)?.skipHistoryPrefetch).toBe(true);
      initSessions(dir);
      expect(getSessionEntry(ordinary)?.skipHistoryPrefetch).toBe(true);
      const later = createSession('chat', { platform });
      expect(getSessionEntry(later)?.skipHistoryPrefetch).toBe(true);
      expect(diskText()).not.toContain(secret);
      expect(diskText()).not.toContain(privateId);
    }
  );

  it('matches only a standalone explicit control command', () => {
    expect(parseSecretCommand('/secret ON')).toBe('on');
    expect(parseSecretCommand('/secret')).toBe('status');
    expect(parseSecretCommand('/secret@my_bot on')).toBe('on');
    expect(parseSecretCommand('!incognito on')).toBeUndefined();
    expect(parseSecretCommand('Explain /secret on')).toBeUndefined();
    expect(parseSecretCommand('/secret on\nsecret')).toBeUndefined();
  });

  it.each([
    ['discord', '123', 'discord:123'],
    ['slack', 'C:T', 'slack:C:T'],
    ['line', 'line:U1', 'line:U1'],
    ['telegram', 'telegram:dm:42', 'telegram:42'],
    ['telegram', 'telegram:chat:-42:topic:3', 'telegram:-42:topic:3'],
  ])(
    'suppresses %s monitor, events and timing even when a late callback follows close',
    (platform, contextKey, threadId) => {
      const id = createSession(contextKey, { platform, secret: true });
      expect(isSecretThread(threadId)).toBe(true);
      const ctx = { threadId, turnId: `private-turn-${contextKey}`, userText: secret };
      const received = vi.fn();
      const unsubscribe = subscribeEvents(received);
      const metric = new TurnLatencyRecorder({
        ...ctx,
        platform,
        firstTurn: true,
        receivedAt: Date.now(),
        workdir: dir,
      });
      startActivity(ctx);
      updateActivityText(ctx, secret);
      updateActivityTool(ctx, 'Bash', { command: secret });
      events.turnStarted(ctx);
      archiveSession(id);
      completeActivity(ctx, secret);
      events.turnComplete({ ...ctx, text: secret });
      // The record remembers the mode captured at construction.
      (metric as unknown as { append: (r: unknown) => void }).append({
        platform,
        thread_id: threadId,
      });
      expect(received).not.toHaveBeenCalled();
      expect(getActivity(threadId)).toBeUndefined();
      expect(diskText()).not.toContain(secret);
      unsubscribe();
    }
  );

  it('preserves a configured Stop gate in secret mode', async () => {
    const id = createWebSession({ secret: true });
    const stop = new StopHookRunner(
      [{ command: `printf '%s' '{"decision":"block","reason":"user-check"}'` }],
      dir
    );
    expect(
      await stop.run({
        hook_event_name: 'Stop',
        session_id: id,
        cwd: dir,
        stop_hook_active: false,
        last_assistant_message: 'done',
      })
    ).toEqual({ block: true, reason: 'user-check' });
  });

  it('preserves user hooks while isolating diagnostic suppression from concurrent ordinary requests', async () => {
    const id = createWebSession({ secret: true });
    const marker = join(dir, 'hook-ran');
    const submitMarker = join(dir, 'submit-hook-ran');
    const stop = new StopHookRunner([{ command: `touch '${marker}'` }], dir);
    const submit = new UserPromptSubmitHookRunner(
      [{ id: 'test', exec: { file: 'touch', args: [submitMarker] } }],
      dir
    );
    expect(
      await stop.run({
        hook_event_name: 'Stop',
        session_id: id,
        cwd: dir,
        stop_hook_active: false,
        last_assistant_message: secret,
      })
    ).toEqual({ block: false });
    expect(
      await submit.run({
        hook_event_name: 'UserPromptSubmit',
        session_id: id,
        cwd: dir,
        prompt: secret,
      })
    ).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(submitMarker)).toBe(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await Promise.all([
      withPrivateDiagnostics(true, async () => {
        await Promise.resolve();
        privacyConsole.log(secret);
      }),
      withPrivateDiagnostics(false, async () => {
        await Promise.resolve();
        privacyConsole.log('ordinary');
      }),
    ]);
    expect(spy.mock.calls).toEqual([['ordinary']]);
  });
});
