import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadContextBudget } from '../src/local-llm/runner.js';

describe('loadContextBudget', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('explicit mode', () => {
    it('LOCAL_LLM_CONTEXT_MAX_CHARS が指定されていれば優先する', () => {
      const env = {
        LOCAL_LLM_CONTEXT_MAX_CHARS: '50000',
        LOCAL_LLM_NUM_CTX: '32768', // 無視されるはず
      } as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      expect(cb.source).toBe('explicit');
      expect(cb.contextMaxChars).toBe(50000);
    });

    it('explicit 値でも他の env (keepLast 等) は反映される', () => {
      const env = {
        LOCAL_LLM_CONTEXT_MAX_CHARS: '50000',
        LOCAL_LLM_CONTEXT_KEEP_LAST: '20',
        LOCAL_LLM_TOOL_RESULT_MAX_CHARS: '8000',
        LOCAL_LLM_MAX_SESSION_MESSAGES: '100',
      } as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      expect(cb.contextKeepLast).toBe(20);
      expect(cb.toolResultMaxChars).toBe(8000);
      expect(cb.maxSessionMessages).toBe(100);
    });
  });

  describe('derived mode', () => {
    it('NUM_CTX 未指定なら 32768 デフォから逆算', () => {
      const env = {} as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      expect(cb.source).toBe('derived');
      expect(cb.numCtx).toBe(32768);
      // 32768 - 8000 (system) - 4096 (output) - 1000 (safety) = 19672 tokens
      // 19672 * 3 = 59016 chars
      expect(cb.contextMaxChars).toBe(59016);
    });

    it('NUM_CTX を指定したら逆算ベースが変わる', () => {
      const env = {
        LOCAL_LLM_NUM_CTX: '65536',
      } as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      // 65536 - 8000 - 4096 - 1000 = 52440 tokens, * 3 = 157320 chars
      expect(cb.contextMaxChars).toBe(157320);
    });

    it('SYSTEM/OUTPUT/SAFETY を個別に指定できる', () => {
      const env = {
        LOCAL_LLM_NUM_CTX: '32768',
        LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS: '4000',
        LOCAL_LLM_OUTPUT_BUDGET_TOKENS: '2048',
        LOCAL_LLM_SAFETY_MARGIN_TOKENS: '500',
      } as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      // 32768 - 4000 - 2048 - 500 = 26220 tokens, * 3 = 78660 chars
      expect(cb.contextMaxChars).toBe(78660);
      expect(cb.systemPromptBudgetTokens).toBe(4000);
      expect(cb.outputBudgetTokens).toBe(2048);
      expect(cb.safetyMarginTokens).toBe(500);
    });

    it('NUM_CTX が小さすぎて逆算結果が負になる場合は最低保証 8000 chars', () => {
      const env = {
        LOCAL_LLM_NUM_CTX: '4096', // 8000+4096+1000=13096 > 4096
      } as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      expect(cb.contextMaxChars).toBe(8000);
    });

    it('explicit が空文字や 0 なら derived にフォールバック', () => {
      const env = {
        LOCAL_LLM_CONTEXT_MAX_CHARS: '0',
      } as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      expect(cb.source).toBe('derived');
    });
  });

  describe('defaults', () => {
    it('keepLast/toolResultMax/maxMsgs のデフォルト値', () => {
      const env = {} as NodeJS.ProcessEnv;
      const cb = loadContextBudget(env);
      expect(cb.contextKeepLast).toBe(10);
      expect(cb.toolResultMaxChars).toBe(4000);
      expect(cb.maxSessionMessages).toBe(50);
    });
  });
});
