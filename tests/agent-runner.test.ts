import { describe, it, expect } from 'vitest';
import { createAgentRunner, getBackendDisplayName, mergeTexts } from '../src/agent-runner.js';

describe('agent-runner', () => {
  describe('createAgentRunner', () => {
    it('should create ClaudeCodeRunner for claude-code backend', () => {
      const runner = createAgentRunner('claude-code', {});
      expect(runner).toBeDefined();
      expect(runner.run).toBeDefined();
      expect(runner.runStream).toBeDefined();
    });

    it('should create CodexRunner for codex backend', () => {
      const runner = createAgentRunner('codex', {});
      expect(runner).toBeDefined();
      expect(runner.run).toBeDefined();
      expect(runner.runStream).toBeDefined();
    });

    it('should throw error for unknown backend', () => {
      expect(() => createAgentRunner('unknown' as any, {})).toThrow('Unknown agent backend');
    });
  });

  describe('mergeTexts', () => {
    it('should return streamed when result is empty', () => {
      expect(mergeTexts('hello world', '')).toBe('hello world');
    });

    it('should return result when streamed is empty', () => {
      expect(mergeTexts('', 'hello world')).toBe('hello world');
    });

    it('should return streamed when result is a suffix of streamed', () => {
      // result が streamed の末尾と一致 → 重複なので streamed をそのまま返す
      const streamed = '!discord send <#123> hello\nfinal answer';
      const result = 'final answer';
      expect(mergeTexts(streamed, result)).toBe(streamed);
    });

    it('should return result when streamed is a suffix of result', () => {
      const streamed = 'final answer';
      const result = '!discord send <#123> hello\nfinal answer';
      expect(mergeTexts(streamed, result)).toBe(result);
    });

    it('should concatenate when no overlap', () => {
      // ツール呼び出し前のテキストが streamed にあり、result には最後のテキストだけ
      const streamed = '!discord send <#123> hello\n調べてみるね...';
      const result = '調査結果はこちら';
      expect(mergeTexts(streamed, result)).toBe(`${streamed}\n${result}`);
    });

    it('should handle discord commands in streamed text that are missing from result', () => {
      // これが問題2の核心ケース
      const streamed = '!discord send <#work_01> 作業開始します\nツール実行中...\n結果報告';
      const result = '結果報告';
      // result は streamed の末尾 → streamed をそのまま返す → !discord send が保持される
      expect(mergeTexts(streamed, result)).toBe(streamed);
      expect(mergeTexts(streamed, result)).toContain('!discord send');
    });

    it('should handle identical texts', () => {
      const text = 'same text';
      expect(mergeTexts(text, text)).toBe(text);
    });
  });

  describe('getBackendDisplayName', () => {
    it('should return "Claude Code" for claude-code', () => {
      expect(getBackendDisplayName('claude-code')).toBe('Claude Code');
    });

    it('should return "Codex" for codex', () => {
      expect(getBackendDisplayName('codex')).toBe('Codex');
    });
  });
});
