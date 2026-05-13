import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  getRuntimeContext,
  buildRuntimeContextBlock,
  prependRuntimeContext,
  _resetRuntimeContextCache,
} from '../src/runtime-context.js';

describe('runtime-context', () => {
  let originalCwd: string;
  let tempDirs: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    _resetRuntimeContextCache();
    delete process.env.XANGI_RUNTIME_CONTEXT_ENABLED;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _resetRuntimeContextCache();
    delete process.env.XANGI_RUNTIME_CONTEXT_ENABLED;
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs = [];
    vi.restoreAllMocks();
  });

  function mkTemp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  describe('getRuntimeContext', () => {
    it('returns the current cwd', () => {
      const ctx = getRuntimeContext();
      expect(ctx.cwd).toBe(process.cwd());
    });

    it('returns repo info when cwd is inside a git repo', () => {
      // テスト実行ディレクトリ自体が git 配下なので必ず repo が取れる
      const ctx = getRuntimeContext();
      expect(ctx.repo).toBeDefined();
      expect(ctx.repo?.name).toBeTruthy();
      expect(ctx.repo?.branch).toBeTruthy();
    });

    it('omits repo info when cwd is not in a git repo', () => {
      const tmp = mkTemp('xangi-no-git-');
      process.chdir(tmp);
      _resetRuntimeContextCache();
      const ctx = getRuntimeContext();
      expect(ctx.cwd).toBe(tmp);
      expect(ctx.repo).toBeUndefined();
    });
  });

  describe('buildRuntimeContextBlock', () => {
    it('is a single line ending with double newline (no explanatory text)', () => {
      const block = buildRuntimeContextBlock();
      expect(block).toMatch(/^\[runtime\] /);
      expect(block.endsWith('\n\n')).toBe(true);
      // 改行は末尾の \n\n のみ（説明文行が無いことを確認）
      const inner = block.replace(/\n+$/, '');
      expect(inner.includes('\n')).toBe(false);
    });

    it('contains the cwd in `cwd=...` format', () => {
      const block = buildRuntimeContextBlock();
      expect(block).toContain(`cwd=${process.cwd()}`);
    });

    it('contains the repo in `repo=name@branch` format when in a git repo', () => {
      const block = buildRuntimeContextBlock();
      // xangi-dev リポ内で動かす想定
      expect(block).toMatch(/repo=\S+@\S+/);
    });

    it('does not include CONTAINER segment (Docker detection removed)', () => {
      const block = buildRuntimeContextBlock();
      expect(block).not.toContain('CONTAINER');
    });

    it('does not include the deprecated cd-drift warning text', () => {
      const block = buildRuntimeContextBlock();
      expect(block).not.toContain('observed at turn start');
      expect(block).not.toContain('git -C');
    });
  });

  describe('XANGI_RUNTIME_CONTEXT_ENABLED env var', () => {
    it('returns empty block when env=false', () => {
      process.env.XANGI_RUNTIME_CONTEXT_ENABLED = 'false';
      expect(buildRuntimeContextBlock()).toBe('');
      expect(prependRuntimeContext('hello')).toBe('hello');
    });

    it('returns empty block when env=0', () => {
      process.env.XANGI_RUNTIME_CONTEXT_ENABLED = '0';
      expect(buildRuntimeContextBlock()).toBe('');
    });

    it('returns empty block when env=off', () => {
      process.env.XANGI_RUNTIME_CONTEXT_ENABLED = 'off';
      expect(buildRuntimeContextBlock()).toBe('');
    });

    it('returns block when env=true', () => {
      process.env.XANGI_RUNTIME_CONTEXT_ENABLED = 'true';
      expect(buildRuntimeContextBlock()).toMatch(/^\[runtime\] /);
    });

    it('returns block when env is unset (default = enabled)', () => {
      delete process.env.XANGI_RUNTIME_CONTEXT_ENABLED;
      expect(buildRuntimeContextBlock()).toMatch(/^\[runtime\] /);
    });

    it('is case-insensitive (FALSE / False also disable)', () => {
      process.env.XANGI_RUNTIME_CONTEXT_ENABLED = 'FALSE';
      expect(buildRuntimeContextBlock()).toBe('');
      process.env.XANGI_RUNTIME_CONTEXT_ENABLED = 'False';
      expect(buildRuntimeContextBlock()).toBe('');
    });
  });

  describe('prependRuntimeContext', () => {
    it('prepends the context block before the prompt', () => {
      const result = prependRuntimeContext('hello');
      expect(result.endsWith('hello')).toBe(true);
      expect(result.startsWith('[runtime] ')).toBe(true);
    });

    it('preserves multi-line prompts intact', () => {
      const original = 'line1\nline2\nline3';
      const result = prependRuntimeContext(original);
      expect(result.endsWith(original)).toBe(true);
    });

    it('returns prompt unchanged-or-prepended (defensive on empty cwd)', () => {
      const out = prependRuntimeContext('x');
      expect(out).toContain('x');
    });
  });

  describe('repo cache TTL', () => {
    it('caches repo info per cwd within TTL window', () => {
      const first = getRuntimeContext();
      const second = getRuntimeContext();
      expect(second.repo?.root).toBe(first.repo?.root);
      expect(second.repo?.branch).toBe(first.repo?.branch);
    });
  });

  describe('integration: child_process timeout safety', () => {
    it('does not hang (1s upper bound per git call, returns quickly)', () => {
      const start = Date.now();
      getRuntimeContext();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });
  });
});

// 実環境の git が動くことの sanity check（CI で git 不在なら skip）
describe('runtime-context sanity (requires git)', () => {
  it('git rev-parse works in this repo', () => {
    let ok = false;
    try {
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      });
      ok = true;
    } catch {
      ok = false;
    }
    expect(ok).toBe(true);
  });
});
