import { describe, expect, it, vi } from 'vitest';
import { handleSlackRestartCommand } from '../src/slack.js';

describe('handleSlackRestartCommand', () => {
  it('acknowledges and requests the central restart path for an allowed user', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();

    await handleSlackRestartCommand({
      userId: 'U_ALLOWED',
      allowedUsers: ['U_ALLOWED'],
      ack,
      respond,
      selfLifecycle: 'restart-only',
      restart,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ text: '🔄 再起動します...' });
    expect(restart).toHaveBeenCalledWith(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthorized user without requesting a restart', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();

    await handleSlackRestartCommand({
      userId: 'U_OTHER',
      allowedUsers: ['U_ALLOWED'],
      ack,
      respond,
      selfLifecycle: 'restart-only',
      restart,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: '許可されていないユーザーです',
      response_type: 'ephemeral',
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it('does not request a restart when self lifecycle is disabled', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();

    await handleSlackRestartCommand({
      userId: 'U_ALLOWED',
      allowedUsers: ['U_ALLOWED'],
      ack,
      respond,
      selfLifecycle: 'off',
      restart,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: expect.stringContaining('XANGI_SELF_LIFECYCLE=restart-only'),
    });
    expect(restart).not.toHaveBeenCalled();
  });
});
