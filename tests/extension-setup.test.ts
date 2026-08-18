import { describe, expect, it } from 'vitest';
import { extensionConversationPrompt } from '../web-ui/src/extensionSetup.js';
import { stripPromptMetadata } from '../src/session-title.js';

describe('extension conversation prompt', () => {
  it('keeps the internal instructions for the agent while exposing only the display message', () => {
    const wrapped = extensionConversationPrompt(
      'Inspect hooks and unlink only after approval.',
      'Demo Extension の削除準備を開始します。'
    );

    expect(wrapped).toContain('Inspect hooks and unlink only after approval.');
    expect(stripPromptMetadata(wrapped)).toBe('Demo Extension の削除準備を開始します。');
  });
});
