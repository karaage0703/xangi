import { afterEach, expect, it, vi } from 'vitest';
import { run } from '../src/cli/xangi.js';
import { updateCmd } from '../src/cli/update-cmd.js';
import { queueLifecycle } from '../src/cli/lifecycle-cmd.js';

vi.mock('../src/cli/update-cmd.js', async (original) => ({
  ...(await original<typeof import('../src/cli/update-cmd.js')>()),
  updateCmd: vi.fn(),
}));
vi.mock('../src/cli/lifecycle-cmd.js', () => ({
  queueLifecycle: vi.fn(),
  lifecycleStatus: vi.fn(),
  runLifecycle: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('awaits managed update directly and prints completion without queuing a restart helper', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let complete!: (value: string) => void;
  vi.mocked(updateCmd).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    })
  );
  const pending = run(['node', 'xangi', 'update', '--managed']);
  expect(updateCmd).toHaveBeenCalledWith({ managed: true });
  expect(output).not.toHaveBeenCalled();
  complete('To apply the update, run `xangi restart`.');
  await pending;
  expect(output).toHaveBeenCalledWith('To apply the update, run `xangi restart`.');
  expect(queueLifecycle).not.toHaveBeenCalled();
});

it('propagates update failure without a lifecycle receipt', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.mocked(updateCmd).mockRejectedValue(new Error('verification failed'));
  await expect(run(['node', 'xangi', 'update', '--managed'])).rejects.toThrow(
    'verification failed'
  );
  expect(output).not.toHaveBeenCalled();
  expect(queueLifecycle).not.toHaveBeenCalled();
});

it.each(['--help', '-h'])(
  'update %s describes manual restart without the removed --wait option',
  async (flag) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'xangi', 'update', flag]);
    const help = output.mock.calls.map(([line]) => line).join('\n');
    expect(help).toContain('Runs synchronously without an OS job');
    expect(help).toContain('run xangi restart separately');
    expect(help).not.toContain('--wait');
    expect(updateCmd).not.toHaveBeenCalled();
    expect(queueLifecycle).not.toHaveBeenCalled();
  }
);
