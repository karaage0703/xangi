import { ValidationError } from '../errors.js';

export interface XangiCmdHelpEntry {
  name: string;
  topic:
    | 'discord'
    | 'slack'
    | 'web'
    | 'schedule'
    | 'models'
    | 'settings'
    | 'trigger'
    | 'system'
    | 'extension'
    | 'local';
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
    name: 'web_status',
    topic: 'web',
    summary: '現在のWeb UIアクセス先とHTTP状態をJSONで取得',
    usage: 'xangi tool web_status',
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
    name: 'schedule_update',
    topic: 'schedule',
    summary: '既存スケジュールをIDを維持して更新',
    usage:
      'xangi tool schedule_update --id <schedule-id> [--input <自然言語またはcron> | --message <text>] [--channel <id>] [--platform <discord|slack|telegram|web>]',
    notes: [
      '未指定項目は保持される。--input と --message は同時指定不可。platform変更時は --channel も必要。',
    ],
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
    notes: [
      '利用可能なモデルは--backendで取得し、返った正確なIDだけを案内する。取得失敗時に固定名で補わない。',
      '--useはユーザーの明示依頼がある場合だけ使い、次のturnから適用される。',
      'Discordスレッドでは親設定チャンネルIDを--channelへ指定する。',
    ],
  },
  {
    name: 'runtime_settings',
    topic: 'settings',
    summary: '起動中チャンネルの設定を確認・即時変更',
    usage:
      'xangi tool runtime_settings --name <backend|llmmode|autoreply|notify|threadmode|replysuggestions|respondtobots> --action <show|set|reset> [--value <value>] [--backend <backend>] [--model <model>] [--effort <level>] [--channel <id>] [--platform <platform>]',
    notes: [
      'ユーザーが設定変更を明示依頼した場合だけ使う。',
      'Discordスレッドでは親チャンネルIDを--channelへ指定する。',
      'restart/stop/new/schedule/skillは対象外。',
    ],
  },
  {
    name: 'trigger',
    topic: 'trigger',
    summary: 'イベント完了時に新しいturnを起動',
    usage:
      'xangi tool trigger --channel <id> --message <text> --source <source> [--platform <platform>]',
    notes: [
      '終了状態とログを保存してから、成功・失敗の両方で呼ぶ。',
      '同一sourceの即時再試行と実行中turnへの重複発火を避ける。',
      '定刻確認はschedule、完了時通知はtriggerを使う。',
      '返されたIDはtrigger_statusで実行・配信状態を確認できる。',
    ],
  },
  {
    name: 'trigger_status',
    topic: 'trigger',
    summary: 'triggerの実行・配信状態を取得',
    usage: 'xangi tool trigger_status --id <trigger-id>',
  },
  {
    name: 'system_restart',
    topic: 'system',
    summary: '現在のxangiを再起動',
    usage: 'xangi tool system_restart',
    notes: [
      '現在のxangi自身からこのturnで直接呼び、遅延・子プロセス・スケジューラへ委譲しない。',
      '受付を完了とみなさず、復帰後に状態・起動時刻・ログを確認する。',
    ],
  },
  {
    name: 'extension_request',
    topic: 'extension',
    summary: '認証情報を公開せずmanaged extension APIを呼び出す',
    usage:
      'xangi tool extension_request --id <extension-id> --capability <capability-id> --path </path> [--method <GET|POST|PUT|DELETE>] [--query-json <json-object> | --query-json-stdin] [--body-json <json>]',
    notes: [
      '--query-json はURLエンコードされる。認証tokenや内部portは出力されない。',
      '--query-json-stdin はstdinのJSON objectをqueryに使い、値をargvへ載せない。',
      '--body-json はPOST/PUTでのみ使用できる。',
    ],
  },
  {
    name: 'extension_update',
    topic: 'extension',
    summary: '確認済みcommitへrepository-managed extensionをtransaction更新',
    usage:
      'xangi tool extension_update --id <extension-id> --to <40-character-commit-sha> [--accept-manifest-changes true]',
    notes: [
      'Extensions画面で作成された更新会話から使う。manifestにupdate.prepareを宣言したrepository sourceだけが対象。',
      'manifestの権限・capability・entrypoint・agent backend・UI mapping・更新準備command変更はユーザー承認後だけ--accept-manifest-changes trueを付ける。',
    ],
  },
  {
    name: 'extension_uninstall',
    topic: 'extension',
    summary: '現在のinstanceでextensionを停止・unlinkして結果を検証',
    usage: 'xangi tool extension_uninstall --id <extension-id>',
    notes: [
      'Extensions画面で作成された削除会話から、workspace cleanup承認後に1回だけ使う。',
      'download済みsource、extension data、index、設定は削除しない。',
    ],
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
  'settings',
  'trigger',
  'system',
  'extension',
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
