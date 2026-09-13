import type { IncomingMessage } from 'http';
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { acceptsSameHostMutation, readJsonBody, readRawBody, uploadMaxBytes } from '../src/web-http.js';

function requestWithHeaders(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

function requestBody(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as IncomingMessage;
}

describe('web HTTP helpers', () => {
  it('accepts absent or same-host origins and rejects foreign origins', () => {
    expect(acceptsSameHostMutation(requestWithHeaders({ host: 'localhost:3000' }))).toBe(true);
    expect(
      acceptsSameHostMutation(
        requestWithHeaders({ host: 'localhost:3000', origin: 'http://localhost:3000' })
      )
    ).toBe(true);
    expect(
      acceptsSameHostMutation(
        requestWithHeaders({ host: 'localhost:3000', origin: 'https://example.com' })
      )
    ).toBe(false);
    expect(
      acceptsSameHostMutation(requestWithHeaders({ host: 'localhost:3000', origin: 'invalid' }))
    ).toBe(false);
  });

  it('parses valid JSON and preserves the existing empty-object fallback', async () => {
    await expect(readJsonBody(requestBody('{"ok":true}'))).resolves.toEqual({ ok: true });
    await expect(readJsonBody(requestBody('not json'))).resolves.toEqual({});
  });

  it('enforces raw body limits', async () => {
    await expect(readRawBody(requestBody('1234'), 4)).resolves.toBe('1234');
    await expect(readRawBody(requestBody('12345'), 4)).rejects.toThrow('body is too large');
  });

  it('uses a safe upload default for invalid values', () => {
    expect(uploadMaxBytes(undefined)).toBe(64 * 1024 * 1024);
    expect(uploadMaxBytes('2')).toBe(2 * 1024 * 1024);
    expect(uploadMaxBytes('-1')).toBe(64 * 1024 * 1024);
  });
});
