import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { updateEnvKeyValue } from './env-persist.js';
import { resolveAppLayout } from './installer/layout.js';
import { SECRET_FIELDS, validateSettingValue } from './cli/settings-cmd.js';
import { SecretStore } from './setup/secret-store.js';
import { backendAuthenticationSnapshot } from './backend-auth-status.js';

type FieldType = 'boolean' | 'integer' | 'number' | 'select' | 'text';

export interface WebStartupSetting {
  key: string;
  label: string;
  description: string;
  type: FieldType;
  value: string;
  defaultValue: string;
  options?: string[];
  min?: number;
  max?: number;
  applyMode: 'restart';
}

export interface WebStartupSettingsGroup {
  id: string;
  label: string;
  settings: WebStartupSetting[];
}

interface Definition extends Omit<WebStartupSetting, 'value' | 'applyMode'> {
  group: string;
  groupLabel: string;
}

const DEFINITIONS: Definition[] = [
  {
    group: 'general',
    groupLabel: '全般',
    key: 'SESSION_TITLE_MODE',
    label: 'セッションタイトル',
    description: '会話タイトルをAI生成または接頭辞形式にします。',
    type: 'select',
    defaultValue: 'ai',
    options: ['ai', 'prefix'],
  },
  {
    group: 'general',
    groupLabel: '全般',
    key: 'COMPLETION_SHOW_ELAPSED',
    label: '完了時に経過時間を表示',
    description: '完了表示へ処理時間を含めます。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'general',
    groupLabel: '全般',
    key: 'COMPLETION_NOTIFY_AFTER_MS',
    label: '完了通知の基準時間 (ms)',
    description: '短い処理では完了通知を省略します。',
    type: 'integer',
    defaultValue: '10000',
    min: 0,
  },
  {
    group: 'general',
    groupLabel: '全般',
    key: 'HISTORY_PREFETCH_ENABLED',
    label: '会話履歴の先読み',
    description: '初回turnへ直近の履歴を注入します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'general',
    groupLabel: '全般',
    key: 'HISTORY_PREFETCH_COUNT',
    label: '先読み件数',
    description: '初回turnへ渡す直近メッセージ数です。',
    type: 'integer',
    defaultValue: '10',
    min: 1,
    max: 100,
  },
  {
    group: 'general',
    groupLabel: '全般',
    key: 'XANGI_SESSION_RETENTION_DAYS',
    label: 'セッション保持日数',
    description: '0は自動削除しません。',
    type: 'integer',
    defaultValue: '0',
    min: 0,
  },

  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_STREAMING',
    label: 'ストリーミング表示',
    description: '生成途中の内容を更新表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_SHOW_THINKING',
    label: '思考状態を表示',
    description: '処理中の状態表示を有効にします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_TOOL_HISTORY_MODE',
    label: 'ツール履歴',
    description: 'ツール実行履歴の表示方法です。',
    type: 'select',
    defaultValue: 'button',
    options: ['button', 'inline', 'off'],
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_SHOW_LIVE_TOOL_USE',
    label: 'ツール実行をライブ表示',
    description: '実行中のツール名を表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_SHOW_TOOL_BUTTON',
    label: 'ツール履歴ボタン',
    description: '履歴モードがbuttonのときボタンを表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_SHOW_BUTTONS',
    label: '操作ボタン',
    description: 'NewやStopなどの操作ボタンを表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'INJECT_CHANNEL_TOPIC',
    label: 'チャンネルトピックを注入',
    description: 'チャンネルtopicを会話文脈へ含めます。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'INJECT_TIMESTAMP',
    label: '現在時刻を注入',
    description: 'メッセージ受信時刻を会話文脈へ含めます。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_REPLY_SUGGESTIONS_COUNT',
    label: '返信候補数',
    description: '1〜5件の返信候補を生成します。',
    type: 'integer',
    defaultValue: '3',
    min: 1,
    max: 5,
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_COMPLETION_NOTIFY',
    label: '既定の完了通知',
    description: 'チャンネル固有設定がない場合の通知方式です。',
    type: 'select',
    defaultValue: 'message',
    options: ['off', 'message', 'mention'],
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'DISCORD_COMPLETION_NOTIFY_AFTER_MS',
    label: '完了通知までの時間 (ms)',
    description: 'この時間を超えた処理を通知します。',
    type: 'integer',
    defaultValue: '10000',
    min: 0,
  },
  {
    group: 'discord',
    groupLabel: 'Discord',
    key: 'RESPOND_TO_BOTS_MAX_CONSECUTIVE',
    label: 'Bot連続応答上限',
    description: '0以下は無制限のため非推奨です。',
    type: 'integer',
    defaultValue: '3',
  },

  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_REPLY_IN_THREAD',
    label: 'スレッドへ返信',
    description: '返信先をSlackスレッドにします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_STREAMING',
    label: 'ストリーミング表示',
    description: '生成途中の内容を更新表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_SHOW_THINKING',
    label: '思考状態を表示',
    description: '処理中の状態表示を有効にします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_REPLY_SUGGESTIONS_COUNT',
    label: '返信候補数',
    description: '1〜5件の返信候補を生成します。',
    type: 'integer',
    defaultValue: '3',
    min: 1,
    max: 5,
  },
  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_COMPLETION_NOTIFY_AFTER_MS',
    label: '完了通知までの時間 (ms)',
    description: 'この時間を超えた処理を通知します。',
    type: 'integer',
    defaultValue: '10000',
    min: 0,
  },
  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_REACTION_DELETE_ENABLED',
    label: 'リアクション削除',
    description: '指定リアクションでBot投稿を削除します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'slack',
    groupLabel: 'Slack',
    key: 'SLACK_DELETE_REACTIONS',
    label: '削除リアクション',
    description: 'カンマ区切りの絵文字名です。',
    type: 'text',
    defaultValue: 'wastebasket,x',
  },

  {
    group: 'web',
    groupLabel: 'Web',
    key: 'WEB_REPLY_SUGGESTIONS_COUNT',
    label: '返信候補数',
    description: '1〜5件の返信候補を生成します。',
    type: 'integer',
    defaultValue: '3',
    min: 1,
    max: 5,
  },
  {
    group: 'web',
    groupLabel: 'Web',
    key: 'WEB_CHAT_UPLOAD_MAX_MB',
    label: 'アップロード上限 (MB)',
    description: 'Web Chatで受け付けるファイルサイズです。',
    type: 'integer',
    defaultValue: '64',
    min: 1,
    max: 1024,
  },

  {
    group: 'line',
    groupLabel: 'LINE',
    key: 'LINE_LOADING_ANIMATION_ENABLED',
    label: '入力中表示',
    description: '受信直後に入力中アニメーションを表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'line',
    groupLabel: 'LINE',
    key: 'LINE_LOADING_ANIMATION_SECONDS',
    label: '入力中表示時間 (秒)',
    description: '5〜60秒で指定します。',
    type: 'integer',
    defaultValue: '60',
    min: 5,
    max: 60,
  },
  {
    group: 'line',
    groupLabel: 'LINE',
    key: 'LINE_SLOW_RESPONSE_ENABLED',
    label: '遅延時Push切替',
    description: '応答が遅い場合にPush APIへ切り替えます。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'line',
    groupLabel: 'LINE',
    key: 'LINE_SLOW_RESPONSE_THRESHOLD_MS',
    label: '遅延判定 (ms)',
    description: 'Push APIへ切り替えるまでの時間です。',
    type: 'integer',
    defaultValue: '45000',
    min: 1000,
  },
  {
    group: 'line',
    groupLabel: 'LINE',
    key: 'LINE_IDLE_RESET_ENABLED',
    label: '無操作時セッション更新',
    description: '長時間空いた会話を新しいセッションにします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'line',
    groupLabel: 'LINE',
    key: 'LINE_IDLE_RESET_HOURS',
    label: '無操作判定 (時間)',
    description: '0で無効にします。',
    type: 'number',
    defaultValue: '4',
    min: 0,
  },

  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_MODE',
    label: '受信方式',
    description: 'pollingまたはwebhookを選択します。',
    type: 'select',
    defaultValue: 'polling',
    options: ['polling', 'webhook'],
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_STREAMING',
    label: 'ストリーミング表示',
    description: '生成途中の内容を更新表示します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_SHOW_THINKING',
    label: '思考状態を表示',
    description: '処理中の状態表示を有効にします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_REPLY_TO_MENTION_IN_GROUP',
    label: 'グループメンションへ返信',
    description: 'グループ内のメンションへ応答します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_IDLE_RESET_ENABLED',
    label: '無操作時セッション更新',
    description: '長時間空いた会話を新しいセッションにします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_IDLE_RESET_HOURS',
    label: '無操作判定 (時間)',
    description: '0で無効にします。',
    type: 'number',
    defaultValue: '4',
    min: 0,
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_FORCE_IPV4',
    label: 'IPv4を強制',
    description: 'IPv6経路が不安定な場合だけ有効にします。',
    type: 'boolean',
    defaultValue: 'false',
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_MEDIA_ENABLED',
    label: 'メディア受信',
    description: '画像や動画のダウンロードを許可します。',
    type: 'boolean',
    defaultValue: 'false',
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_MEDIA_MAX_DOWNLOAD_MB',
    label: 'メディア上限 (MB)',
    description: 'Telegram API上限内で指定します。',
    type: 'integer',
    defaultValue: '20',
    min: 1,
    max: 20,
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_MEDIA_RETENTION_HOURS',
    label: 'メディア保持時間',
    description: '0で自動削除を無効にします。',
    type: 'number',
    defaultValue: '24',
    min: 0,
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS',
    label: 'メディアまとめ待ち (ms)',
    description: '同一アルバムをまとめる待機時間です。',
    type: 'integer',
    defaultValue: '750',
    min: 100,
    max: 5000,
  },
  {
    group: 'telegram',
    groupLabel: 'Telegram',
    key: 'TELEGRAM_ALLOWED_BOTS_MAX_CONSECUTIVE',
    label: 'Bot連続応答上限',
    description: '許可Botとの応答ループを制限します。',
    type: 'integer',
    defaultValue: '3',
  },

  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_MODE',
    label: '既定モード',
    description: 'agentはツール利用、chatは会話専用です。',
    type: 'select',
    defaultValue: 'agent',
    options: ['agent', 'chat'],
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_BASE_URL',
    label: 'API URL',
    description: 'OllamaまたはOpenAI互換APIのURLです。',
    type: 'text',
    defaultValue: 'http://localhost:11434',
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_MODEL',
    label: 'モデル',
    description: 'Local LLMで使用するモデルIDです。',
    type: 'text',
    defaultValue: '',
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_NUM_CTX',
    label: 'コンテキスト長',
    description: 'モデルサーバーのcontext長と合わせます。',
    type: 'integer',
    defaultValue: '32768',
    min: 1024,
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_TEMPERATURE',
    label: 'temperature',
    description: '0以上の生成温度です。',
    type: 'number',
    defaultValue: '0.7',
    min: 0,
    max: 2,
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_TOOLS',
    label: 'ツール利用',
    description: '組み込みツールの利用を許可します。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_SKILLS',
    label: 'スキル注入',
    description: '利用可能なスキルをプロンプトへ含めます。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'local-llm',
    groupLabel: 'Local LLM',
    key: 'LOCAL_LLM_XANGI_COMMANDS',
    label: 'xangiコマンド注入',
    description: 'xangi専用コマンドの説明を含めます。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'automation',
    groupLabel: '自動化',
    key: 'SCHEDULER_ENABLED',
    label: 'スケジューラー',
    description: '登録済みスケジュールの実行を有効にします。',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    group: 'automation',
    groupLabel: '自動化',
    key: 'STARTUP_ENABLED',
    label: '起動時タスク',
    description: 'xangi起動時のタスク実行を有効にします。',
    type: 'boolean',
    defaultValue: 'true',
  },
];

function envFileValues(): Record<string, string> {
  try {
    return parse(readFileSync(process.env.XANGI_ENV_PATH || join(process.cwd(), '.env')));
  } catch {
    return {};
  }
}

export function webStartupSettingsSnapshot(): WebStartupSettingsGroup[] {
  const values = envFileValues();
  const groups = new Map<string, WebStartupSettingsGroup>();
  for (const definition of DEFINITIONS) {
    const group = groups.get(definition.group) ?? {
      id: definition.group,
      label: definition.groupLabel,
      settings: [],
    };
    group.settings.push({
      ...definition,
      value: values[definition.key] ?? process.env[definition.key] ?? definition.defaultValue,
      applyMode: 'restart',
    });
    groups.set(definition.group, group);
  }
  return [...groups.values()];
}

export function updateWebStartupSetting(input: Record<string, unknown>): string {
  const key = String(input.key ?? '');
  const definition = DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) throw new Error('Web設定から変更できない項目です');
  const value = String(input.value ?? '').trim();
  if ([...value].some((character) => [10, 13].includes(character.charCodeAt(0)))) {
    throw new Error('設定値は1行で指定してください');
  }
  if (definition.type === 'boolean' && !['true', 'false'].includes(value)) {
    throw new Error(`${key}はtrueまたはfalseで指定してください`);
  }
  if (definition.type === 'select' && !definition.options?.includes(value)) {
    throw new Error(`${key}の値が正しくありません`);
  }
  if (definition.type === 'integer' || definition.type === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (definition.type === 'integer' && !Number.isInteger(parsed))) {
      throw new Error(`${key}は数値で指定してください`);
    }
    if (definition.min !== undefined && parsed < definition.min)
      throw new Error(`${key}は${definition.min}以上で指定してください`);
    if (definition.max !== undefined && parsed > definition.max)
      throw new Error(`${key}は${definition.max}以下で指定してください`);
  }
  if (definition.type === 'text' && !value) throw new Error(`${key}を入力してください`);
  const result = updateEnvKeyValue(key, value);
  if (!result.ok) throw new Error(result.reason || '設定を保存できませんでした');
  return `${definition.label}を保存しました。xangiの再起動後に反映されます。`;
}

export async function webConnectionSettingsSnapshot(
  authenticationSnapshot: typeof backendAuthenticationSnapshot = backendAuthenticationSnapshot
) {
  const stored = await webSecretStore().all();
  const groups = new Map<
    string,
    {
      label: string;
      fields: Array<{
        key: string;
        label: string;
        configured: boolean;
        type: 'password' | 'text';
      }>;
    }
  >();
  for (const field of SECRET_FIELDS) {
    const group = groups.get(field.group) ?? { label: field.group, fields: [] };
    group.fields.push({
      key: field.name,
      label: field.label,
      configured: Boolean(process.env[field.name] || stored[field.name]),
      type: field.type ?? 'password',
    });
    groups.set(field.group, group);
  }
  const configuredSecrets = new Set([
    ...Object.keys(stored),
    ...Object.keys(process.env).filter((key) => Boolean(process.env[key])),
  ]);
  return {
    groups: [...groups.values()],
    backends: await authenticationSnapshot(configuredSecrets),
  };
}

export async function updateWebConnectionSetting(input: Record<string, unknown>): Promise<string> {
  const key = String(input.key ?? '');
  const field = SECRET_FIELDS.find((candidate) => candidate.name === key);
  if (!field) throw new Error('Web設定から変更できない接続項目です');
  const value = String(input.value ?? '').trim();
  if (!value) throw new Error(`${field.label}を入力してください`);
  if (value.length > 8192) throw new Error(`${field.label}が長すぎます`);
  if (
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error(`${field.label}に制御文字は使用できません`);
  }
  await webSecretStore().set(key, validateSettingValue(key, value));
  return `${field.label}を安全な専用領域へ保存しました。xangiの再起動後に反映されます。`;
}

function webSecretStore(): SecretStore {
  const layout = resolveAppLayout({
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgStateHome: process.env.XDG_STATE_HOME,
  });
  return new SecretStore(join(layout.configDir, 'secrets.json'));
}
