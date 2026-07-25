import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import { clearSessions, initSessions } from '../src/sessions.js';
import {
  _resetSlackStateForTest,
  createSlackCompletedBlocks,
  createSlackReplySuggestionBlocks,
  buildSlackCompletionNotification,
  processMessage,
  resolveSlackDeleteReactionTarget,
  shouldProcessSlackMessage,
  shouldReplyInSlackThread,
  slackConversationKey,
} from '../src/slack.js';

describe('Slack reply suggestion UI', () => {
  it('keeps reply suggestions collapsed behind one completed-message button', () => {
    const blocks = createSlackCompletedBlocks({
      showTools: true,
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
    const suggestionButton = blocks
      .flatMap((block) => (block.type === 'actions' ? block.elements : []))
      .find((element) => element.action_id === 'xangi_reply_suggestions');
    expect(JSON.parse(suggestionButton?.value ?? '{}')).toEqual({
      messageKey: 'C1:1.2',
      suggestions: ['a', 'b', 'c'],
      threadTs: THREAD_TS,
    });
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
        threadTs: undefined,
        elapsedMs: 95_000,
        thresholdMs: 10_000,
      })
    ).toBe('✅ 完了しました（1分35秒）');
  });

  it('does not notify while replying in a thread', () => {
    expect(
      buildSlackCompletionNotification({
        threadTs: THREAD_TS,
        elapsedMs: 95_000,
        thresholdMs: 10_000,
      })
    ).toBeNull();
  });

  it('does not notify below threshold', () => {
    expect(
      buildSlackCompletionNotification({
        threadTs: undefined,
        elapsedMs: 9_999,
        thresholdMs: 10_000,
      })
    ).toBeNull();
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
    const postMessage = vi.fn().mockResolvedValue({ ts: '1783402634.549099' });
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: { postMessage, update },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dev' } }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    } as unknown as WebClient;
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
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
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    const completedBlockText = completedUpdate.blocks.find((block) => block.type === 'section')
      ?.text?.text;
    expect(new TextEncoder().encode(completedUpdate.text)).toHaveLength(3000);
    expect(completedBlockText).toBe(completedUpdate.text);

    const continuationPayload = postMessage.mock.calls
      .map(([payload]) => payload as { text?: string; thread_ts?: string })
      .find((payload) => payload.text === 'あ'.repeat(1000));
    expect(continuationPayload).toEqual(
      expect.objectContaining({ thread_ts: THREAD_TS, text: 'あ'.repeat(1000) })
    );
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
