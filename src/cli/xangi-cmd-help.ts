import { ValidationError } from '../errors.js';

export interface XangiCmdHelpEntry {
  name: string;
  topic: 'discord' | 'slack' | 'web' | 'schedule' | 'models' | 'trigger' | 'system' | 'local';
  summary: string;
  usage: string;
  notes?: string[];
}

export const XANGI_CMD_HELP_ENTRIES: XangiCmdHelpEntry[] = [
  {
    name: 'discord_history',
    topic: 'discord',
    summary: 'チャンネル履歴を取得',
    usage: 'xangi tool discord_history [--channel <id>] [--count <n>] [--offset <n>]',
    notes: ['本文は200文字で省略される。全文は discord_message を使う。'],
  },
  {
    name: 'discord_message',
    topic: 'discord',
    summary: '特定メッセージの全文を取得',
    usage: 'xangi tool discord_message --channel <id> --message-id <id>',
  },
  {
    name: 'discord_send',
    topic: 'discord',
    summary: '別チャンネルへメッセージを送信',
    usage: 'xangi tool discord_send --channel <id> --message <text>',
  },
  {
    name: 'discord_channels',
    topic: 'discord',
    summary: 'サーバーのチャンネル一覧を取得',
    usage: 'xangi tool discord_channels --guild <id>',
  },
  {
    name: 'discord_search',
    topic: 'discord',
    summary: 'チャンネル内のメッセージを検索',
    usage: 'xangi tool discord_search --channel <id> --keyword <text>',
  },
  {
    name: 'discord_edit',
    topic: 'discord',
    summary: 'メッセージを編集',
    usage: 'xangi tool discord_edit --channel <id> --message-id <id> --content <text>',
  },
  {
    name: 'discord_delete',
    topic: 'discord',
    summary: 'メッセージを削除',
    usage: 'xangi tool discord_delete --channel <id> --message-id <id>',
  },
  {
    name: 'discord_thread_leave',
    topic: 'discord',
    summary: '指定ユーザーをスレッドから退出',
    usage: 'xangi tool discord_thread_leave --user <id> [--channel <thread-id>]',
    notes: ['依頼者本人なら発言者のユーザーIDを使う。他メンバーには影響しない。'],
  },
  {
    name: 'media_send',
    topic: 'discord',
    summary: 'ファイルをDiscordへ送信',
    usage: 'xangi tool media_send --channel <id> --file <absolute-path>',
  },
  {
    name: 'slack_history',
    topic: 'slack',
    summary: 'Slackチャンネル履歴を取得',
    usage: 'xangi tool slack_history [--channel <id>] [--count <n>]',
  },
  {
    name: 'slack_send',
    topic: 'slack',
    summary: 'Slackへメッセージを送信',
    usage: 'xangi tool slack_send --channel <id> [--thread-ts <ts>] --message <text>',
  },
  {
    name: 'slack_channels',
    topic: 'slack',
    summary: 'Slackチャンネル一覧を取得',
    usage: 'xangi tool slack_channels [--types <csv>] [--limit <n>]',
  },
  {
    name: 'slack_search',
    topic: 'slack',
    summary: 'Slackメッセージを検索',
    usage: 'xangi tool slack_search --channel <id> --keyword <text> [--count <n>]',
  },
  {
    name: 'slack_edit',
    topic: 'slack',
    summary: 'Slackメッセージを編集',
    usage: 'xangi tool slack_edit --channel <id> --message-ts <ts> --content <text>',
  },
  {
    name: 'slack_delete',
    topic: 'slack',
    summary: 'Slackメッセージを削除',
    usage: 'xangi tool slack_delete --channel <id> --message-ts <ts>',
  },
  {
    name: 'web_history',
    topic: 'web',
    summary: '現在のWebセッション履歴を取得',
    usage: 'xangi tool web_history [--session <id>] [--count <n>] [--offset <n>]',
  },
  {
    name: 'schedule_list',
    topic: 'schedule',
    summary: 'スケジュール一覧を表示',
    usage: 'xangi tool schedule_list',
  },
  {
    name: 'schedule_add',
    topic: 'schedule',
    summary: 'スケジュールを追加',
    usage:
      'xangi tool schedule_add --input <自然言語またはcron> --channel <id> --platform <discord|slack|telegram|web>',
  },
  {
    name: 'schedule_remove',
    topic: 'schedule',
    summary: 'スケジュールを削除',
    usage: 'xangi tool schedule_remove --id <schedule-id>',
  },
  {
    name: 'schedule_toggle',
    topic: 'schedule',
    summary: 'スケジュールの有効/無効を切替',
    usage: 'xangi tool schedule_toggle --id <schedule-id>',
  },
  {
    name: 'models',
    topic: 'models',
    summary: 'モデル一覧の取得または次turnのモデル選択',
    usage:
      'xangi tool models [--backend <backend>] [--use <model-id>] [--effort <level>] [--channel <id>]',
    notes: ['--use はユーザーの明示依頼がある場合だけ使い、次のturnから適用される。'],
  },
  {
    name: 'trigger',
    topic: 'trigger',
    summary: 'イベント完了時に新しいturnを起動',
    usage:
      'xangi tool trigger --channel <id> --message <text> --source <source> [--platform <platform>]',
    notes: ['終了状態とログを保存してから、成功・失敗の両方で呼ぶ。'],
  },
  {
    name: 'system_restart',
    topic: 'system',
    summary: '現在のxangiを再起動',
    usage: 'xangi tool system_restart',
  },
  {
    name: 'system_settings',
    topic: 'system',
    summary: '設定一覧の表示または設定変更',
    usage: 'xangi tool system_settings [--key <key> --value <value>]',
  },
  {
    name: 'inter_chat_send',
    topic: 'local',
    summary: '別インスタンスへメッセージを送信',
    usage: 'xangi tool inter_chat_send --text <text> [--from-label <label>] [--origin-chain <csv>]',
  },
  {
    name: 'inter_chat_tail',
    topic: 'local',
    summary: 'インスタンス間メッセージを取得',
    usage: 'xangi tool inter_chat_tail [--limit <n>] [--ttl <sec>]',
  },
  {
    name: 'inter_chat_clear',
    topic: 'local',
    summary: '自分のインスタンス間メッセージを削除',
    usage: 'xangi tool inter_chat_clear',
  },
  {
    name: 'inter_chat_list',
    topic: 'local',
    summary: '共有ディレクトリのインスタンス一覧を表示',
    usage: 'xangi tool inter_chat_list',
  },
  {
    name: 'inter_chat_config',
    topic: 'local',
    summary: 'インスタンス間チャット設定を表示',
    usage: 'xangi tool inter_chat_config',
  },
  {
    name: 'terminal_session',
    topic: 'local',
    summary: '外部terminal用Webセッションを作成',
    usage: 'xangi tool terminal_session [--title <text>] [--source <source>]',
  },
  {
    name: 'g2_session',
    topic: 'local',
    summary: 'Even G2用Webセッションを作成',
    usage: 'xangi tool g2_session [--title <text>]',
  },
];

const TOPICS = [
  'discord',
  'slack',
  'web',
  'schedule',
  'models',
  'trigger',
  'system',
  'local',
] as const;

export function formatXangiCmdHelp(query?: string): string {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return [
      'xangi tool help <topic|command>',
      '',
      `Topics: ${TOPICS.join(', ')}`,
      '',
      ...XANGI_CMD_HELP_ENTRIES.map((entry) => `  ${entry.name.padEnd(24)} ${entry.summary}`),
    ].join('\n');
  }

  const exact = XANGI_CMD_HELP_ENTRIES.find((entry) => entry.name === normalized);
  if (exact) {
    return [
      `${exact.name} — ${exact.summary}`,
      '',
      `Usage: ${exact.usage}`,
      ...(exact.notes?.length ? ['', ...exact.notes.map((note) => `- ${note}`)] : []),
    ].join('\n');
  }

  const matches = XANGI_CMD_HELP_ENTRIES.filter((entry) => entry.topic === normalized);
  if (matches.length > 0) {
    return [`${normalized} commands:`, '', ...matches.map((entry) => `  ${entry.usage}`)].join(
      '\n'
    );
  }

  throw new ValidationError(`Unknown help topic or command: ${query}`);
}
