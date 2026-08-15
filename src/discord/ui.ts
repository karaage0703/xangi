import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Message } from 'discord.js';
import type { AgentRunner } from '../agent-runner.js';
import type { TurnHistoryEntry } from '../activity-store.js';
import { TIMEOUT_EXTEND_ENABLED } from '../constants.js';

/** 残り時間を mm:ss でフォーマット */
export function formatRemaining(remainingMs: number): string {
  const sec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** 処理中に表示するボタン群 (Stop / 延長 / 残り MM:SS の順) */
export function createProcessingButtons(timeout?: {
  remainingMs: number;
  canExtend: boolean;
  extendEnabled: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId('xangi_stop').setLabel('Stop').setStyle(ButtonStyle.Secondary)
  );
  if (timeout) {
    const isWarn = timeout.remainingMs <= 30_000;
    if (timeout.extendEnabled) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('xangi_extend')
          .setLabel('延長')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!timeout.canExtend)
      );
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('xangi_timeout_display')
        .setLabel(`⏱ ${formatRemaining(timeout.remainingMs)}`)
        .setStyle(isWarn ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(true)
    );
  }
  return row;
}

/**
 * 処理中の Discord 返信メッセージ管理 (タイムアウト UI 更新用)
 * channelId -> { message, intervalId }。runner の timeout-* イベントで
 * 残り時間ボタンと +5m ボタンを含むコンポーネント行を 10 秒間隔で edit する。
 *
 * processPrompt() と runner listener 双方からアクセスするため、
 * モジュール最上位に置く (xangi は 1 process = 1 Discord client なので共有しても安全)。
 */
export type DiscordProcessingEntry = { message: Message; intervalId?: NodeJS.Timeout };
export const discordProcessingMessages = new Map<string, DiscordProcessingEntry>();
export const discordToolHistoryByMessageId = new Map<string, TurnHistoryEntry[]>();
export const discordReplySuggestionsByMessageId = new Map<string, string[]>();

export type DiscordHistoryContext = { threadId: string; turnId: string };

const DISCORD_HISTORY_CUSTOM_ID = 'xangi_tools';

export function createDiscordHistoryCustomId(context?: DiscordHistoryContext): string {
  if (!context) return DISCORD_HISTORY_CUSTOM_ID;
  return `${DISCORD_HISTORY_CUSTOM_ID}|${context.threadId}|${context.turnId}`;
}

export function parseDiscordHistoryCustomId(customId: string): DiscordHistoryContext | undefined {
  const [prefix, threadId, turnId] = customId.split('|');
  if (prefix !== DISCORD_HISTORY_CUSTOM_ID || !threadId || !turnId) return undefined;
  return { threadId, turnId };
}

export function createReplySuggestionButtons(
  sourceMessageId: string,
  count: number
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (let index = 0; index < Math.min(count, 5); index++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`xangi_reply_suggestion_${sourceMessageId}_${index}`)
        .setLabel(String(index + 1))
        .setStyle(ButtonStyle.Primary)
    );
  }
  return row;
}

/** チャンネルの現在のタイムアウト状態から Discord UI 用に整形 */
export function getDiscordTimeoutInfoFor(
  agentRunner: AgentRunner,
  channelId: string
): { remainingMs: number; canExtend: boolean; extendEnabled: boolean } | undefined {
  const state = agentRunner.getTimeoutState?.(channelId);
  if (!state?.active || state.timeoutAt == null) return undefined;
  const remainingMs = Math.max(0, state.timeoutAt - Date.now());
  // 「延長 = 残り時間を 2 倍」なので、残り時間を一度加算しても max を越えないか判定
  const canExtend =
    state.maxTimeoutAt != null && state.timeoutAt + remainingMs <= state.maxTimeoutAt;
  return { remainingMs, canExtend, extendEnabled: TIMEOUT_EXTEND_ENABLED };
}

/** 完了後に表示するボタン群 */
export function createCompletedButtons(options?: {
  showTools?: boolean;
  historyContext?: DiscordHistoryContext;
  showLeave?: boolean;
  showReplySuggestions?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (options?.showLeave) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('xangi_thread_leave')
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId('xangi_new').setLabel('New').setStyle(ButtonStyle.Secondary)
    );
  }
  if (options?.showTools) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(createDiscordHistoryCustomId(options.historyContext))
        .setLabel('History')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (options?.showReplySuggestions) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('xangi_reply_suggestions')
        .setLabel('返信候補')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

/**
 * runner の timeout-* イベントを Discord 処理中メッセージのボタン更新に紐付ける。
 * main() 起動シーケンスから一度だけ呼ぶ。
 */
export function registerDiscordTimeoutUi(agentRunner: AgentRunner): void {
  /** 処理中メッセージの components を最新のタイムアウト状態に合わせて edit */
  const refreshDiscordProcessingButtons = (channelId: string): void => {
    const entry = discordProcessingMessages.get(channelId);
    if (!entry) return;
    const info = getDiscordTimeoutInfoFor(agentRunner, channelId);
    if (!info) return; // active でなければ何もしない (timeout-cleared で別途片付ける)
    entry.message
      .edit({ components: [createProcessingButtons(info)] })
      .catch((e) => console.warn('[xangi] Failed to refresh processing buttons:', e?.message));
  };

  const runnerEmitter = agentRunner as unknown as {
    on?: (e: string, l: (p: unknown) => void) => void;
  };
  if (typeof runnerEmitter.on !== 'function') return;

  runnerEmitter.on('timeout-started', (payload: unknown) => {
    const p = payload as { channelId?: string };
    if (!p.channelId) return;
    const entry = discordProcessingMessages.get(p.channelId);
    if (!entry) return; // Discord 経由でなければ無視 (web/slack 等は別経路)
    // 初回描画
    refreshDiscordProcessingButtons(p.channelId);
    // 10 秒ごとの補完用 dedicated interval。
    // 通常は processPrompt の thinking/stream interval が毎秒 message.edit するときに
    // 一緒に components (Stop/延長/⏱) を最新化するので、追加 API call なしで 1 秒粒度更新が成立する。
    // ここはストリーミングが止まったまま長引いた場合や、tool 連続呼び出しで edit が
    // 走らない隙間に残り時間が遅れないようにする補完。
    if (entry.intervalId) clearInterval(entry.intervalId);
    entry.intervalId = setInterval(() => {
      const info = getDiscordTimeoutInfoFor(agentRunner, p.channelId!);
      if (!info) {
        if (entry.intervalId) clearInterval(entry.intervalId);
        return;
      }
      refreshDiscordProcessingButtons(p.channelId!);
    }, 10_000);
  });
  runnerEmitter.on('timeout-extended', (payload: unknown) => {
    const p = payload as { channelId?: string };
    if (!p.channelId) return;
    refreshDiscordProcessingButtons(p.channelId);
  });
  runnerEmitter.on('timeout-cleared', (payload: unknown) => {
    const p = payload as { channelId?: string };
    if (!p.channelId) return;
    const entry = discordProcessingMessages.get(p.channelId);
    if (!entry) return;
    if (entry.intervalId) clearInterval(entry.intervalId);
    discordProcessingMessages.delete(p.channelId);
  });
}
