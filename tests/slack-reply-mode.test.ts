import { describe, expect, it } from 'vitest';
import { buildSlackCompletionNotification, shouldReplyInSlackThread } from '../src/slack.js';

describe('shouldReplyInSlackThread', () => {
  it('replies in threads by default', () => {
    expect(shouldReplyInSlackThread({}, 'C0AD8S0QCFP')).toBe(true);
  });

  it('disables thread replies globally when SLACK_REPLY_IN_THREAD=false', () => {
    expect(shouldReplyInSlackThread({ replyInThread: false }, 'C0AD8S0QCFP')).toBe(false);
  });

  it('disables thread replies only for configured channels', () => {
    const slackConfig = {
      replyInThread: true,
      replyInChannels: ['C0AD8S0QCFP'],
    };

    expect(shouldReplyInSlackThread(slackConfig, 'C0AD8S0QCFP')).toBe(false);
    expect(shouldReplyInSlackThread(slackConfig, 'COTHER')).toBe(true);
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
        threadTs: '1234567890.000001',
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
