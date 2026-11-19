import { expect, it } from 'vitest';
import { antigravityAuthStartupMessage } from '../src/antigravity-auth.js';

it('reports API project billing when an Agy key is set without revealing it', () => {
  const message = antigravityAuthStartupMessage('codex', { GEMINI_API_KEY: 'agy-test-secret' });
  expect(message).toContain('Gemini APIキー');
  expect(message).toContain('課金');
  expect(message).not.toContain('agy-test-secret');
});

it('reports existing Agy settings without assuming the user is logged in', () => {
  expect(antigravityAuthStartupMessage('antigravity', { GEMINI_API_KEY: '  ' })).toContain(
    'Agyの既存設定'
  );
  expect(antigravityAuthStartupMessage('codex', {})).toBeUndefined();
});
