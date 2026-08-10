import { describe, expect, it } from 'vitest';

import { associateToolHistory } from '../web-ui/src/toolHistory.js';

describe('associateToolHistory', () => {
  const tools = [
    {
      kind: 'tool' as const,
      at: Date.parse('2026-07-29T08:00:02.000Z'),
      turnId: 'discord-msg-123',
      toolName: 'Bash',
      summary: '実行中: Bash: pwd',
    },
    {
      kind: 'tool' as const,
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

  it('attaches Web history to the final consecutive assistant entry', () => {
    const messages = [
      { role: 'user', createdAt: '2026-07-29T08:00:00.000Z' },
      { role: 'assistant', createdAt: '2026-07-29T08:00:10.000Z' },
      { role: 'assistant', createdAt: '2026-07-29T08:00:11.000Z' },
    ];

    expect(associateToolHistory(messages, 'web', tools).map((entries) => entries.length)).toEqual([
      0, 0, 1,
    ]);
  });

  it('associates commentary with its reply and removes a duplicate final response', () => {
    const messages = [
      { role: 'user', createdAt: '2026-07-29T08:00:00.000Z', platformMessageId: '123' },
      {
        role: 'assistant',
        content: '最終回答',
        createdAt: '2026-07-29T08:00:10.000Z',
      },
    ];
    const history = [
      {
        kind: 'text' as const,
        at: Date.parse('2026-07-29T08:00:01.000Z'),
        turnId: 'discord-msg-123',
        text: '調べます',
      },
      tools[0],
      {
        kind: 'text' as const,
        at: Date.parse('2026-07-29T08:00:03.000Z'),
        turnId: 'discord-msg-123',
        text: '最終回答',
      },
    ];

    expect(associateToolHistory(messages, 'discord', history)[1]).toEqual(history.slice(0, -1));
  });

  it('removes a trailing final segment when the provider returns accumulated text', () => {
    const messages = [
      { role: 'user', createdAt: '2026-07-29T08:00:00.000Z', platformMessageId: '123' },
      {
        role: 'assistant',
        content: '調べました。\n\n最終回答',
        createdAt: '2026-07-29T08:00:10.000Z',
      },
    ];
    const history = [
      {
        kind: 'text' as const,
        at: Date.parse('2026-07-29T08:00:01.000Z'),
        turnId: 'discord-msg-123',
        text: '調べました。',
      },
      tools[0],
      {
        kind: 'text' as const,
        at: Date.parse('2026-07-29T08:00:03.000Z'),
        turnId: 'discord-msg-123',
        text: '最終回答',
      },
    ];

    expect(associateToolHistory(messages, 'discord', history)[1]).toEqual(history.slice(0, -1));
  });
});
