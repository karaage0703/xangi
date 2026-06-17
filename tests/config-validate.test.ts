import { describe, it, expect, vi, afterEach } from 'vitest';
import { EnvValidator, validateChannelOverrides } from '../src/config-validate.js';

describe('EnvValidator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('int', () => {
    it('未設定ならデフォルトを返し issue なし', () => {
      const v = new EnvValidator({});
      expect(v.int('TIMEOUT_MS', 300000)).toBe(300000);
      expect(v.issues).toHaveLength(0);
    });

    it('有効な整数はそのまま通す', () => {
      const v = new EnvValidator({ TIMEOUT_MS: '600000' });
      expect(v.int('TIMEOUT_MS', 300000, { min: 1000 })).toBe(600000);
      expect(v.issues).toHaveLength(0);
    });

    it('数値でない値はデフォルトにフォールバックして issue を記録', () => {
      const v = new EnvValidator({ TIMEOUT_MS: 'abc' });
      expect(v.int('TIMEOUT_MS', 300000)).toBe(300000);
      expect(v.issues).toHaveLength(1);
      expect(v.issues[0].key).toBe('TIMEOUT_MS');
    });

    it('負数など min 未満はデフォルトにフォールバック', () => {
      const v = new EnvValidator({ TIMEOUT_MS: '-5000' });
      expect(v.int('TIMEOUT_MS', 300000, { min: 1000 })).toBe(300000);
      expect(v.issues).toHaveLength(1);
    });

    it('max 超過はデフォルトにフォールバック', () => {
      const v = new EnvValidator({ MAX_PROCESSES: '9999' });
      expect(v.int('MAX_PROCESSES', 10, { max: 100 })).toBe(10);
      expect(v.issues).toHaveLength(1);
    });

    it('小数は整数でないとして拒否', () => {
      const v = new EnvValidator({ MAX_PROCESSES: '3.5' });
      expect(v.int('MAX_PROCESSES', 10)).toBe(10);
      expect(v.issues).toHaveLength(1);
    });
  });

  describe('float', () => {
    it('有効な小数を通す', () => {
      const v = new EnvValidator({ LINE_IDLE_RESET_HOURS: '0.5' });
      expect(v.float('LINE_IDLE_RESET_HOURS', 4, { min: 0 })).toBe(0.5);
      expect(v.issues).toHaveLength(0);
    });

    it('数値でない値はフォールバック', () => {
      const v = new EnvValidator({ LINE_IDLE_RESET_HOURS: 'four' });
      expect(v.float('LINE_IDLE_RESET_HOURS', 4)).toBe(4);
      expect(v.issues).toHaveLength(1);
    });
  });

  describe('enumOf', () => {
    it('大文字小文字を無視してマッチする', () => {
      const v = new EnvValidator({ LOCAL_LLM_MODE: 'AGENT' });
      expect(v.enumOf('LOCAL_LLM_MODE', ['agent', 'lite', 'chat'] as const, 'agent')).toBe(
        'agent'
      );
      expect(v.issues).toHaveLength(0);
    });

    it('typo はデフォルトにフォールバックして issue を記録', () => {
      const v = new EnvValidator({ LOCAL_LLM_MODE: 'agnet' });
      expect(v.enumOf('LOCAL_LLM_MODE', ['agent', 'lite', 'chat'] as const, 'agent')).toBe(
        'agent'
      );
      expect(v.issues).toHaveLength(1);
      expect(v.issues[0].message).toContain('agent / lite / chat');
    });
  });

  describe('enumList', () => {
    it('未設定なら undefined', () => {
      const v = new EnvValidator({});
      expect(v.enumList('ALLOWED_BACKENDS', ['codex', 'grok'] as const)).toBeUndefined();
    });

    it('typo の項目だけ除外して有効な項目を残す', () => {
      const v = new EnvValidator({ ALLOWED_BACKENDS: 'codex,gemnii,local-llm' });
      expect(
        v.enumList('ALLOWED_BACKENDS', ['claude-code', 'codex', 'grok', 'local-llm'] as const)
      ).toEqual(['codex', 'local-llm']);
      expect(v.issues).toHaveLength(1);
      expect(v.issues[0].value).toBe('gemnii');
    });
  });

  describe('report', () => {
    it('issue が無ければ何も出力しない', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const v = new EnvValidator({});
      v.report();
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('issue があれば一覧を console.error に出す（デフォルトは throw しない）', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const v = new EnvValidator({ TIMEOUT_MS: 'abc' });
      v.int('TIMEOUT_MS', 300000);
      expect(() => v.report()).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
    });

    it('XANGI_CONFIG_STRICT=true なら throw する', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const v = new EnvValidator({ TIMEOUT_MS: 'abc', XANGI_CONFIG_STRICT: 'true' });
      v.int('TIMEOUT_MS', 300000);
      expect(() => v.report()).toThrow(/Invalid environment configuration/);
    });
  });
});

describe('validateChannelOverrides', () => {
  it('有効な設定はそのまま通す', () => {
    const raw = JSON.stringify({
      '123456789012345678': { backend: 'local-llm', model: 'gemma', localLlmMode: 'lite' },
      '234567890123456789': { backend: 'claude-code', effort: 'high' },
    });
    const { overrides, issues } = validateChannelOverrides(raw);
    expect(issues).toHaveLength(0);
    expect(overrides).toEqual({
      '123456789012345678': { backend: 'local-llm', model: 'gemma', localLlmMode: 'lite' },
      '234567890123456789': { backend: 'claude-code', effort: 'high' },
    });
  });

  it('壊れた JSON は overrides=null + issue', () => {
    const { overrides, issues } = validateChannelOverrides('{not json');
    expect(overrides).toBeNull();
    expect(issues).toHaveLength(1);
  });

  it('配列やプリミティブは overrides=null', () => {
    expect(validateChannelOverrides('[1,2]').overrides).toBeNull();
    expect(validateChannelOverrides('"str"').overrides).toBeNull();
  });

  it('backend の typo はそのエントリだけ除外して他は残す', () => {
    const raw = JSON.stringify({
      '111': { backend: 'local-lm' }, // typo
      '222': { backend: 'codex' },
    });
    const { overrides, issues } = validateChannelOverrides(raw);
    expect(overrides).toEqual({ '222': { backend: 'codex' } });
    expect(issues).toHaveLength(1);
    expect(issues[0].channelId).toBe('111');
  });

  it('effort / localLlmMode の不正値はエントリ除外', () => {
    const raw = JSON.stringify({
      '111': { backend: 'codex', effort: 'ultra' },
      '222': { backend: 'local-llm', localLlmMode: 'turbo' },
      '333': { backend: 'grok' },
    });
    const { overrides, issues } = validateChannelOverrides(raw);
    expect(Object.keys(overrides!)).toEqual(['333']);
    expect(issues).toHaveLength(2);
  });

  it('チャンネル ID が数値でない場合は警告するが読み込む', () => {
    const raw = JSON.stringify({ 'not-a-channel': { backend: 'codex' } });
    const { overrides, issues } = validateChannelOverrides(raw);
    expect(overrides).toEqual({ 'not-a-channel': { backend: 'codex' } });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('typo');
  });

  it('エントリがオブジェクトでない場合は除外', () => {
    const raw = JSON.stringify({ '111': 'codex', '222': { backend: 'codex' } });
    const { overrides, issues } = validateChannelOverrides(raw);
    expect(overrides).toEqual({ '222': { backend: 'codex' } });
    expect(issues).toHaveLength(1);
  });
});
