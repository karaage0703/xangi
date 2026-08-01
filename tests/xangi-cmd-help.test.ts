import { describe, expect, it } from 'vitest';
import { XANGI_CMD_HELP_ENTRIES, formatXangiCmdHelp } from '../src/cli/xangi-cmd-help.js';

describe('xangi-cmd help', () => {
  it('コマンド名を重複させない', () => {
    const names = XANGI_CMD_HELP_ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('一覧、topic、command詳細を表示する', () => {
    expect(formatXangiCmdHelp()).toContain('xangi-cmd help <topic|command>');
    expect(formatXangiCmdHelp('schedule')).toContain('xangi-cmd schedule_add');
    expect(formatXangiCmdHelp('schedule_add')).toContain(
      'Usage: xangi-cmd schedule_add --input <自然言語またはcron>'
    );
  });

  it('未知のtopicやcommandを拒否する', () => {
    expect(() => formatXangiCmdHelp('missing')).toThrow('Unknown help topic or command');
  });
});
