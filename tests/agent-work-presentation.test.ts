import { expect, it } from 'vitest';
import { formatAgentWork } from '../src/agent-work-presentation.js';

it('formats a standalone request, removing platform context without losing conditions or URLs', () => {
  const result = formatAgentWork(
    '[プラットフォーム: Web]\n昼食候補の調査。予算1000〜2000円。営業日はhttps://example.com/openで確認。予約は禁止。',
    '担当者'
  );
  expect(result.title).toBe('昼食候補の調査');
  expect(result.text).toContain('- 予算1000〜2000円。');
  expect(result.text).toContain('https://example.com/open');
  expect(result.text).toContain('- 予約は禁止。');
  expect(result.text).not.toContain('プラットフォーム');
});

it('bounds long titles without splitting emoji or silently clipping the assignment', () => {
  const task = '🍙'.repeat(60) + 'を確認。最後の条件も必要。';
  const result = formatAgentWork(task, '担当者');
  expect(Array.from(result.title)).toHaveLength(36);
  expect(result.title).toBe('🍙'.repeat(35) + '…');
  expect(result.text).toContain(task.split('。')[0]);
  expect(result.text).toContain('最後の条件も必要。');
});

it('preserves fenced code and provides a nonempty title for empty metadata-only requests', () => {
  const task = 'コードを確認\n```js\nconst x = 1;\n```';
  expect(formatAgentWork(task, '担当者').text).toContain(task);
  expect(formatAgentWork('[プラットフォーム: Web]', '担当者').title).toBe('依頼された作業');
});
