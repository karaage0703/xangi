import { describe, expect, it } from 'vitest';
import { XANGI_CMD_HELP_ENTRIES, formatXangiCmdHelp } from '../src/cli/xangi-cmd-help.js';

describe('xangi tool help', () => {
  it('コマンド名を重複させない', () => {
    const names = XANGI_CMD_HELP_ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('一覧、topic、command詳細を表示する', () => {
    expect(formatXangiCmdHelp()).toContain('xangi tool help <topic|command>');
    expect(formatXangiCmdHelp('extension_request')).toContain('--query-json <json-object>');
    expect(formatXangiCmdHelp('extension_request')).toContain('--query-json-stdin');
    expect(formatXangiCmdHelp('extension_uninstall')).toContain('--id <extension-id>');
    expect(formatXangiCmdHelp('schedule')).toContain('xangi tool schedule_add');
    expect(formatXangiCmdHelp('schedule_add')).toContain(
      'Usage: xangi tool schedule_add --input <natural-language-or-cron>'
    );
    expect(formatXangiCmdHelp('schedule')).toContain('xangi tool schedule_update');
    expect(formatXangiCmdHelp('schedule_update')).toContain(
      'Usage: xangi tool schedule_update --id <schedule-id>'
    );
    expect(formatXangiCmdHelp('settings')).toContain('xangi tool runtime_settings');
    expect(formatXangiCmdHelp('models')).toContain('exact returned IDs');
    expect(formatXangiCmdHelp('runtime_settings')).toContain('explicitly requests');
    expect(formatXangiCmdHelp('runtime_settings')).toContain('--scope <channel|global>');
    expect(formatXangiCmdHelp('trigger')).toContain('Use schedule for timed checks');
    expect(formatXangiCmdHelp('system_restart')).toContain('After recovery, verify status');
    expect(formatXangiCmdHelp('progress')).toContain('xangi tool progress_card');
    expect(formatXangiCmdHelp('progress_card')).toContain('--plan-json');
    expect(formatXangiCmdHelp('remote_worker')).toContain('executionPolicy');
    expect(formatXangiCmdHelp('inter_chat_ask')).toContain('--to <instance_id>');
    expect(formatXangiCmdHelp('inter_chat_ask')).toContain('not user approval');
  });

  it('未知のtopicやcommandを拒否する', () => {
    expect(() => formatXangiCmdHelp('missing')).toThrow('Unknown help topic or command');
  });
});
