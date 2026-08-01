import { afterEach, describe, expect, it } from 'vitest';
import { buildCliEnv } from '../src/cli-process.js';

describe('buildCliEnv', () => {
  const originalChannelId = process.env.XANGI_CHANNEL_ID;

  afterEach(() => {
    if (originalChannelId === undefined) {
      delete process.env.XANGI_CHANNEL_ID;
    } else {
      process.env.XANGI_CHANNEL_ID = originalChannelId;
    }
  });

  it('injects the provided channel id', () => {
    process.env.XANGI_CHANNEL_ID = 'parent-channel';

    const env = buildCliEnv('request-channel');

    expect(env.XANGI_CHANNEL_ID).toBe('request-channel');
  });

  it('does not leak the parent channel id when no channel is provided', () => {
    process.env.XANGI_CHANNEL_ID = 'parent-channel';

    const env = buildCliEnv();

    expect(env.XANGI_CHANNEL_ID).toBeUndefined();
  });

  it('injects the current chat platform for Discord, Slack, and Web', () => {
    expect(buildCliEnv('ch1', 'slack').XANGI_PLATFORM).toBe('slack');
    expect(buildCliEnv('ch1', 'discord').XANGI_PLATFORM).toBe('discord');
    expect(buildCliEnv('web-chat:pane1', 'web').XANGI_PLATFORM).toBe('web');
  });

  it('does not leak the parent platform when the platform is unknown', () => {
    process.env.XANGI_PLATFORM = 'slack';

    const env = buildCliEnv('channel');

    expect(env.XANGI_PLATFORM).toBeUndefined();
  });
});
