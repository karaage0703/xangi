import { describe, expect, it } from 'vitest';
import { formatTurnHistoryDisclosure, withoutFinalResponse } from '../src/tool-history.js';

describe('formatTurnHistoryDisclosure', () => {
  it('uses the same compact one-event-per-line format for chat platforms', () => {
    const formatted = formatTurnHistoryDisclosure([
      {
        kind: 'text',
        at: 1,
        turnId: 'turn-1',
        text: 'Skill参照: xs-workspace-rag\n\n中断地点から再開するね。',
      },
      {
        kind: 'tool',
        at: 2,
        turnId: 'turn-1',
        toolName: 'Bash',
        summary: '実行中: Bash: sed -n\n1,200p',
      },
    ]);

    expect(formatted).toBe(
      'History\n💬 Skill参照: xs-workspace-rag 中断地点から再開するね。\n🔧 Bash: sed -n 1,200p'
    );
  });
});

describe('withoutFinalResponse', () => {
  it('removes every streamed final-answer fragment while preserving tool events', () => {
    const finalResponse =
      '最終回答の本文\n<xangi_reply_suggestions>["続けて"]</xangi_reply_suggestions>';
    const history = withoutFinalResponse(
      [
        {
          kind: 'text',
          at: 1,
          turnId: 'turn-1',
          text: '最終回答の本文\n<xangi',
        },
        {
          kind: 'tool',
          at: 2,
          turnId: 'turn-1',
          toolName: 'view',
          summary: '実行中: view: skills/example/SKILL.md',
        },
        {
          kind: 'text',
          at: 3,
          turnId: 'turn-1',
          text: '_reply',
        },
      ],
      finalResponse
    );

    expect(history).toEqual([
      {
        kind: 'tool',
        at: 2,
        turnId: 'turn-1',
        toolName: 'view',
        summary: '実行中: view: skills/example/SKILL.md',
      },
    ]);
  });

  it('keeps transient commentary that is not part of the final response', () => {
    const history = withoutFinalResponse(
      [
        {
          kind: 'text',
          at: 1,
          turnId: 'turn-1',
          text: 'SKILL.mdを確認してから実行します',
        },
        {
          kind: 'text',
          at: 2,
          turnId: 'turn-1',
          text: '最終回答',
        },
      ],
      '最終回答'
    );

    expect(history).toEqual([
      {
        kind: 'text',
        at: 1,
        turnId: 'turn-1',
        text: 'SKILL.mdを確認してから実行します',
      },
    ]);
  });
});
