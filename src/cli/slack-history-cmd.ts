/**
 * Slack の現チャンネルの会話履歴を取得する CLI モジュール。
 *
 * web_history と同じパターンで xangi のセッション jsonl から読む。
 * Slack の場合は contextKey = channelId なので、env XANGI_CHANNEL_ID = <channelId>
 * からセッションを特定する。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

interface Entry {
  role?: string;
  content?: unknown;
  createdAt?: string;
}

interface SlackHistoryFlags {
  channel?: string;
  count?: string;
  'max-chars'?: string;
}

function getSessionsDir(): string {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  return join(workdir, 'logs', 'sessions');
}

function fmtContent(content: unknown, maxChars: number): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') {
          const obj = x as { text?: string };
          return obj.text ?? JSON.stringify(x);
        }
        return String(x);
      })
      .join(' ');
  } else if (content && typeof content === 'object') {
    const obj = content as { result?: string };
    text = obj.result ?? JSON.stringify(content);
  } else {
    text = String(content ?? '');
  }
  text = text.replace(/\r?\n/g, ' ');
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/**
 * 現 Slack チャンネルに対応する appSessionId を探す。
 * sessions.json を介さず、logs/sessions/*.jsonl から
 * messages の (contextKey or channelId) フィールドが一致するものを mtime 最新で 1 個拾う。
 */
function resolveSlackSession(channelId: string): string | undefined {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return undefined;
  let best: { name: string; mtime: number } | undefined;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const path = join(dir, file);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    // 最初の有効な行で contextKey / channelId を判定 (1 ファイル全行スキャンは重い)
    const head = raw.split('\n').slice(0, 50).join('\n');
    if (
      head.includes(`"contextKey":"${channelId}"`) ||
      head.includes(`"channelId":"${channelId}"`)
    ) {
      const m = statSync(path).mtimeMs;
      if (!best || m > best.mtime) {
        best = { name: file.replace(/\.jsonl$/, ''), mtime: m };
      }
    }
  }
  return best?.name;
}

export function slackHistoryCmd(flags: Record<string, string>): string {
  const f = flags as SlackHistoryFlags;
  const count = Math.max(1, parseInt(f.count ?? '10', 10) || 10);
  const maxChars = Math.max(50, parseInt(f['max-chars'] ?? '500', 10) || 500);

  const channel = f.channel || process.env.XANGI_CHANNEL_ID;
  if (!channel) {
    return '(no channel; specify --channel <id> or run from a Slack session)';
  }

  const session = resolveSlackSession(channel);
  if (!session) {
    return `(no slack session found for channel ${channel} in ${getSessionsDir()})`;
  }

  const path = join(getSessionsDir(), `${session}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return `(failed to read ${session}.jsonl)`;
  }

  const msgs: Entry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      msgs.push(JSON.parse(trimmed) as Entry);
    } catch {
      // skip malformed
    }
  }

  const tail = msgs.slice(-count);
  const lines = [`# slack channel: ${channel} (session: ${session})`];
  for (const m of tail) {
    const ts = m.createdAt ?? '';
    const role = m.role ?? '?';
    lines.push(`[${ts}] [${role}] ${fmtContent(m.content, maxChars)}`);
  }
  return lines.join('\n');
}
