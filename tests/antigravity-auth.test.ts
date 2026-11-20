import { expect, it } from 'vitest';
import { antigravityAuthStartupMessage, antigravityApiModel } from '../src/antigravity-auth.js';

it.each(['https://example.com/models/test', 'invalid model', '../test'])(
  'rejects an invalid API model ID: %s',
  (model) => {
    expect(() => antigravityApiModel({ ANTIGRAVITY_API_MODEL: model })).toThrow('モデルID');
  }
);

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
