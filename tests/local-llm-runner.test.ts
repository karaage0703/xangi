import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSessionRelatedError, formatLlmError, LocalLlmRunner } from '../src/local-llm/runner.js';

describe('isSessionRelatedError', () => {
  it('should return true for "context length exceeded"', () => {
    expect(isSessionRelatedError(new Error('context length exceeded'))).toBe(true);
  });

  it('should return true for "too many tokens"', () => {
    expect(isSessionRelatedError(new Error('too many tokens'))).toBe(true);
  });

  it('should return true for "max_tokens exceeded"', () => {
    expect(isSessionRelatedError(new Error('max_tokens exceeded'))).toBe(true);
  });

  it('should return true for "context window"', () => {
    expect(isSessionRelatedError(new Error('context window full'))).toBe(true);
  });

  it('should return true for "invalid message format"', () => {
    expect(isSessionRelatedError(new Error('invalid message format'))).toBe(true);
  });

  it('should return true for "malformed request"', () => {
    expect(isSessionRelatedError(new Error('malformed request'))).toBe(true);
  });

  it('should return true for "400 Bad Request"', () => {
    expect(isSessionRelatedError(new Error('400 Bad Request'))).toBe(true);
  });

  it('should return true for "422 Unprocessable"', () => {
    expect(isSessionRelatedError(new Error('422 Unprocessable Entity'))).toBe(true);
  });

  it('should return false for "network error"', () => {
    expect(isSessionRelatedError(new Error('network error'))).toBe(false);
  });

  it('should return false for "random error"', () => {
    expect(isSessionRelatedError(new Error('random error'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isSessionRelatedError('string error')).toBe(false);
    expect(isSessionRelatedError(null)).toBe(false);
    expect(isSessionRelatedError(undefined)).toBe(false);
    expect(isSessionRelatedError(42)).toBe(false);
  });
});

describe('formatLlmError', () => {
  it('should format ECONNREFUSED error', () => {
    const result = formatLlmError(new Error('ECONNREFUSED'));
    expect(result).toContain('LLMサーバーに接続できませんでした');
  });

  it('should format timeout error', () => {
    const result = formatLlmError(new Error('request timeout'));
    expect(result).toContain('タイムアウト');
  });

  it('should format 401 auth error', () => {
    const result = formatLlmError(new Error('401 Unauthorized'));
    expect(result).toContain('認証');
  });

  it('should format 429 rate limit error', () => {
    const result = formatLlmError(new Error('429 Too Many Requests'));
    expect(result).toContain('レートリミット');
  });

  it('should format 500 internal error', () => {
    const result = formatLlmError(new Error('500 Internal Server Error'));
    expect(result).toContain('内部エラー');
  });

  it('should format unknown error with message', () => {
    const result = formatLlmError(new Error('unknown'));
    expect(result).toContain('LLMエラー: unknown');
  });

  it('should handle non-Error values', () => {
    const result = formatLlmError('not an error');
    expect(result).toContain('予期しないエラー');
  });
});

describe('LocalLlmRunner liteMode', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['LOCAL_LLM_MODE', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
    // テスト用にデフォルト値を設定
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434';
    process.env.LOCAL_LLM_MODEL = 'test-model';
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('should default to all features enabled', () => {
    delete process.env.LOCAL_LLM_MODE;
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(true);
    expect(runner.enableSkills).toBe(true);
    expect(runner.enableXangiCommands).toBe(true);
    expect(runner.enableTriggers).toBe(false);
  });

  it('should use lite defaults when LOCAL_LLM_MODE=lite', () => {
    process.env.LOCAL_LLM_MODE = 'lite';
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(true);
    expect(runner.enableTriggers).toBe(true);
  });

  it('should use chat defaults when LOCAL_LLM_MODE=chat', () => {
    process.env.LOCAL_LLM_MODE = 'chat';
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(false);
    expect(runner.enableSkills).toBe(false);
    expect(runner.enableXangiCommands).toBe(false);
    expect(runner.enableTriggers).toBe(false);
  });

  it('should allow individual overrides over mode defaults', () => {
    process.env.LOCAL_LLM_MODE = 'chat';
    process.env.LOCAL_LLM_TOOLS = 'true';
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(true);
    expect(runner.enableSkills).toBe(false);
  });
});
