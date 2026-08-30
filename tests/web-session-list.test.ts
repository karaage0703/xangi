import { describe, expect, it } from 'vitest';

import {
  sessionListStatus,
  sessionListStatusLabel,
  shouldShowAutoTalk,
} from '../web-ui/src/sessionList.js';

describe('shouldShowAutoTalk', () => {
  it('hides auto-talk when inter-instance chat is disabled', () => {
    expect(shouldShowAutoTalk(false, 'web')).toBe(false);
  });

  it('shows auto-talk only for Web sessions when inter-instance chat is enabled', () => {
    expect(shouldShowAutoTalk(true, 'web')).toBe(true);
    expect(shouldShowAutoTalk(true, 'discord')).toBe(false);
    expect(shouldShowAutoTalk(true, 'slack')).toBe(false);
  });
});

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
