import { describe, expect, it } from 'vitest';

import { associateToolHistory } from '../web-ui/src/toolHistory.js';

describe('associateToolHistory', () => {
  const tools = [
    {
      at: Date.parse('2026-07-29T08:00:02.000Z'),
      turnId: 'discord-msg-123',
      toolName: 'Bash',
      summary: '実行中: Bash: pwd',
    },
    {
      at: Date.parse('2026-07-29T08:01:02.000Z'),
      turnId: 'discord-msg-456',
      toolName: 'Read',
      summary: '実行中: Read: file',
    },
  ];

  it('attaches Discord tools to the reply for the matching incoming message', () => {
    const messages = [
      {
        role: 'user',
        createdAt: '2026-07-29T08:00:00.000Z',
        platformMessageId: '123',
      },
      { role: 'assistant', createdAt: '2026-07-29T08:00:10.000Z' },
      {
        role: 'user',
        createdAt: '2026-07-29T08:01:00.000Z',
        platformMessageId: '456',
      },
      { role: 'assistant', createdAt: '2026-07-29T08:01:10.000Z' },
    ];

    expect(
      associateToolHistory(messages, 'discord', tools).map((entries) => entries.length)
    ).toEqual([0, 1, 0, 1]);
  });

  it('falls back to message timestamps for Web and older transcripts', () => {
    const messages = [
      { role: 'user', createdAt: '2026-07-29T08:00:00.000Z' },
      { role: 'assistant', createdAt: '2026-07-29T08:00:10.000Z' },
    ];

    expect(associateToolHistory(messages, 'web', tools)[1]).toEqual([tools[0]]);
  });

  it('does not repeat a turn on consecutive assistant entries', () => {
    const messages = [
      { role: 'user', createdAt: '2026-07-29T08:00:00.000Z', platformMessageId: '123' },
      { role: 'assistant', createdAt: '2026-07-29T08:00:10.000Z' },
      { role: 'assistant', createdAt: '2026-07-29T08:00:11.000Z' },
    ];

    expect(
      associateToolHistory(messages, 'discord', tools).map((entries) => entries.length)
    ).toEqual([0, 1, 0]);
  });
});
