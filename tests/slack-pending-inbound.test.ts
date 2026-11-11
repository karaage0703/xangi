import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { AgentRunner } from '../src/agent-runner.js';
import { initSessions, clearSessions } from '../src/sessions.js';
import { initSettings, clearSettingsCache } from '../src/settings.js';
import { reserveConversation } from '../src/conversation-locks.js';

const mocked = vi.hoisted(() => ({
  actions: new Map<string | RegExp, (...args: any[]) => Promise<void>>(),
  events: new Map<string, (...args: any[]) => Promise<void>>(),
  client: {
    chat: { postMessage: vi.fn(), update: vi.fn() },
    conversations: { info: vi.fn() },
    reactions: { add: vi.fn(), remove: vi.fn() },
  },
  downloadFile: vi.fn(),
}));
vi.mock('@slack/bolt', () => ({
  App: class {
    client = mocked.client;
    action(id: string | RegExp, handler: (...args: any[]) => Promise<void>) {
      mocked.actions.set(id, handler);
    }
    event(id: string, handler: (...args: any[]) => Promise<void>) {
      mocked.events.set(id, handler);
    }
    command() {}
    view() {}
    async start() {}
  },
  LogLevel: { INFO: 'info' },
}));
vi.mock('../src/file-utils.js', async (original) => ({
  ...(await original<typeof import('../src/file-utils.js')>()),
  downloadFile: mocked.downloadFile,
}));
import {
  startSlackBot,
  _resetSlackStateForTest,
  slackPendingMessages,
  isSlackConversationBusy,
  createSlackRemoteInputBridge,
} from '../src/slack.js';

let dir: string;
let config: Config;
let runner: AgentRunner;
const runStream = vi.fn();
let sequence: number;
const flush = async () => {
  for (let i = 0; i < 150; i++) await Promise.resolve();
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'xangi-slack-pending-'));
  initSessions(dir);
  initSettings(dir);
  sequence = 0;
  mocked.actions.clear();
  mocked.events.clear();
  mocked.client.chat.postMessage.mockImplementation(async () => ({ ts: `receipt-${++sequence}` }));
  mocked.client.chat.update.mockResolvedValue({});
  mocked.client.conversations.info.mockResolvedValue({ channel: { name: 'dev' } });
  mocked.client.reactions.add.mockResolvedValue({});
  mocked.client.reactions.remove.mockResolvedValue({});
  mocked.downloadFile.mockResolvedValue('/tmp/pending-file.txt');
  runStream.mockResolvedValue({ result: 'ok', sessionId: 'provider' });
  runner = { runStream, getTimeoutState: () => undefined } as unknown as AgentRunner;
  config = {
    agent: { config: { workdir: dir } },
    slack: {
      botToken: 'test-only-token',
      appToken: 'test-only-app',
      allowedUsers: ['author'],
      autoReplyChannels: ['channel'],
      streaming: true,
      showThinking: false,
      replySuggestions: false,
    },
  } as Config;
  await startSlackBot({
    config,
    agentRunner: runner,
    resolver: {} as never,
    skills: [],
    reloadSkills: () => [],
  });
});
afterEach(() => {
  _resetSlackStateForTest();
  clearSessions();
  clearSettingsCache();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
async function send(
  ts: string,
  text: string,
  files?: unknown[],
  eventName = 'message',
  threadTs: string | null = 'thread'
) {
  await mocked.events.get(eventName)!({
    event: {
      channel: 'channel',
      user: 'author',
      ts,
      text,
      files,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      channel_type: 'channel',
    },
    client: mocked.client,
    say: vi.fn(),
  });
}
function receipts() {
  return mocked.client.chat.postMessage.mock.calls.filter(
    ([payload]) => payload.blocks?.[1]?.elements?.[0]?.action_id === 'xangi_pending_send'
  );
}
async function click(index: number, actionId = 'xangi_pending_send', userId = 'author') {
  const payload = receipts()[index][0];
  const posted =
    await mocked.client.chat.postMessage.mock.results[
      mocked.client.chat.postMessage.mock.calls.findIndex(([p]) => p === payload)
    ].value;
  const handler = [...mocked.actions.entries()].find(
    ([id]) => id instanceof RegExp && id.test(actionId)
  )?.[1];
  expect(handler).toBeDefined();
  const ack = vi.fn().mockResolvedValue(undefined),
    respond = vi.fn().mockResolvedValue(undefined);
  await handler!({
    ack,
    respond,
    action: { action_id: actionId, value: payload.blocks[1].elements[0].value },
    body: { channel: { id: 'channel' }, user: { id: userId }, message: { ts: posted.ts } },
    client: mocked.client,
  });
  expect(ack).toHaveBeenCalledOnce();
  return respond;
}

describe('Slack inbound pending-message integration', () => {
  it('queues ordinary and mention posts, preserves attachments and routing, cancels one and runs another after the active turn', async () => {
    const block = deferred();
    runStream.mockImplementationOnce(async () => {
      await block.promise;
      return { result: 'first', sessionId: 'provider' };
    });
    const active = send('first', '最初');
    await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(1));
    try {
      await send('second', '取消対象');
      await send(
        'third',
        '<@BOT> 添付の依頼',
        [{ name: 'pending-file.txt', url_private_download: 'https://files.slack.com/test' }],
        'app_mention'
      );
      expect(receipts()).toHaveLength(2);
      expect(receipts().every(([p]) => p.channel === 'channel' && p.thread_ts === 'thread')).toBe(
        true
      );
      await click(0);
      await click(1);
      await click(0, 'xangi_pending_cancel');
      expect(runStream).toHaveBeenCalledTimes(1);
      block.resolve();
      await active;
      await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(slackPendingMessages.isBusy('channel:thread')).toBe(false));
      expect(runStream.mock.calls[1][0]).toContain('添付の依頼');
      expect(runStream.mock.calls[1][0]).toContain('/tmp/pending-file.txt');
      expect(runStream.mock.calls[1][0]).not.toContain('取消対象');
      expect(runStream.mock.calls[1][2].channelId).toBe('channel:thread');
      expect(
        mocked.client.chat.postMessage.mock.calls.every(([p]) => p.thread_ts === 'thread')
      ).toBe(true);
      await send('after', '後続');
      expect(runStream).toHaveBeenCalledTimes(3);
    } finally {
      block.resolve();
      await active;
    }
  });

  it('protects receipts from unauthorized clicks and treats queued work as busy to Web continuations', async () => {
    const release = reserveConversation('channel:thread')!;
    try {
      await send('waiting', '予約対象');
      const denied = await click(0, 'xangi_pending_send', 'stranger');
      expect(denied).toHaveBeenCalledWith(
        expect.objectContaining({ replace_original: false, response_type: 'ephemeral' })
      );
      expect(runStream).not.toHaveBeenCalled();
      await click(0);
      expect(isSlackConversationBusy('channel')).toBe(true);
      // A new linked session has a different key; select the busy thread explicitly.
      const { ensureSession } = await import('../src/sessions.js');
      const id = ensureSession('channel:thread', { platform: 'slack' });
      const bridge = createSlackRemoteInputBridge(mocked.client as never, runner, config);
      await expect(
        bridge.continueSession({ appSessionId: id, message: 'Web重複' })
      ).rejects.toThrow('処理中');
      await click(0, 'xangi_pending_cancel');
      release();
      await flush();
      expect(runStream).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('keeps channel-level replies out of threads and starts a late selection on an idle conversation', async () => {
    config.slack.replyInThread = false;
    const release = reserveConversation('channel')!;
    try {
      await send('channel-post', 'チャンネルへの依頼', undefined, 'message', null);
      expect(receipts()).toHaveLength(1);
      expect(receipts()[0][0].thread_ts).toBeUndefined();
      release();
      await click(0);
      await vi.waitFor(() => expect(slackPendingMessages.isBusy('channel')).toBe(false));
      expect(runStream).toHaveBeenCalledOnce();
      expect(runStream.mock.calls[0][2].channelId).toBe('channel');
      expect(mocked.client.chat.postMessage.mock.calls.every(([p]) => !p.thread_ts)).toBe(true);
    } finally {
      release();
    }
  });

  it('does not double-enqueue duplicate Slack delivery and isolates another thread', async () => {
    const release = reserveConversation('channel:thread')!;
    try {
      await send('same', '予約対象');
      await send('same', '予約対象');
      expect(receipts()).toHaveLength(1);
      await click(0);
      await send('separate', '別スレッド', undefined, 'message', 'other');
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(runStream.mock.calls[0][2].channelId).toBe('channel:other');
      await click(0, 'xangi_pending_cancel');
      release();
      await flush();
      expect(runStream).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });
});
