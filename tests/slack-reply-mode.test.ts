import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { AgentRunner } from '../src/agent-runner.js';
import type { BackendResolver, ChannelOverride } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { clearSessions, createWebSession, initSessions } from '../src/sessions.js';
import { logPrompt, readSessionMessages } from '../src/transcript-logger.js';
import {
  _resetSlackStateForTest,
  createSlackCompletedBlocks,
  createSlackHistoryBlocks,
  createSlackReplySuggestionBlocks,
  buildSlackCompletionNotification,
  dismissSlackHistory,
  executeSlackBackendCommand,
  processMessage,
  processSlackSkillCommand,
  resolveSlackDeleteReactionTarget,
  resolveSlackHistoryActionContext,
  shouldProcessSlackMessage,
  shouldReplyInSlackThread,
  slackConversationKey,
} from '../src/slack.js';

describe('Slack reply suggestion UI', () => {
  it('keeps reply suggestions collapsed behind one completed-message button', () => {
    const blocks = createSlackCompletedBlocks({
      threadTs: THREAD_TS,
      showTools: true,
      historyPayload: {
        threadId: `slack:${AUTO_REPLY_CHANNEL}:${THREAD_TS}`,
        turnId: 'slack-msg-123',
        threadTs: THREAD_TS,
      },
      showReplySuggestions: true,
      replySuggestionPayload: {
        messageKey: 'C1:1.2',
        suggestions: ['a', 'b', 'c'],
        threadTs: THREAD_TS,
      },
    });
    const actionIds = blocks.flatMap((block) =>
      block.type === 'actions' ? block.elements.map((element) => element.action_id) : []
    );
    expect(actionIds).toEqual(['xangi_new', 'xangi_tools', 'xangi_reply_suggestions']);
    const closeButton = blocks
      .flatMap((block) => (block.type === 'actions' ? block.elements : []))
      .find((element) => element.action_id === 'xangi_new');
    expect(closeButton?.text.text).toBe('Close');
    const historyButton = blocks
      .flatMap((block) => (block.type === 'actions' ? block.elements : []))
      .find((element) => element.action_id === 'xangi_tools');
    expect(historyButton?.text.text).toBe('History');
    expect(JSON.parse(historyButton?.value ?? '{}')).toEqual({
      threadId: `slack:${AUTO_REPLY_CHANNEL}:${THREAD_TS}`,
      turnId: 'slack-msg-123',
      threadTs: THREAD_TS,
    });
    const suggestionButton = blocks
      .flatMap((block) => (block.type === 'actions' ? block.elements : []))
      .find((element) => element.action_id === 'xangi_reply_suggestions');
    expect(JSON.parse(suggestionButton?.value ?? '{}')).toEqual({
      messageKey: 'C1:1.2',
      suggestions: ['a', 'b', 'c'],
      threadTs: THREAD_TS,
    });
  });

  it('keeps New for completed messages outside threads', () => {
    const blocks = createSlackCompletedBlocks();
    const newButton = blocks
      .flatMap((block) => (block.type === 'actions' ? block.elements : []))
      .find((element) => element.action_id === 'xangi_new');
    expect(newButton?.text.text).toBe('New');
  });

  it('keeps History ephemeral replies in the source thread', () => {
    expect(
      resolveSlackHistoryActionContext(undefined, JSON.stringify({ threadTs: THREAD_TS }))
    ).toEqual({ threadTs: THREAD_TS });
    expect(
      resolveSlackHistoryActionContext(
        { thread_ts: 'message-thread' },
        JSON.stringify({ threadTs: 'embedded-thread', threadId: 'slack:C:T', turnId: 'turn-1' })
      )
    ).toEqual({
      threadTs: 'message-thread',
      threadId: 'slack:C:T',
      turnId: 'turn-1',
    });
  });

  it('adds a dismiss button that deletes only the ephemeral History response', async () => {
    const blocks = createSlackHistoryBlocks('History\n🔧 Bash実行: pwd');
    expect(blocks).toEqual([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'History\n🔧 Bash実行: pwd' },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '閉じる' },
            action_id: 'xangi_history_dismiss',
          },
        ],
      },
    ]);

    const respond = vi.fn().mockResolvedValue(undefined);
    await dismissSlackHistory(respond);
    expect(respond).toHaveBeenCalledWith({ delete_original: true });
  });

  it('uses unique action IDs for the ephemeral number buttons', () => {
    const blocks = createSlackReplySuggestionBlocks('C1:1.2', ['a', 'b', 'c'], THREAD_TS);
    const actionIds = blocks.flatMap((block) =>
      block.type === 'actions' ? block.elements.map((element) => element.action_id) : []
    );
    expect(actionIds).toEqual([
      'xangi_reply_suggestion_0',
      'xangi_reply_suggestion_1',
      'xangi_reply_suggestion_2',
    ]);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    const values = blocks.flatMap((block) =>
      block.type === 'actions' ? block.elements.map((element) => JSON.parse(element.value)) : []
    );
    expect(values).toEqual([
      { messageKey: 'C1:1.2', index: 0, threadTs: THREAD_TS },
      { messageKey: 'C1:1.2', index: 1, threadTs: THREAD_TS },
      { messageKey: 'C1:1.2', index: 2, threadTs: THREAD_TS },
    ]);
  });
});

const AUTO_REPLY_CHANNEL = 'C_AUTO_REPLY';
const OTHER_CHANNEL = 'C_OTHER_CHANNEL';
const DM_CHANNEL = 'D_DIRECT';
const THREAD_TS = '1234567890.000001';

function createBackendResolverStub(defaultBackend = 'claude-code') {
  const overrides = new Map<string, ChannelOverride>();
  const resolver = {
    resolve: vi.fn((channelId: string) => ({
      backend: overrides.get(channelId)?.backend ?? defaultBackend,
      model: overrides.get(channelId)?.model,
      effort: overrides.get(channelId)?.effort,
    })),
    getDefault: vi.fn(() => ({ backend: defaultBackend })),
    getChannelOverride: vi.fn((channelId: string) => overrides.get(channelId)),
    setChannelOverride: vi.fn((channelId: string, override: ChannelOverride) => {
      overrides.set(channelId, override);
    }),
    deleteChannelOverride: vi.fn((channelId: string) => overrides.delete(channelId)),
    isBackendAllowed: vi.fn((backend: string) =>
      ['claude-code', 'codex', 'cursor'].includes(backend)
    ),
    isBackendSelectable: vi.fn((backend: string) =>
      ['claude-code', 'codex', 'cursor'].includes(backend)
    ),
    getAllowedBackends: vi.fn(() => ['claude-code', 'codex', 'cursor']),
    getSelectableBackends: vi.fn(() => ['claude-code', 'codex', 'cursor']),
    isModelAllowed: vi.fn(() => true),
  } as unknown as BackendResolver;
  return { resolver, overrides };
}

let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'xangi-slack-test-'));
  initSessions(tempDir);
  _resetSlackStateForTest();
});

afterEach(() => {
  clearSessions();
  _resetSlackStateForTest();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('Slack /backend command', () => {
  it('shows the effective channel backend', async () => {
    const { resolver, overrides } = createBackendResolverStub();
    overrides.set(AUTO_REPLY_CHANNEL, { backend: 'cursor', model: 'cursor-model' });

    await expect(
      executeSlackBackendCommand({
        text: 'show',
        channelId: AUTO_REPLY_CHANNEL,
        resolver,
        agentRunner: {} as AgentRunner,
      })
    ).resolves.toContain('Cursor');
  });

  it('sets the in-memory channel override and switches the active runner immediately', async () => {
    const { resolver } = createBackendResolverStub();
    const switchBackend = vi.fn();
    const agentRunner = { switchBackend } as unknown as AgentRunner;

    const result = await executeSlackBackendCommand({
      text: 'set cursor --model cursor-model --effort high',
      channelId: AUTO_REPLY_CHANNEL,
      resolver,
      agentRunner,
    });

    expect(resolver.setChannelOverride).toHaveBeenCalledWith(AUTO_REPLY_CHANNEL, {
      backend: 'cursor',
      model: 'cursor-model',
      effort: 'high',
    });
    expect(switchBackend).toHaveBeenCalledWith(AUTO_REPLY_CHANNEL);
    expect(result).toContain('新しいセッションを開始します');
  });

  it('resets the channel override and switches the active runner immediately', async () => {
    const { resolver, overrides } = createBackendResolverStub();
    overrides.set(AUTO_REPLY_CHANNEL, { backend: 'cursor' });
    const switchBackend = vi.fn();

    await executeSlackBackendCommand({
      text: 'reset',
      channelId: AUTO_REPLY_CHANNEL,
      resolver,
      agentRunner: { switchBackend } as unknown as AgentRunner,
    });

    expect(resolver.deleteChannelOverride).toHaveBeenCalledWith(AUTO_REPLY_CHANNEL);
    expect(switchBackend).toHaveBeenCalledWith(AUTO_REPLY_CHANNEL);
  });

  it('rejects a backend outside ALLOWED_BACKENDS without changing state', async () => {
    const { resolver } = createBackendResolverStub();

    await expect(
      executeSlackBackendCommand({
        text: 'set local-llm',
        channelId: AUTO_REPLY_CHANNEL,
        resolver,
        agentRunner: {} as AgentRunner,
      })
    ).rejects.toThrow('現在利用できません');
    expect(resolver.setChannelOverride).not.toHaveBeenCalled();
  });

  it('clears existing thread sessions and runner instances when switching a channel', async () => {
    const { resolver } = createBackendResolverStub();
    const runKey = slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS);
    const postMessage = vi.fn().mockResolvedValue({ ts: '1783402634.549099' });
    const client = {
      chat: { postMessage, update: vi.fn().mockResolvedValue({}) },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi
      .fn()
      .mockResolvedValueOnce({ result: 'first', sessionId: 'provider-1' })
      .mockResolvedValueOnce({ result: 'second', sessionId: 'provider-2' });
    const switchBackend = vi.fn();
    const agentRunner = {
      runStream,
      switchBackend,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: false, showThinking: false, replySuggestions: false },
    } as Config;

    await processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '最初',
      '1783402632.322829',
      client,
      agentRunner,
      config
    );
    expect(runStream.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ sessionId: undefined, settingsChannelId: AUTO_REPLY_CHANNEL })
    );

    await executeSlackBackendCommand({
      text: 'set cursor',
      channelId: AUTO_REPLY_CHANNEL,
      resolver,
      agentRunner,
    });
    expect(switchBackend).toHaveBeenCalledWith(AUTO_REPLY_CHANNEL);
    expect(switchBackend).toHaveBeenCalledWith(runKey);

    await processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '切替後',
      '1783402633.322829',
      client,
      agentRunner,
      config
    );
    expect(runStream.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ sessionId: undefined, settingsChannelId: AUTO_REPLY_CHANNEL })
    );
  });
});

describe('shouldReplyInSlackThread', () => {
  it('replies in threads by default', () => {
    expect(shouldReplyInSlackThread({}, AUTO_REPLY_CHANNEL)).toBe(true);
  });

  it('disables thread replies globally when SLACK_REPLY_IN_THREAD=false', () => {
    expect(shouldReplyInSlackThread({ replyInThread: false }, AUTO_REPLY_CHANNEL)).toBe(false);
  });

  it('disables thread replies only for configured channels', () => {
    const slackConfig = {
      replyInThread: true,
      replyInChannels: [AUTO_REPLY_CHANNEL],
    };

    expect(shouldReplyInSlackThread(slackConfig, AUTO_REPLY_CHANNEL)).toBe(false);
    expect(shouldReplyInSlackThread(slackConfig, OTHER_CHANNEL)).toBe(true);
  });

  it('builds a completion notification for non-thread replies after threshold', () => {
    expect(
      buildSlackCompletionNotification({
        elapsedMs: 95_000,
        thresholdMs: 10_000,
        display: { showElapsed: true },
      })
    ).toBe('✅ 完了（⏱ 1分35秒）');
  });

  it('does not notify below threshold', () => {
    expect(
      buildSlackCompletionNotification({
        elapsedMs: 9_999,
        thresholdMs: 10_000,
        display: { showElapsed: true },
      })
    ).toBeNull();
  });

  it('posts completion metrics into the active Slack thread', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1783402634.549099' });
    const client = {
      chat: { postMessage, update: vi.fn().mockResolvedValue({}) },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
      callbacks.onComplete?.({
        result: 'ok',
        sessionId: 'provider-1',
      });
      return {
        result: 'ok',
        sessionId: 'provider-1',
      };
    });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      completion: { showElapsed: true, notifyAfterMs: 10_000 },
      slack: {
        streaming: true,
        showThinking: true,
        replySuggestions: false,
        completionNotifyAfterMs: 0,
      },
    } as Config;

    await processMessage(
      AUTO_REPLY_CHANNEL,
      slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS),
      THREAD_TS,
      '完了メトリクステスト',
      '1783402632.322829',
      client,
      agentRunner,
      config
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: AUTO_REPLY_CHANNEL,
        thread_ts: THREAD_TS,
        text: expect.stringMatching(/^✅ 完了（⏱ .+）$/),
      })
    );
  });
});

describe('shouldProcessSlackMessage', () => {
  it('processes DMs', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [] },
        { channel: DM_CHANNEL, channelType: 'im' }
      )
    ).toBe(true);
  });

  it('processes messages in auto-reply channels', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        { channel: AUTO_REPLY_CHANNEL, channelType: 'group' }
      )
    ).toBe(true);
  });

  it('uses a runtime auto-reply override ahead of the startup channel list', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [] },
        { channel: AUTO_REPLY_CHANNEL, channelType: 'group', autoReplyEnabled: true }
      )
    ).toBe(true);
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        { channel: AUTO_REPLY_CHANNEL, channelType: 'group', autoReplyEnabled: false }
      )
    ).toBe(false);
  });

  it('does not process threads in non-auto-reply channels', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: OTHER_CHANNEL,
          channelType: 'group',
          threadTs: THREAD_TS,
        }
      )
    ).toBe(false);
  });

  it('processes replies in active Slack thread sessions without mention', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: OTHER_CHANNEL,
          channelType: 'group',
          threadTs: THREAD_TS,
          hasActiveThreadSession: true,
        }
      )
    ).toBe(true);
  });

  it('does not process inactive Slack thread replies outside auto-reply channels', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: OTHER_CHANNEL,
          channelType: 'group',
          threadTs: THREAD_TS,
          hasActiveThreadSession: false,
        }
      )
    ).toBe(false);
  });

  it('does not process Slack system messages in auto-reply channels', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: AUTO_REPLY_CHANNEL,
          channelType: 'group',
          subtype: 'channel_name',
        }
      )
    ).toBe(false);
  });

  it('processes Slack file share messages in auto-reply channels', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: AUTO_REPLY_CHANNEL,
          channelType: 'group',
          subtype: 'file_share',
        }
      )
    ).toBe(true);
  });

  it('processes Slack file share messages in DMs', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [] },
        {
          channel: DM_CHANNEL,
          channelType: 'im',
          subtype: 'file_share',
        }
      )
    ).toBe(true);
  });

  it('processes Slack file share replies in active thread sessions', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: OTHER_CHANNEL,
          channelType: 'group',
          threadTs: THREAD_TS,
          subtype: 'file_share',
          hasActiveThreadSession: true,
        }
      )
    ).toBe(true);
  });

  it('does not process Slack file share replies outside active or auto-reply contexts', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: OTHER_CHANNEL,
          channelType: 'group',
          threadTs: THREAD_TS,
          subtype: 'file_share',
          hasActiveThreadSession: false,
        }
      )
    ).toBe(false);
  });

  it('processes Slack /me messages in auto-reply channels', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [AUTO_REPLY_CHANNEL] },
        {
          channel: AUTO_REPLY_CHANNEL,
          channelType: 'group',
          subtype: 'me_message',
        }
      )
    ).toBe(true);
  });

  it('processes Slack /me messages in DMs', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [] },
        {
          channel: DM_CHANNEL,
          channelType: 'im',
          subtype: 'me_message',
        }
      )
    ).toBe(true);
  });

  it('does not process Slack system messages in DMs', () => {
    expect(
      shouldProcessSlackMessage(
        { autoReplyChannels: [] },
        {
          channel: DM_CHANNEL,
          channelType: 'im',
          subtype: 'channel_join',
        }
      )
    ).toBe(false);
  });
});

describe('slackConversationKey', () => {
  it('uses channel ID for top-level/non-thread conversations', () => {
    expect(slackConversationKey(AUTO_REPLY_CHANNEL)).toBe(AUTO_REPLY_CHANNEL);
  });

  it('includes thread timestamp for Slack thread conversations', () => {
    expect(slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS)).toBe(
      `${AUTO_REPLY_CHANNEL}:${THREAD_TS}`
    );
  });
});

describe('resolveSlackDeleteReactionTarget', () => {
  it('accepts wastebasket and x reactions from allowed users by default', () => {
    const wastebasketTarget = resolveSlackDeleteReactionTarget(
      { allowedUsers: ['U_ALLOWED'] },
      {
        user: 'U_ALLOWED',
        reaction: 'wastebasket',
        item: { type: 'message', channel: AUTO_REPLY_CHANNEL, ts: '1783487000.000100' },
      }
    );
    const xTarget = resolveSlackDeleteReactionTarget(
      { allowedUsers: ['U_ALLOWED'] },
      {
        user: 'U_ALLOWED',
        reaction: 'x',
        item: { type: 'message', channel: AUTO_REPLY_CHANNEL, ts: '1783487000.000101' },
      }
    );

    expect(wastebasketTarget).toEqual({
      channelId: AUTO_REPLY_CHANNEL,
      messageTs: '1783487000.000100',
      userId: 'U_ALLOWED',
      reaction: 'wastebasket',
    });
    expect(xTarget?.reaction).toBe('x');
  });

  it('ignores delete reactions when the feature is disabled', () => {
    expect(
      resolveSlackDeleteReactionTarget(
        { allowedUsers: ['U_ALLOWED'], reactionDeleteEnabled: false },
        {
          user: 'U_ALLOWED',
          reaction: 'x',
          item: { type: 'message', channel: AUTO_REPLY_CHANNEL, ts: '1783487000.000100' },
        }
      )
    ).toBeNull();
  });

  it('ignores reactions from unauthorized users', () => {
    expect(
      resolveSlackDeleteReactionTarget(
        { allowedUsers: ['U_ALLOWED'] },
        {
          user: 'U_OTHER',
          reaction: 'x',
          item: { type: 'message', channel: AUTO_REPLY_CHANNEL, ts: '1783487000.000100' },
        }
      )
    ).toBeNull();
  });

  it('uses custom delete reaction names', () => {
    const target = resolveSlackDeleteReactionTarget(
      { allowedUsers: ['*'], deleteReactions: ['xangi_delete'] },
      {
        user: 'U_ANY',
        reaction: 'xangi_delete',
        item: { type: 'message', channel: AUTO_REPLY_CHANNEL, ts: '1783487000.000100' },
      }
    );

    expect(target?.reaction).toBe('xangi_delete');
  });

  it('ignores non-message reaction targets', () => {
    expect(
      resolveSlackDeleteReactionTarget(
        { allowedUsers: ['*'] },
        {
          user: 'U_ANY',
          reaction: 'x',
          item: { type: 'file', channel: AUTO_REPLY_CHANNEL, ts: '1783487000.000100' },
        }
      )
    ).toBeNull();
  });
});

describe('processMessage', () => {
  it('routes /skill execution through the normal Slack turn pipeline', async () => {
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1783402634.549099' }),
        update,
      },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
      callbacks.onToolUse?.('Bash', { command: 'pwd' });
      const result = {
        result:
          '完了\n<xangi_reply_suggestions>["続けて","詳しく","別案"]</xangi_reply_suggestions>',
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
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: false, showThinking: false, replySuggestions: true },
    } as Config;

    await processSlackSkillCommand(
      AUTO_REPLY_CHANNEL,
      'xs-test',
      '対象',
      'trigger-1',
      client,
      agentRunner,
      config
    );

    expect(runStream.mock.calls[0]?.[0]).toContain('スキル「xs-test」を実行してください');
    expect(runStream.mock.calls[0]?.[0]).toContain('引数: 対象');
    expect(runStream.mock.calls[0]?.[0]).toContain('<xangi_reply_suggestions>');
    expect(update.mock.calls.at(-1)?.[0].text).toBe('完了');
    expect(update.mock.calls.at(-1)?.[0].text).not.toContain('xangi_reply_suggestions');
  });

  it('injects linked Web session history into the Slack turn', async () => {
    const sessionId = createWebSession({ title: 'Slackから参照' });
    logPrompt(tempDir!, sessionId, 'Web UIで決めた内容');
    const linkedMessageId = readSessionMessages(tempDir!, sessionId)[0].id;
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1783402634.549099' }),
        update: vi.fn().mockResolvedValue({}),
      },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
      callbacks.onComplete?.({ result: 'ok', sessionId: 'provider-1' });
      return { result: 'ok', sessionId: 'provider-1' };
    });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: true, showThinking: true, replySuggestions: false },
    } as Config;

    await processMessage(
      AUTO_REPLY_CHANNEL,
      slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS),
      THREAD_TS,
      `これを参照 https://xangi.test/chat/${sessionId}#message-${linkedMessageId}`,
      '1783402632.322829',
      client,
      agentRunner,
      config
    );

    expect(runStream.mock.calls[0]?.[0]).toContain('<referenced-message platform="web"');
    expect(runStream.mock.calls[0]?.[0]).toContain('Web UIで決めた内容');
  });

  it('uses conversationKey as runner channelId while posting to Slack channelId', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1783402634.549099' });
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: { postMessage, update },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks, _options) => {
      callbacks.onToolUse?.('Bash', { command: 'pwd' });
      callbacks.onText?.('**ok**', '**ok**');
      callbacks.onComplete?.({ result: '**ok**', sessionId: 'provider-1' });
      return { result: '**ok**', sessionId: 'provider-1' };
    });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: true, showThinking: true },
    } as Config;
    const runKey = slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS);

    await processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '続き',
      '1783402632.322829',
      client,
      agentRunner,
      config
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: AUTO_REPLY_CHANNEL,
        thread_ts: THREAD_TS,
      })
    );
    expect(runStream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        channelId: runKey,
        settingsChannelId: AUTO_REPLY_CHANNEL,
        appSessionId: expect.any(String),
      })
    );
    expect(runStream.mock.calls[0]?.[0]).toContain('<xangi_reply_suggestions>');
    const lastUpdate = update.mock.calls.at(-1)?.[0] as {
      text?: string;
      blocks?: Array<{ type?: string; elements?: Array<{ action_id?: string }> }>;
    };
    expect(lastUpdate.text?.replaceAll('\u200B', '')).toBe('*ok*');
    expect(lastUpdate.text).not.toContain('Bash実行');
    expect(
      lastUpdate.blocks?.some((block) =>
        block.elements?.some((element) => element.action_id === 'xangi_tools')
      )
    ).toBe(true);
    expect(
      lastUpdate.blocks?.some((block) =>
        block.elements?.some((element) => element.action_id === 'xangi_reply_suggestions')
      )
    ).toBe(true);
    expect(lastUpdate.text).not.toContain('返信候補');
  });

  it('uses the same byte limit for completed Block Kit text and message splitting', async () => {
    const result = 'あ'.repeat(2000); // 6000 UTF-8 bytes
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: '1783402634.549099' })
      .mockResolvedValueOnce({ ts: '1783402635.000200' });
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: { postMessage, update },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
      callbacks.onToolUse?.('Bash', { command: 'pwd' });
      callbacks.onText?.(result, result);
      callbacks.onComplete?.({ result, sessionId: 'provider-1' });
      return { result, sessionId: 'provider-1' };
    });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: true, showThinking: true },
    } as Config;
    const runKey = slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS);

    await processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '長文テスト',
      '1783402632.322829',
      client,
      agentRunner,
      config
    );

    const completedUpdate = update.mock.calls.at(-1)?.[0] as {
      ts: string;
      text: string;
      blocks: Array<{
        type: string;
        text?: { text: string };
        elements?: Array<{ action_id?: string }>;
      }>;
    };
    const completedBlockText = completedUpdate.blocks.find((block) => block.type === 'section')
      ?.text?.text;
    expect(completedUpdate.ts).toBe('1783402635.000200');
    expect(new TextEncoder().encode(completedUpdate.text)).toHaveLength(3000);
    expect(completedBlockText).toBe(completedUpdate.text);
    expect(
      completedUpdate.blocks.some((block) =>
        block.elements?.some((element) => element.action_id === 'xangi_tools')
      )
    ).toBe(true);
    expect(
      update.mock.calls.some(
        ([payload]) => payload.ts === '1783402634.549099' && payload.blocks?.length === 0
      )
    ).toBe(true);

    const continuationPayload = postMessage.mock.calls
      .map(([payload]) => payload as { text?: string; thread_ts?: string })
      .find((payload) => payload.text === 'あ'.repeat(1000));
    expect(continuationPayload).toEqual(
      expect.objectContaining({ thread_ts: THREAD_TS, text: 'あ'.repeat(1000) })
    );
  });

  it('splits explicit separators and puts completed buttons on the final message', async () => {
    const result = '最初の投稿\n\n===\n\n途中の投稿\n\n===\n\n最後の投稿';
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: '1783402634.549099' })
      .mockResolvedValueOnce({ ts: '1783402635.000200' })
      .mockResolvedValueOnce({ ts: '1783402636.000300' });
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: { postMessage, update },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
      callbacks.onToolUse?.('Bash', { command: 'pwd' });
      callbacks.onText?.(result, result);
      callbacks.onComplete?.({ result, sessionId: 'provider-1' });
      return { result, sessionId: 'provider-1' };
    });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: true, showThinking: true },
    } as Config;
    const runKey = slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS);

    await processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '明示分割テスト',
      '1783402632.322829',
      client,
      agentRunner,
      config
    );

    const postedTexts = postMessage.mock.calls
      .slice(1)
      .map(([payload]) => (payload as { text?: string }).text);
    expect(postedTexts).toEqual(['途中の投稿', '最後の投稿']);
    expect(update.mock.calls.some(([payload]) => payload.text === '最初の投稿')).toBe(true);
    expect(
      update.mock.calls
        .filter(([payload]) => payload.blocks?.length === 0)
        .some(([payload]) => String(payload.text).includes('==='))
    ).toBe(false);
    expect(postedTexts.some((text) => text?.includes('==='))).toBe(false);

    const completedUpdate = update.mock.calls.at(-1)?.[0] as {
      ts: string;
      text: string;
      blocks: Array<{
        type: string;
        elements?: Array<{ action_id?: string }>;
      }>;
    };
    expect(completedUpdate.ts).toBe('1783402636.000300');
    expect(completedUpdate.text).toBe('最後の投稿');
    expect(
      completedUpdate.blocks.some((block) =>
        block.elements?.some((element) => element.action_id === 'xangi_tools')
      )
    ).toBe(true);
    expect(
      completedUpdate.blocks.some((block) =>
        block.elements?.some((element) => element.action_id === 'xangi_reply_suggestions')
      )
    ).toBe(true);
    expect(
      update.mock.calls.some(
        ([payload]) => payload.ts === '1783402634.549099' && payload.blocks?.length === 0
      )
    ).toBe(true);
  });

  it('skips a second run while the same conversationKey is busy', async () => {
    let release!: () => void;
    const firstRun = new Promise<{ result: string; sessionId: string }>((resolve) => {
      release = () => resolve({ result: 'ok', sessionId: 'provider-1' });
    });
    const postMessage = vi.fn().mockResolvedValue({ ts: '1783402634.549099' });
    const client = {
      chat: { postMessage, update: vi.fn().mockResolvedValue({}) },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi
      .fn()
      .mockImplementationOnce(async () => firstRun)
      .mockResolvedValue({ result: 'second', sessionId: 'provider-2' });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      slack: { streaming: true, showThinking: true },
    } as Config;
    const runKey = slackConversationKey(AUTO_REPLY_CHANNEL, THREAD_TS);

    const first = processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '最初',
      '1783402632.322829',
      client,
      agentRunner,
      config
    );
    await new Promise((resolve) => setImmediate(resolve));

    await processMessage(
      AUTO_REPLY_CHANNEL,
      runKey,
      THREAD_TS,
      '二重',
      '1783402633.000000',
      client,
      agentRunner,
      config
    );
    release();
    await first;

    expect(runStream).toHaveBeenCalledTimes(1);
  });
});
