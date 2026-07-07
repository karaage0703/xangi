import { describe, expect, it } from 'vitest';
import {
  canSelfRestart,
  getSelfLifecyclePermission,
  normalizeSelfLifecyclePermission,
} from '../src/self-lifecycle.js';

describe('self-lifecycle', () => {
  it('defaults to off when env is unset or invalid', () => {
    expect(getSelfLifecyclePermission({})).toBe('off');
    expect(getSelfLifecyclePermission({ XANGI_SELF_LIFECYCLE: 'invalid' })).toBe('off');
    expect(normalizeSelfLifecyclePermission(undefined)).toBe('off');
  });

  it('accepts explicit permission modes', () => {
    expect(getSelfLifecyclePermission({ XANGI_SELF_LIFECYCLE: 'off' })).toBe('off');
    expect(getSelfLifecyclePermission({ XANGI_SELF_LIFECYCLE: 'restart-only' })).toBe(
      'restart-only'
    );
  });

  it('allows restart only for restart-only', () => {
    expect(canSelfRestart('off')).toBe(false);
    expect(canSelfRestart('restart-only')).toBe(true);
  });

  it('treats full as invalid until self shutdown is backed by an external lifecycle manager', () => {
    expect(getSelfLifecyclePermission({ XANGI_SELF_LIFECYCLE: 'full' })).toBe('off');
  });
});
