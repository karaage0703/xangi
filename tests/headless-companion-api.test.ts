import { describe, expect, it } from 'vitest';
import { __test__ } from '../src/web-chat.js';

describe('headless companion API allowlist', () => {
  it.each([
    ['GET', '/health'],
    ['GET', '/api/sessions'],
    ['POST', '/api/pet/inbox'],
    ['POST', '/api/device/inbox'],
    ['POST', '/api/terminal/inbox'],
  ])('allows %s %s', (method, url) => {
    expect(__test__.isHeadlessCompanionRequest(method, url)).toBe(true);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/app/main.js'],
    ['GET', '/workspace'],
    ['GET', '/api/workspace/file'],
    ['POST', '/api/sessions'],
    ['GET', '/api/usage'],
  ])('rejects %s %s', (method, url) => {
    expect(__test__.isHeadlessCompanionRequest(method, url)).toBe(false);
  });
});
