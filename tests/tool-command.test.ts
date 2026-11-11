import { describe, expect, it, vi } from 'vitest';
import { parseToolCommandArgs, runToolCommand } from '../src/cli/tool-command.js';

describe('tool command dispatcher', () => {
  it.each([
    ['--help'],
    ['-h'],
    ['help'],
    ['system_restart', '--help'],
    ['system_restart', '-h'],
    ['extension_request', '--query-json-stdin', '--help'],
  ])('sends only a help request for %j', async (...args) => {
    const readStdin = vi.fn();
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        command: 'help',
        flags: args[0].startsWith('-') || args[0] === 'help' ? {} : { topic: args[0] },
      });
      return new Response(JSON.stringify({ ok: true, result: 'Usage: help' }));
    });
    await expect(
      runToolCommand(args, {
        env: { XANGI_TOOL_SERVER: 'http://127.0.0.1:41001' },
        fetchImpl,
        readStdin,
      })
    ).resolves.toBe('Usage: help');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('preserves flag values as JSON data', () => {
    expect(
      parseToolCommandArgs(['discord_send', '--message', 'quote " newline\n backslash \\', '--silent'])
    ).toEqual({
      command: 'discord_send',
      flags: { message: 'quote " newline\n backslash \\', silent: 'true' },
    });
  });

  it('forwards the Slack user identity through the CLI dispatcher', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        command: 'slack_send',
        flags: { as: 'user', message: 'owner-approved' },
        context: { channelId: 'C123', platform: 'slack' },
      });
      return new Response(JSON.stringify({ ok: true, result: 'sent' }));
    });
    await expect(
      runToolCommand(['slack_send', '--as', 'user', '--message', 'owner-approved'], {
        env: {
          XANGI_TOOL_SERVER: 'http://127.0.0.1:41001',
          XANGI_CHANNEL_ID: 'C123',
          XANGI_PLATFORM: 'slack',
        },
        fetchImpl,
      })
    ).resolves.toBe('sent');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps multiple instances isolated by their injected endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const endpoint = String(input);
      return new Response(
        JSON.stringify({ ok: true, result: endpoint.includes('41001') ? 'instance-a' : 'instance-b' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    });

    const first = await runToolCommand(['schedule_list'], {
      env: { XANGI_TOOL_SERVER: 'http://127.0.0.1:41001' },
      fetchImpl,
    });
    const second = await runToolCommand(['schedule_list'], {
      env: { XANGI_TOOL_SERVER: 'http://127.0.0.1:41002' },
      fetchImpl,
    });

    expect(first).toBe('instance-a');
    expect(second).toBe('instance-b');
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:41001/api/execute',
      'http://127.0.0.1:41002/api/execute',
    ]);
  });

  it('reads extension query JSON from stdin without forwarding the marker flag', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.flags).toEqual({
        id: 'xangi-search',
        capability: 'workspace.search',
        path: '/search',
        'query-json': '{"q":"secret query","k":4}',
      });
      return new Response(JSON.stringify({ ok: true, result: 'found' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      runToolCommand(
        [
          'extension_request',
          '--id',
          'xangi-search',
          '--capability',
          'workspace.search',
          '--path',
          '/search',
          '--query-json-stdin',
        ],
        {
          env: { XANGI_TOOL_SERVER: 'http://127.0.0.1:41001' },
          fetchImpl,
          readStdin: async () => '{"q":"secret query","k":4}',
        }
      )
    ).resolves.toBe('found');
  });

  it('rejects query stdin outside extension_request and conflicting query sources', async () => {
    await expect(
      runToolCommand(['schedule_list', '--query-json-stdin'], {
        env: { XANGI_TOOL_SERVER: 'http://127.0.0.1:41001' },
        readStdin: async () => '{}',
      })
    ).rejects.toThrow(/only supported by extension_request/);
    await expect(
      runToolCommand(
        ['extension_request', '--query-json', '{}', '--query-json-stdin'],
        {
          env: { XANGI_TOOL_SERVER: 'http://127.0.0.1:41001' },
          readStdin: async () => '{}',
        }
      )
    ).rejects.toThrow(/cannot be used together/);
  });
});
