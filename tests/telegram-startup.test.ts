import { describe, expect, it, vi } from 'vitest';
import { startSupervisedTelegramPolling } from '../src/telegram.js';

describe('Telegram polling startup', () => {
  it('resolves only after the first polling onStart callback', async () => {
    const bot = {
      start: vi.fn(async ({ onStart }: { onStart: () => void }) => {
        onStart();
      }),
      isRunning: vi.fn(() => true),
    };

    await expect(startSupervisedTelegramPolling(bot as never)).resolves.toBeUndefined();
  });

  it('rejects a permanent conflict before reporting readiness', async () => {
    const conflict = { error_code: 409, description: 'Conflict: terminated by other getUpdates' };
    const bot = {
      start: vi.fn(async () => {
        throw conflict;
      }),
      isRunning: vi.fn(() => false),
    };

    await expect(startSupervisedTelegramPolling(bot as never)).rejects.toThrow(
      'Another process is using this bot token'
    );
  });

  it('exits for service-manager recovery after a permanent post-start failure', async () => {
    let failPolling!: (error: unknown) => void;
    const bot = {
      start: vi.fn(
        ({ onStart }: { onStart: () => void }) =>
          new Promise<void>((_resolve, reject) => {
            failPolling = reject;
            onStart();
          })
      ),
      isRunning: vi.fn(() => true),
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startSupervisedTelegramPolling(bot as never);
    failPolling(new Error('permanent polling failure'));
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
