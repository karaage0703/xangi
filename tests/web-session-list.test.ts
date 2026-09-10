import { describe, expect, it } from 'vitest';

import { sessionListStatus, sessionListStatusLabel } from '../web-ui/src/sessionList.js';

describe('sessionListStatus', () => {
  it('distinguishes running, waiting, and completed without relying on color', () => {
    expect(sessionListStatus({ isActive: true, lifecycle: 'open' })).toBe('running');
    expect(sessionListStatus({ isActive: false, lifecycle: 'open' })).toBe('waiting');
    expect(sessionListStatus({ isActive: true, lifecycle: 'closed' })).toBe('completed');
    expect(sessionListStatusLabel('running')).toBe('実行中');
    expect(sessionListStatusLabel('waiting')).toBe('待機中');
    expect(sessionListStatusLabel('completed')).toBe('完了');
  });
});
