/**
 * xangi-cmd inter-chat — inter-instance-chat 操作CLI
 *
 * インスタンスは「起動中の xangi」とは独立に CLI からも書ける。
 * 同じ DATA_DIR / XANGI_INSTANCE_ID を使うので、jsonl は同じ ID で append される。
 *
 * サブコマンド:
 *   inter_chat_send       --text <text> [--from-label <label>] [--origin-chain user,bob]
 *   inter_chat_tail       [--limit <n>] [--ttl <sec>]
 *   inter_chat_clear      （自分の jsonl を TTL で compact）
 *   inter_chat_list       （現在 dir にある instance ファイル一覧）
 *   inter_chat_config     （解決済み設定の表示）
 */
import {
  getInterChatConfig,
  sendMessage,
  readRecent,
  _resetInterChatConfigForTest,
} from '../inter-instance-chat/index.js';
import {
  listInstanceFiles,
  instanceIdFromFile,
  compactSelf,
} from '../inter-instance-chat/jsonl-store.js';

function fmtTs(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ensureEnabled(): void {
  // CLI 経由は INTER_INSTANCE_CHAT_ENABLED=true 強制（dir が解決される必要があるため、
  // .env で false でも CLI は使えるようにする目的で一時的に override する）。
  if (process.env.INTER_INSTANCE_CHAT_ENABLED !== 'true') {
    process.env.INTER_INSTANCE_CHAT_ENABLED = 'true';
    _resetInterChatConfigForTest();
  }
}

export async function interChatCmd(
  command: string,
  flags: Record<string, string>
): Promise<string> {
  ensureEnabled();
  const cfg = getInterChatConfig();

  switch (command) {
    case 'inter_chat_send': {
      const text = flags['text'] || flags['message'] || flags['msg'] || '';
      if (!text || text === 'true') {
        throw new Error('--text は必須です');
      }
      const fromLabel = flags['from-label'] || flags['from_label'] || undefined;
      const originChainRaw = flags['origin-chain'] || flags['origin_chain'] || undefined;
      const origin_chain = originChainRaw
        ? originChainRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const msg = sendMessage(text, { from_label: fromLabel, origin_chain });
      if (!msg) return '空テキストのため送信しませんでした';
      return [
        '✅ 送信完了',
        `  msg_id: ${msg.msg_id}`,
        `  from:   ${msg.from} (${msg.from_label || '-'})`,
        `  ts:     ${fmtTs(msg.ts)}`,
        `  chain:  ${msg.origin_chain.join(' → ')}`,
        `  text:   ${msg.text}`,
      ].join('\n');
    }

    case 'inter_chat_tail': {
      const limit = parseInt(flags['limit'] || '20', 10);
      const ttl = flags['ttl'] ? parseInt(flags['ttl'], 10) : undefined;
      const messages = readRecent(limit, ttl);
      if (messages.length === 0) {
        return '（メッセージなし）';
      }
      const lines = messages.map((m) => {
        const tag = m.from === cfg.selfInstanceId ? '*' : ' ';
        const chain =
          m.origin_chain && m.origin_chain.length > 0 ? ` ⛓${m.origin_chain.join('→')}` : '';
        return `${tag} [${fmtTs(m.ts)}] ${m.from_label || m.from}${chain}: ${m.text}`;
      });
      lines.unshift(`📜 ${messages.length}件 (TTL ${ttl ?? cfg.ttlSec}s, * = 自分)`);
      return lines.join('\n');
    }

    case 'inter_chat_clear': {
      const result = compactSelf(cfg.dir, cfg.selfInstanceId, cfg.ttlSec);
      return `🧹 自分のファイル compact 完了: kept=${result.kept}, removed=${result.removed}`;
    }

    case 'inter_chat_list': {
      const files = listInstanceFiles(cfg.dir);
      if (files.length === 0) return `（${cfg.dir} にファイルなし）`;
      const lines = files.map((f) => {
        const id = instanceIdFromFile(f);
        const tag = id === cfg.selfInstanceId ? ' (self)' : '';
        return `  ${id}${tag}`;
      });
      lines.unshift(`📁 ${cfg.dir}`);
      return lines.join('\n');
    }

    case 'inter_chat_config': {
      return [
        '🔧 inter-instance-chat config',
        `  enabled:             ${cfg.enabled}`,
        `  dir:                 ${cfg.dir}`,
        `  selfInstanceId:      ${cfg.selfInstanceId}`,
        `  selfLabel:           ${cfg.selfLabel}`,
        `  ttlSec:              ${cfg.ttlSec}`,
        `  compactIntervalSec:  ${cfg.compactIntervalSec}`,
        `  usePolling:          ${cfg.usePolling}`,
      ].join('\n');
    }

    default:
      throw new Error(`Unknown inter-chat command: ${command}`);
  }
}
