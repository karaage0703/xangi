import { describe, expect, it, vi } from 'vitest';
import {
  formatDiscordDestinationLabel,
  warmDiscordScheduleDestinations,
} from '../src/discord/destination-label.js';
import type { Schedule } from '../src/scheduler.js';

describe('Discord destination labels', () => {
  it('formats a guild channel name', () => {
    expect(formatDiscordDestinationLabel({ name: 'dev_xangi' })).toBe('#dev_xangi');
  });

  it('includes the parent channel for a thread', () => {
    expect(
      formatDiscordDestinationLabel({
        name: '予定の表示改善',
        isThread: () => true,
        parent: { name: 'dev_xangi' },
      })
    ).toBe('#dev_xangi / 予定の表示改善');
  });

  it('warms only uncached Discord schedule destinations', async () => {
    const fetch = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        cache: new Map([['cached-channel', { name: 'cached' }]]),
        fetch,
      },
    };
    const schedules = [
      { platform: 'discord', channelId: 'cached-channel' },
      { platform: 'discord', channelId: 'new-channel' },
      { platform: 'discord', channelId: 'new-channel' },
      { platform: 'slack', channelId: 'slack-channel' },
    ] as Schedule[];

    await warmDiscordScheduleDestinations(client as never, schedules);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('new-channel');
  });
});
