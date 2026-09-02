import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { XANGI_SHUTDOWN_TIMEOUT_MS } from '../src/shutdown.js';

const require = createRequire(import.meta.url);

describe('PM2 ecosystem config', () => {
  it('waits longer than xangi shutdown cleanup before force killing the process', () => {
    const config = require('../ecosystem.config.cjs') as {
      apps: Array<{ kill_timeout?: number }>;
    };

    expect(config.apps[0]?.kill_timeout).toBe(10_000);
    expect(config.apps[0]?.kill_timeout).toBeGreaterThan(XANGI_SHUTDOWN_TIMEOUT_MS);
  });
});
