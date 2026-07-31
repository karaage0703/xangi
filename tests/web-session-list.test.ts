import { describe, expect, it } from 'vitest';

import { shouldShowAutoTalk } from '../web-ui/src/sessionList.js';

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
