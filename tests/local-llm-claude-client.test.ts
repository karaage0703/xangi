import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { ClaudeCliClient } from '../src/local-llm/claude-client.js';

class MockProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.emit('close', 0);
    return true;
  });
}

let mockProcess: MockProcess;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    mockProcess = new MockProcess();
    return mockProcess;
  }),
}));

async function getSpawnArgs(client: ClaudeCliClient) {
  const { spawn } = await import('child_process');
  const promise = client.chat([{ role: 'user', content: 'hello' }], {
    systemPrompt: 'system',
    channelId: 'ch1',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  mockProcess.stdout.emit(
    'data',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      session_id: 'session-1',
    })
  );
  mockProcess.emit('close', 0);
  await promise;

  const spawnMock = spawn as ReturnType<typeof vi.fn>;
  return spawnMock.mock.calls[0][1] as string[];
}

describe('ClaudeCliClient args', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes permission mode and add-dir without bypass permissions', async () => {
    const client = new ClaudeCliClient({
      cwd: '/tmp/work',
      skipPermissions: false,
      permissionMode: 'auto',
      addDirs: ['/tmp/work', '/tmp/other'],
      allowedTools: ['Read', 'Edit', 'Bash(git status:*)'],
    });

    const args = await getSpawnArgs(client);

    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(args).toContain('--add-dir');
    expect(args.slice(args.indexOf('--add-dir') + 1, args.indexOf('--allowed-tools'))).toEqual([
      '/tmp/work',
      '/tmp/other',
    ]);
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Read,Edit,Bash(git status:*)');
  });
});
