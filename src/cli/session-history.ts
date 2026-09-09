import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface HistoryEntry {
  role?: string;
  content?: unknown;
  createdAt?: string;
}

export function getSessionsDirs(): string[] {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  return [...new Set([join(dataDir, 'logs', 'sessions'), join(workdir, 'logs', 'sessions')])];
}

export function sessionHistoryPath(session: string): string | undefined {
  return getSessionsDirs()
    .map((dir) => join(dir, `${session}.jsonl`))
    .find(existsSync);
}

export function readHistoryEntries(path: string): HistoryEntry[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    try {
      if (line.trim()) entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // Ignore malformed lines and preserve the remaining history.
    }
  }
  return entries;
}

function formatContent(content: unknown, maxChars: number): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((item) =>
        typeof item === 'string'
          ? item
          : item && typeof item === 'object'
            ? ((item as { text?: string }).text ?? JSON.stringify(item))
            : String(item)
      )
      .join(' ');
  } else if (content && typeof content === 'object') {
    text = (content as { result?: string }).result ?? JSON.stringify(content);
  } else text = String(content ?? '');
  text = text.replace(/\r?\n/g, ' ');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function formatHistory(
  entries: HistoryEntry[],
  heading: string,
  count: number,
  maxChars: number
): string {
  const lines = [heading];
  for (const entry of entries.slice(-count)) {
    lines.push(
      `[${entry.createdAt ?? ''}] [${entry.role ?? '?'}] ${formatContent(entry.content, maxChars)}`
    );
  }
  return lines.join('\n');
}
