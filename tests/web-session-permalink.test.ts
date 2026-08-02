import { describe, expect, it } from 'vitest';
import {
  messageElementId,
  messageIdFromHash,
  messagePermalink,
  sessionIdFromPathname,
  sessionPath,
  sessionPermalink,
} from '../web-ui/src/sessionPermalink.js';

describe('Web message permalinks', () => {
  it('round-trips a session ID through the route', () => {
    expect(sessionIdFromPathname(sessionPath('abc_123'))).toBe('abc_123');
    expect(sessionPermalink('https://xangi.test/', 'abc_123')).toBe(
      'https://xangi.test/chat/abc_123'
    );
  });

  it('rejects unrelated and nested routes', () => {
    expect(sessionIdFromPathname('/')).toBeNull();
    expect(sessionIdFromPathname('/chat/a/messages')).toBeNull();
    expect(sessionIdFromPathname('/chat/%E0%A4%A')).toBeNull();
  });

  it('builds and parses a message-level fragment', () => {
    expect(messageElementId('m_123')).toBe('message-m_123');
    expect(messageIdFromHash('#message-m_123')).toBe('m_123');
    expect(messagePermalink('https://xangi.test/', 'abc_123', 'm_123')).toBe(
      'https://xangi.test/chat/abc_123#message-m_123'
    );
  });

  it('rejects unrelated and malformed message fragments', () => {
    expect(messageIdFromHash('#turn-m_123')).toBeNull();
    expect(messageIdFromHash('#message-')).toBeNull();
    expect(messageIdFromHash('#message-%E0%A4%A')).toBeNull();
  });
});
