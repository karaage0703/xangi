import { describe, expect, it } from 'vitest';
import { shouldReplyInSlackThread } from '../src/slack.js';

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
});
