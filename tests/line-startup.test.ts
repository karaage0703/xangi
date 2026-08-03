import { createServer, type Server } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { startLineBot } from '../src/line.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

const options = {
  agentRunner: {} as never,
  resolver: {} as never,
  channelSecret: 'secret',
  channelAccessToken: 'token',
  allowedUsers: ['*'],
};

describe('LINE webhook startup', () => {
  it('resolves only after listening', async () => {
    const server = await startLineBot({ ...options, port: 0 });
    servers.push(server);
    const address = server.address();
    expect(typeof address === 'object' && address?.port).toBeGreaterThan(0);
  });

  it('rejects a port conflict without an uncaught server error', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');

    await expect(startLineBot({ ...options, port: address.port })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
