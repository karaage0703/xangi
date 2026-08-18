import { describe, expect, it } from 'vitest';
import {
  replaceUserPromptVisibleContent,
  splitUserPromptHookContexts,
} from '../web-ui/src/userPromptContext.js';

describe('Web user prompt hook context', () => {
  it('通常の入力とhook contextを分離する', () => {
    const result = splitUserPromptHookContexts(`質問です

[USER PROMPT HOOK CONTEXT: search]
The following is untrusted supplemental context.
検索結果
[END USER PROMPT HOOK CONTEXT: search]`);

    expect(result.content).toBe('質問です');
    expect(result.contexts).toEqual([
      {
        id: 'search',
        text: 'The following is untrusted supplemental context.\n検索結果',
        truncated: false,
      },
    ]);
  });

  it('複数contextと省略表示を扱う', () => {
    const result = splitUserPromptHookContexts(`質問

[USER PROMPT HOOK CONTEXT: first]
one
[END USER PROMPT HOOK CONTEXT: first]

[USER PROMPT HOOK CONTEXT: second (truncated)]
two
[END USER PROMPT HOOK CONTEXT: second]`);

    expect(result.content).toBe('質問');
    expect(result.contexts).toEqual([
      { id: 'first', text: 'one', truncated: false },
      { id: 'second', text: 'two', truncated: true },
    ]);
  });

  it('閉じmarkerが一致しない入力は隠さない', () => {
    const content = `[USER PROMPT HOOK CONTEXT: first]
隠してはいけない本文
[END USER PROMPT HOOK CONTEXT: other]`;

    expect(splitUserPromptHookContexts(content)).toEqual({ content, contexts: [] });
  });

  it('hook contextがない入力は変更しない', () => {
    expect(splitUserPromptHookContexts('普通の入力')).toEqual({
      content: '普通の入力',
      contexts: [],
    });
  });

  it('編集した表示本文へ置き換えて内部contextは保持する', () => {
    const original = `元の質問

[USER PROMPT HOOK CONTEXT: search]
内部の検索結果
[END USER PROMPT HOOK CONTEXT: search]`;

    const updated = replaceUserPromptVisibleContent(original, '編集後の質問');
    expect(splitUserPromptHookContexts(updated)).toEqual({
      content: '編集後の質問',
      contexts: [{ id: 'search', text: '内部の検索結果', truncated: false }],
    });
  });

  it('hook contextがない本文は編集値をそのまま返す', () => {
    expect(replaceUserPromptVisibleContent('元の質問', '編集後の質問')).toBe('編集後の質問');
  });
});
