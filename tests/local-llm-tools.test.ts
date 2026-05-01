import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTool } from '../src/local-llm/tools.js';
import type { ToolContext } from '../src/local-llm/types.js';

let workspace: string;
let context: ToolContext;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'xangi-tools-test-'));
  context = { workspace };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('write tool', () => {
  it('writes content to a new file', async () => {
    const result = await executeTool('write', { path: 'foo.txt', content: 'hello' }, context);
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, 'foo.txt'), 'utf-8')).toBe('hello');
  });

  it('creates parent directories', async () => {
    const result = await executeTool('write', { path: 'a/b/c.txt', content: 'nested' }, context);
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, 'a/b/c.txt'), 'utf-8')).toBe('nested');
  });

  it('overwrites an existing file', async () => {
    writeFileSync(join(workspace, 'x.txt'), 'old');
    const result = await executeTool('write', { path: 'x.txt', content: 'new' }, context);
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, 'x.txt'), 'utf-8')).toBe('new');
  });

  it('rejects missing path', async () => {
    const result = await executeTool('write', { content: 'x' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path is required/);
  });

  it('rejects non-string content', async () => {
    const result = await executeTool('write', { path: 'x.txt', content: 123 }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be a string/);
  });
});

describe('edit tool', () => {
  it('replaces a unique occurrence', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo bar baz');
    const result = await executeTool(
      'edit',
      { path: 'a.txt', old_string: 'bar', new_string: 'qux' },
      context
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf-8')).toBe('foo qux baz');
  });

  it('errors when old_string is not found', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo');
    const result = await executeTool(
      'edit',
      { path: 'a.txt', old_string: 'missing', new_string: 'x' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('errors when old_string matches multiple times without replace_all', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo foo foo');
    const result = await executeTool(
      'edit',
      { path: 'a.txt', old_string: 'foo', new_string: 'bar' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/3 occurrences/);
  });

  it('replaces all occurrences when replace_all=true', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo foo foo');
    const result = await executeTool(
      'edit',
      { path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      context
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf-8')).toBe('bar bar bar');
  });

  it('errors when old_string equals new_string', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo');
    const result = await executeTool(
      'edit',
      { path: 'a.txt', old_string: 'foo', new_string: 'foo' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must differ/);
  });

  it('errors when file does not exist', async () => {
    const result = await executeTool(
      'edit',
      { path: 'nope.txt', old_string: 'a', new_string: 'b' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('glob tool', () => {
  it('finds files matching a pattern', async () => {
    writeFileSync(join(workspace, 'a.ts'), '');
    writeFileSync(join(workspace, 'b.ts'), '');
    writeFileSync(join(workspace, 'c.md'), '');
    const result = await executeTool('glob', { pattern: '*.ts' }, context);
    expect(result.success).toBe(true);
    const lines = result.output.split('\n').sort();
    expect(lines).toEqual(['a.ts', 'b.ts']);
  });

  it('descends recursively with **', async () => {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src/index.ts'), '');
    const result = await executeTool('glob', { pattern: '**/*.ts' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('src/index.ts');
  });

  it('skips node_modules by default', async () => {
    mkdirSync(join(workspace, 'node_modules/foo'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules/foo/x.ts'), '');
    writeFileSync(join(workspace, 'real.ts'), '');
    const result = await executeTool('glob', { pattern: '**/*.ts' }, context);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('node_modules');
    expect(result.output).toContain('real.ts');
  });

  it('returns "(no matches)" when nothing matches', async () => {
    const result = await executeTool('glob', { pattern: '*.zz' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toBe('(no matches)');
  });
});

describe('grep tool', () => {
  it('finds lines matching a regex', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'line one\nfoo bar\nbaz\n');
    writeFileSync(join(workspace, 'b.ts'), 'unrelated\nfoo qux\n');
    const result = await executeTool('grep', { pattern: 'foo' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts:2:foo bar');
    expect(result.output).toContain('b.ts:2:foo qux');
  });

  it('respects file_pattern filter', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'foo\n');
    writeFileSync(join(workspace, 'b.md'), 'foo\n');
    const result = await executeTool('grep', { pattern: 'foo', file_pattern: '.md' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('b.md');
    expect(result.output).not.toContain('a.ts');
  });

  it('supports ignore_case', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'Hello World\n');
    const result = await executeTool('grep', { pattern: 'hello', ignore_case: true }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello World');
  });

  it('skips node_modules', async () => {
    mkdirSync(join(workspace, 'node_modules'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules/x.ts'), 'secret');
    writeFileSync(join(workspace, 'real.ts'), 'secret');
    const result = await executeTool('grep', { pattern: 'secret' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('real.ts');
    expect(result.output).not.toContain('node_modules');
  });

  it('returns "(no matches)" when nothing matches', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello\n');
    const result = await executeTool('grep', { pattern: 'zzz' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toBe('(no matches)');
  });

  it('errors on invalid regex', async () => {
    const result = await executeTool('grep', { pattern: '[unclosed' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid regex/);
  });

  it('searches a single file when path is a file', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(workspace, 'b.txt'), 'two\n');
    const result = await executeTool('grep', { pattern: 'two', path: 'a.txt' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.txt:2:two');
    expect(result.output).not.toContain('b.txt');
  });
});

describe('tool registry', () => {
  it('registers all 8 builtin tools', async () => {
    // sanity: each new tool is reachable via executeTool
    const probes = ['exec', 'read', 'write', 'edit', 'glob', 'grep', 'send_file', 'web_fetch'];
    for (const name of probes) {
      const result = await executeTool(name, {}, context);
      // missing-required-param errors are fine; we just need "Unknown tool" to NOT appear
      expect(result.error ?? '').not.toMatch(/Unknown tool/);
    }
  });
});

describe('send_file tool', () => {
  it('returns MEDIA: line for an existing file', async () => {
    const target = join(workspace, 'attach.txt');
    writeFileSync(target, 'hello attachment');
    const result = await executeTool('send_file', { path: 'attach.txt' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^MEDIA:.+attach\.txt/m);
  });

  it('errors when file does not exist', async () => {
    const result = await executeTool('send_file', { path: 'nope.bin' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('errors when path is a directory', async () => {
    const result = await executeTool('send_file', { path: '.' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a file/i);
  });

  it('rejects ../ traversal', async () => {
    const result = await executeTool('send_file', { path: '../escape.txt' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });
});

describe('path traversal protection', () => {
  it('rejects ../ traversal in write', async () => {
    const result = await executeTool(
      'write',
      { path: '../escape.txt', content: 'pwn' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });

  it('rejects deep ../../ traversal in write', async () => {
    const result = await executeTool(
      'write',
      { path: 'a/b/../../../escape.txt', content: 'pwn' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });

  it('rejects absolute path outside workspace in write', async () => {
    const result = await executeTool(
      'write',
      { path: '/tmp/xangi-pwn-test', content: 'pwn' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });

  it('allows absolute path inside workspace in write', async () => {
    const result = await executeTool(
      'write',
      { path: join(workspace, 'inside.txt'), content: 'ok' },
      context
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf-8')).toBe('ok');
  });

  it('rejects ../ traversal in read', async () => {
    const result = await executeTool('read', { path: '../etc/passwd' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });

  it('rejects ../ traversal in edit', async () => {
    const result = await executeTool(
      'edit',
      { path: '../escape.txt', old_string: 'a', new_string: 'b' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });

  it('rejects ../ traversal in glob cwd', async () => {
    const result = await executeTool('glob', { pattern: '*', cwd: '../..' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });

  it('rejects ../ traversal in grep path', async () => {
    const result = await executeTool('grep', { pattern: 'x', path: '../..' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace/);
  });
});

describe('env-controlled size limits', () => {
  // 個別テスト内で env を切り替えて再 import するのは複雑なため、デフォルト値の挙動だけ確認
  it('write rejects content over default 512KB', async () => {
    const big = 'a'.repeat(512 * 1024 + 1);
    const result = await executeTool('write', { path: 'big.txt', content: big }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Content too large/);
  });

  it('write accepts content up to default 512KB', async () => {
    const ok = 'a'.repeat(512 * 1024);
    const result = await executeTool('write', { path: 'ok.txt', content: ok }, context);
    expect(result.success).toBe(true);
  });
});
