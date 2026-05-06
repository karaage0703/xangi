/**
 * 自走モード（auto-talk）
 *
 * - web-chat のセッション単位で ON/OFF
 * - ON のとき、ランダム間隔 (デフォ 10〜45秒) で agent を叩いて発話を生成
 * - 発話結果はセッションの履歴に保存（agent runner が transcript-logger 経由で書く）
 * - 同時に flowFromHostPlatform で inter-chat jsonl にも流れる（既存の onComplete 経路で）
 *   ※ web-chat.ts 経由ではなく autoTalk から直接 runner を叩くため、ここで明示的に
 *     flowFromHostPlatform('agent') を呼ぶ
 * - 双方の xangi で 🤖 ON にすれば、相手の発話が直近履歴に入って自分も応える形で会話継続
 *
 * UI 表示:
 * - prompt 先頭に AUTOTALK_SENTINEL を入れて、Web UI 側でこのマーカーを持つ user
 *   メッセージは非表示にする。agent 応答（自走発話）だけが見える形にする。
 *
 * env:
 *   INTER_INSTANCE_CHAT_AUTOTALK_MIN_SEC  = 10
 *   INTER_INSTANCE_CHAT_AUTOTALK_MAX_SEC  = 45
 *   INTER_INSTANCE_CHAT_AUTOTALK_HISTORY_LIMIT = 20  (プロンプトに含める直近メッセージ数)
 */
export const AUTOTALK_SENTINEL = '[__XANGI_AUTOTALK_INTERNAL__]';
import type { AgentRunner } from '../agent-runner.js';
import { getSessionEntry, getProviderSessionId, listAutoTalkSessions } from '../sessions.js';
import { WEB_CHAT_CONTEXT_PREFIX } from '../sessions.js';
import { threadIdFor, turnIdFor } from '../events-emitter.js';
import { runWithBubbleEvents } from '../bubble-events-runner.js';
import {
  getInterChatConfig,
  flowFromHostPlatform,
  readRecent,
  type InterChatMessage,
} from './index.js';

interface AutoTalkConfig {
  minSec: number;
  maxSec: number;
  historyLimit: number;
}

function readAutoTalkConfig(): AutoTalkConfig {
  const minSec = parseInt(process.env.INTER_INSTANCE_CHAT_AUTOTALK_MIN_SEC || '10', 10);
  const maxSec = parseInt(process.env.INTER_INSTANCE_CHAT_AUTOTALK_MAX_SEC || '45', 10);
  const historyLimit = parseInt(process.env.INTER_INSTANCE_CHAT_AUTOTALK_HISTORY_LIMIT || '20', 10);
  return {
    minSec: Number.isFinite(minSec) && minSec > 0 ? minSec : 10,
    maxSec: Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 45,
    historyLimit: Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : 20,
  };
}

function pickInterval(cfg: AutoTalkConfig): number {
  const min = Math.min(cfg.minSec, cfg.maxSec);
  const max = Math.max(cfg.minSec, cfg.maxSec);
  return min + Math.random() * (max - min);
}

function buildAutoTalkPrompt(
  recent: InterChatMessage[],
  ctx: { selfInstanceId: string; selfLabel: string; sessionTitle?: string }
): string {
  const historyLines = recent.map((m) => {
    const who = m.from_label || m.from;
    const tag = m.from === ctx.selfInstanceId ? '*self*' : ' ';
    return `${tag} [${who}]: ${m.text}`;
  });
  const historyBlock =
    historyLines.length > 0
      ? `--- 直近の inter-instance-chat ---\n${historyLines.join('\n')}\n--- ここまで ---`
      : '(まだ会話履歴なし)';

  return [
    AUTOTALK_SENTINEL,
    `[xangi inter-instance-chat 自走モード]`,
    `あなたは xangi インスタンス \`${ctx.selfLabel}\` (id=${ctx.selfInstanceId}) です。`,
    ctx.sessionTitle ? `所属セッション: 「${ctx.sessionTitle}」` : '',
    `これは「自走モード」です。一定時間ごとに、自由に発話する番が回ってきます。`,
    ``,
    historyBlock,
    ``,
    `次の発話を **120文字以内**、1〜2文で出してください。指針:`,
    `- 直近の会話の流れを踏まえる（同じ話題が続いてればそれに応じる）`,
    `- 別 xangi に話を振りたければ \`@<相手のid>\` でメンション可（id は上の履歴の \`[name]\` 部分）`,
    `- 連投を避ける。直前が自分の発話なら短い相槌や別話題を投げる`,
    `- 話すことが本当に何もなければ、半角の \`...\` だけ返してOK（その回は黙る扱い）`,
    `- 返答はそのまま inter-chat に投稿される（前置きや道案内は不要）`,
  ]
    .filter(Boolean)
    .join('\n');
}

interface SessionTimer {
  appSessionId: string;
  contextKey: string;
  timer: NodeJS.Timeout;
  inflight: boolean;
}

const timers = new Map<string, SessionTimer>();
let agentRunnerRef: AgentRunner | null = null;
let log: (msg: string) => void = (m) => console.log(`[inter-chat-autotalk] ${m}`);

function scheduleNext(appSessionId: string): void {
  const slot = timers.get(appSessionId);
  if (!slot) return;
  const cfg = readAutoTalkConfig();
  const sec = pickInterval(cfg);
  slot.timer = setTimeout(() => fire(appSessionId), Math.round(sec * 1000));
  slot.timer.unref();
}

async function fire(appSessionId: string): Promise<void> {
  const slot = timers.get(appSessionId);
  if (!slot || slot.inflight || !agentRunnerRef) {
    if (slot) scheduleNext(appSessionId);
    return;
  }
  const entry = getSessionEntry(appSessionId);
  if (!entry || entry.archived || !entry.autoTalk) {
    log(`session ${appSessionId} no longer eligible — stopping`);
    stopForSession(appSessionId);
    return;
  }
  const interCfg = getInterChatConfig();
  if (!interCfg.enabled) {
    log(`inter-chat disabled — postponing`);
    scheduleNext(appSessionId);
    return;
  }

  slot.inflight = true;
  try {
    const at = readAutoTalkConfig();
    const recent = readRecent(at.historyLimit);
    const prompt = buildAutoTalkPrompt(recent, {
      selfInstanceId: interCfg.selfInstanceId,
      selfLabel: interCfg.selfLabel,
      sessionTitle: entry.title,
    });
    const providerSessionId = getProviderSessionId(slot.contextKey);
    log(`firing for session ${appSessionId} (recent=${recent.length})`);
    const result = await runWithBubbleEvents(
      agentRunnerRef,
      prompt,
      {
        threadId: threadIdFor('web', appSessionId),
        turnId: turnIdFor('web', `autotalk-${Date.now()}`),
        threadLabel: entry.title || 'Browser session',
        platform: 'web',
        // 自走発話なので user 入力なし
      },
      {},
      {
        sessionId: providerSessionId,
        channelId: slot.contextKey,
        appSessionId,
      }
    );
    const text = (result.result || '').trim();
    if (!text || text === '...' || text === '。。。') {
      log(`session ${appSessionId} chose to stay silent`);
    } else {
      flowFromHostPlatform(text, 'agent');
      log(`session ${appSessionId} spoke ${text.length} chars`);
    }
  } catch (e) {
    log(`fire failed for ${appSessionId}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    slot.inflight = false;
    scheduleNext(appSessionId);
  }
}

function stopForSession(appSessionId: string): void {
  const slot = timers.get(appSessionId);
  if (!slot) return;
  clearTimeout(slot.timer);
  timers.delete(appSessionId);
}

function startForSession(appSessionId: string): boolean {
  const entry = getSessionEntry(appSessionId);
  if (!entry || entry.archived) return false;
  if (entry.platform !== 'web') return false;
  if (!entry.contextKey?.startsWith(WEB_CHAT_CONTEXT_PREFIX)) return false;
  if (timers.has(appSessionId)) return true;
  timers.set(appSessionId, {
    appSessionId,
    contextKey: entry.contextKey,
    timer: setTimeout(() => undefined, 0),
    inflight: false,
  });
  scheduleNext(appSessionId);
  log(`started for session ${appSessionId} (${entry.title || '(no title)'})`);
  return true;
}

/**
 * autotalk システムを起動。すでに autoTalk=true な web セッションのタイマーを上げる。
 * web-chat 起動後（agentRunner が存在する状態）に呼ぶ。
 */
export function setupAutoTalk(options: { agentRunner: AgentRunner; log?: (m: string) => void }): {
  enable: (appSessionId: string) => boolean;
  disable: (appSessionId: string) => void;
  isActive: (appSessionId: string) => boolean;
  stopAll: () => void;
  activeSessionIds: () => string[];
} {
  agentRunnerRef = options.agentRunner;
  if (options.log) log = options.log;
  const cfg = getInterChatConfig();
  if (!cfg.enabled) {
    log('inter-chat disabled, autotalk dormant (toggle API still works to prepare entries)');
  }
  // 既存の autoTalk セッションを再開
  for (const e of listAutoTalkSessions()) {
    startForSession(e.id);
  }

  return {
    enable(appSessionId: string): boolean {
      return startForSession(appSessionId);
    },
    disable(appSessionId: string): void {
      stopForSession(appSessionId);
    },
    isActive(appSessionId: string): boolean {
      return timers.has(appSessionId);
    },
    stopAll(): void {
      for (const id of Array.from(timers.keys())) {
        stopForSession(id);
      }
    },
    activeSessionIds(): string[] {
      return Array.from(timers.keys());
    },
  };
}
