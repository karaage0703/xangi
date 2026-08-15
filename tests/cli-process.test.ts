import { afterEach, describe, expect, it } from 'vitest';
import { buildCliEnv } from '../src/cli-process.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');

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

  it('injects the current chat platform for Discord, Slack, Telegram, and Web', () => {
    expect(buildCliEnv('ch1', 'slack').XANGI_PLATFORM).toBe('slack');
    expect(buildCliEnv('ch1', 'discord').XANGI_PLATFORM).toBe('discord');
    expect(buildCliEnv('telegram:chat:-100:topic:42', 'telegram').XANGI_PLATFORM).toBe('telegram');
    expect(buildCliEnv('web-chat:pane1', 'web').XANGI_PLATFORM).toBe('web');
  });

  it('does not leak the parent platform when the platform is unknown', () => {
    process.env.XANGI_PLATFORM = 'slack';

    const env = buildCliEnv('channel');

    expect(env.XANGI_PLATFORM).toBeUndefined();
  });

  it('pins the current instance bin directory ahead of the inherited PATH', () => {
    const env = buildCliEnv('channel');

    expect(env.PATH?.split(':')[0]).toBe(repoBin);
  });
});
