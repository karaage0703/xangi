import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { logPrompt, logResponse, readSessionMessages } from '../src/transcript-logger.js';
import { ToolTrajectoryLogger } from '../src/tool-trajectory/index.js';

/**
 * tool-trajectory ロガーが既存 transcript (logs/sessions/) と session restore
 * に影響しないことを保証する regression test。
 *
 * 設計意図:
 * - transcript = 会話の正史 (logs/sessions/<id>.jsonl)
 * - trajectory = 観測ログ (logs/tool-trajectory/<id>.jsonl) — 完全分離
 * - 同一 appSessionId で両方並走しても干渉しない
 */
describe('tool-trajectory ↔ transcript regression', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'traj-restore-test-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('trajectory writes go to logs/tool-trajectory, not logs/sessions', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 'sess' }, {});
    logger.logToolCall(
      { appSessionId: 'sess' },
      { tool_name: 't', args: {}, duration_ms: 1, status: 'success' }
    );
    expect(existsSync(join(workdir, 'logs/tool-trajectory/sess.jsonl'))).toBe(true);
    // transcript dir not created by trajectory logger
    expect(existsSync(join(workdir, 'logs/sessions'))).toBe(false);
  });

  it('transcript reads ignore trajectory files', () => {
    const appSessionId = 'sess-shared';
    // Write transcript entries
    logPrompt(workdir, appSessionId, 'hello');
    logResponse(workdir, appSessionId, { result: 'hi', sessionId: 'x' });
    // Also write trajectory events (should NOT pollute transcript)
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId }, {});
    logger.logToolCall(
      { appSessionId },
      { tool_name: 'read', args: { path: '/foo' }, duration_ms: 1, status: 'success' }
    );

    const msgs = readSessionMessages(workdir, appSessionId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    // No tool_call event leaked into transcript
    expect(msgs.some((m) => (m as { kind?: string }).kind === 'tool_call')).toBe(false);
  });

  it('transcript reader does not crash if trajectory dir contains arbitrary jsonl', () => {
    const appSessionId = 'sess';
    logPrompt(workdir, appSessionId, 'hi');
    // Plant a "rogue" jsonl in the trajectory dir
    const trajDir = join(workdir, 'logs/tool-trajectory');
    mkdirSync(trajDir, { recursive: true });
    writeFileSync(join(trajDir, `${appSessionId}.jsonl`), '{not valid}\n');
    // transcript still reads cleanly
    const msgs = readSessionMessages(workdir, appSessionId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('hi');
  });

  it('disabled logger leaves transcript untouched and creates no files', () => {
    const appSessionId = 'sess';
    logPrompt(workdir, appSessionId, 'hi');
    const logger = new ToolTrajectoryLogger({ workdir, enabled: false, hashSalt: 's' });
    logger.logSessionStart({ appSessionId }, {});
    logger.logToolCall(
      { appSessionId },
      { tool_name: 't', args: {}, duration_ms: 1, status: 'success' }
    );
    expect(existsSync(join(workdir, 'logs/tool-trajectory'))).toBe(false);
    const msgs = readSessionMessages(workdir, appSessionId);
    expect(msgs).toHaveLength(1);
  });
});
