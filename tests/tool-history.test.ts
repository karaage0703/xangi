import { describe, expect, it } from 'vitest';
import { formatTurnHistoryDisclosure } from '../src/tool-history.js';

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
