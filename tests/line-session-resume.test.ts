import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initSessions,
  createSession,
  setProviderSessionId,
  archiveSession,
  getActiveSessionId,
} from '../src/sessions.js';
import { resolveResumeSessionId } from '../src/line.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'line-session-'));
  initSessions(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runner へ渡す sessionId の決定', () => {
  it('No.1 保存済みセッションがあれば、その providerSessionId を返す', () => {
    const contextKey = 'line:U_test';
    const appSessionId = createSession(contextKey, { platform: 'line' });
    setProviderSessionId(appSessionId, 'sess-1', 'codex', 'gpt-5.6-terra', 'low');

    expect(resolveResumeSessionId(contextKey)).toBe('sess-1');
  });

  it('No.2 セッションが未保存なら undefined を返す', () => {
    expect(resolveResumeSessionId('line:U_never_talked')).toBeUndefined();
  });

  it('No.3 リセット後は前のセッションを返さない', () => {
    const contextKey = 'line:U_test';
    const appSessionId = createSession(contextKey, { platform: 'line' });
    setProviderSessionId(appSessionId, 'sess-1', 'codex', 'gpt-5.6-terra', 'low');
    expect(resolveResumeSessionId(contextKey)).toBe('sess-1');

    archiveSession(appSessionId);

    expect(getActiveSessionId(contextKey)).toBeUndefined();
    expect(resolveResumeSessionId(contextKey)).toBeUndefined();
  });

  it('セッションはあるが provider 側の ID が未記録なら undefined を返す', () => {
    const contextKey = 'line:U_test';
    createSession(contextKey, { platform: 'line' });

    expect(resolveResumeSessionId(contextKey)).toBeUndefined();
  });
});
