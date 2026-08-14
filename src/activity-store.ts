import type { Platform } from './events-emitter.js';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'fs';
import { join } from 'path';
import { withoutFinalResponse } from './tool-history.js';

export type ActivityState =
  'thinking' | 'streaming' | 'tool' | 'complete' | 'aborted' | 'error' | 'stale';

export interface ActivitySnapshot {
  state: ActivityState;
  summary: string;
  userTextPreview?: string;
  textPreview?: string;
  toolLines: string[];
  history: ActivityHistoryEvent[];
  turnId: string;
  threadId: string;
  threadLabel?: string;
  platform?: Platform;
  startedAt: number;
  updatedAt: number;
  elapsedSec: number;
  active: boolean;
}

export interface ActivityHistoryEvent {
  state: ActivityState;
  summary: string;
  at: number;
}

export interface ToolHistoryEntry {
  at: number;
  turnId: string;
  toolName: string;
  summary: string;
  inputPreview?: string;
}

export type TurnHistoryEntry =
  | {
      kind: 'text';
      at: number;
      turnId: string;
      text: string;
    }
  | {
      kind: 'tool';
      at: number;
      turnId: string;
      toolName: string;
      summary: string;
      inputPreview?: string;
    };

interface ActivityRecord {
  state: ActivityState;
  summary: string;
  userTextPreview?: string;
  textPreview?: string;
  toolLines: string[];
  history: ActivityHistoryEvent[];
  turnId: string;
  threadId: string;
  threadLabel?: string;
  platform?: Platform;
  startedAt: number;
  updatedAt: number;
  active: boolean;
  turnHistory: TurnHistoryEntry[];
  pendingText?: { at: number; text: string };
  lastFullText?: string;
}

export interface ActivityContext {
  threadId: string;
  turnId: string;
  threadLabel?: string;
  platform?: Platform;
  userText?: string;
}

const activeTtlMs = 60 * 60 * 1000;
const terminalTtlMs = 60 * 1000;
const maxPreviewChars = 120;
const maxHistoryChars = 420;
const maxToolInputChars = 2000;
const maxUserChars = 80;
const maxToolLines = 3;
const maxHistoryEvents = 12;
const monitorActivityDir = 'logs/monitor-activity';
const maxToolHistoryReadBytes = 1024 * 1024;

const activities = new Map<string, ActivityRecord>();
const activityListeners = new Set<(threadId: string) => void>();

function notifyActivity(threadId: string): void {
  for (const listener of activityListeners) {
    try {
      listener(threadId);
    } catch {
      // An observer must not interrupt the activity lifecycle.
    }
  }
}

export function subscribeActivity(listener: (threadId: string) => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

function now(): number {
  return Date.now();
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function maskSensitive(text: string): string {
  return text
    .replace(
      /(token|api[_-]?key|authorization|password|secret)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
      '$1=***'
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***');
}

function summarizeTool(toolName: string, toolInput: Record<string, unknown>): string {
  const candidates = [
    toolInput.command,
    toolInput.cmd,
    toolInput.file_path,
    toolInput.path,
    toolInput.pattern,
    toolInput.q,
    toolInput.url,
    toolInput.message,
  ];
  const detail = candidates.find((v) => typeof v === 'string' && v.trim().length > 0);
  if (typeof detail === 'string') {
    return truncate(`${toolName}: ${maskSensitive(detail)}`, maxPreviewChars);
  }

  const raw = Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : '';
  return truncate(raw ? `${toolName}: ${maskSensitive(raw)}` : toolName, maxPreviewChars);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'unknown';
}

export function readToolHistory(threadId: string, requestedLimit = 100): ToolHistoryEntry[] {
  const limit = Math.min(200, Math.max(1, Math.floor(requestedLimit) || 100));
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const file = join(workdir, monitorActivityDir, `${safeFilePart(threadId)}.jsonl`);
  if (!existsSync(file)) return [];

  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const bytesToRead = Math.min(size, maxToolHistoryReadBytes);
    const offset = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const result: ToolHistoryEntry[] = [];
    const lines = text.trimEnd().split('\n');
    for (let index = lines.length - 1; index >= 0 && result.length < limit; index -= 1) {
      try {
        const event = JSON.parse(lines[index]) as {
          ts?: string;
          state?: string;
          turnId?: string;
          toolName?: string;
          summary?: string;
          toolInputPreview?: string;
        };
        if (event.state !== 'tool' || !event.turnId || !event.toolName || !event.ts) continue;
        const at = Date.parse(event.ts);
        if (!Number.isFinite(at)) continue;
        result.push({
          at,
          turnId: event.turnId,
          toolName: event.toolName,
          summary: event.summary || event.toolName,
          inputPreview: event.toolInputPreview,
        });
      } catch {
        // A partially written or old malformed line must not hide the remaining history.
      }
    }
    return result.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readTurnHistory(threadId: string, requestedLimit = 100): TurnHistoryEntry[] {
  const limit = Math.min(200, Math.max(1, Math.floor(requestedLimit) || 100));
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const file = join(workdir, monitorActivityDir, `${safeFilePart(threadId)}.jsonl`);
  if (!existsSync(file)) return [];

  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const bytesToRead = Math.min(size, maxToolHistoryReadBytes);
    const offset = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const result: TurnHistoryEntry[] = [];
    const snapshottedTurns = new Set<string>();
    const legacyCompletedTurns = new Set<string>();
    const lines = text.trimEnd().split('\n');
    for (let index = lines.length - 1; index >= 0 && result.length < limit; index -= 1) {
      try {
        const event = JSON.parse(lines[index]) as {
          ts?: string;
          state?: string;
          turnId?: string;
          text?: string;
          toolName?: string;
          summary?: string;
          toolInputPreview?: string;
          turnHistory?: TurnHistoryEntry[];
        };
        if (!event.ts || !event.turnId) continue;
        const at = Date.parse(event.ts);
        if (!Number.isFinite(at)) continue;
        if (event.state === 'complete') {
          if (Array.isArray(event.turnHistory)) {
            snapshottedTurns.add(event.turnId);
            for (
              let historyIndex = event.turnHistory.length - 1;
              historyIndex >= 0 && result.length < limit;
              historyIndex -= 1
            ) {
              const entry = event.turnHistory[historyIndex];
              if (
                entry?.turnId === event.turnId &&
                (entry.kind === 'text' || entry.kind === 'tool')
              ) {
                result.push(entry);
              }
            }
          } else {
            // Logs written before completed snapshots cannot distinguish final
            // response fragments from genuine commentary. Keep their tools, but
            // do not expose raw streamed text after a process restart.
            legacyCompletedTurns.add(event.turnId);
          }
          continue;
        }
        if (snapshottedTurns.has(event.turnId)) continue;
        if (event.state === 'streaming' && event.text) {
          if (legacyCompletedTurns.has(event.turnId)) continue;
          result.push({ kind: 'text', at, turnId: event.turnId, text: event.text });
        } else if (event.state === 'tool' && event.toolName) {
          result.push({
            kind: 'tool',
            at,
            turnId: event.turnId,
            toolName: event.toolName,
            summary: event.summary || event.toolName,
            inputPreview: event.toolInputPreview,
          });
        }
      } catch {
        // Ignore a partially written line and keep scanning older history.
      }
    }
    return result.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function appendActivityLog(
  record: ActivityRecord,
  state: ActivityState,
  summary: string,
  at: number,
  details: {
    text?: string;
    toolName?: string;
    toolInputPreview?: string;
    turnHistory?: TurnHistoryEntry[];
  } = {}
): void {
  try {
    const workdir = process.env.WORKSPACE_PATH || process.cwd();
    const dir = join(workdir, monitorActivityDir);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${safeFilePart(record.threadId)}.jsonl`),
      JSON.stringify({
        ts: new Date(at).toISOString(),
        state,
        summary,
        threadId: record.threadId,
        turnId: record.turnId,
        threadLabel: record.threadLabel,
        platform: record.platform,
        active: record.active,
        ...details,
      }) + '\n'
    );
  } catch (err) {
    console.warn(
      `[monitor-activity] Failed to write activity event: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function flushPendingText(record: ActivityRecord): void {
  const pending = record.pendingText;
  if (!pending?.text.trim()) {
    record.pendingText = undefined;
    return;
  }
  const text = maskSensitive(pending.text);
  const entry: TurnHistoryEntry = {
    kind: 'text',
    at: pending.at,
    turnId: record.turnId,
    text,
  };
  record.turnHistory.push(entry);
  appendActivityLog(record, 'streaming', '途中コメント', pending.at, { text });
  record.pendingText = undefined;
}

function pushHistory(
  record: ActivityRecord,
  state: ActivityState,
  summary: string,
  at: number,
  options: {
    coalesceSameState?: boolean;
    persist?: boolean;
    toolName?: string;
    toolInputPreview?: string;
    turnHistory?: TurnHistoryEntry[];
  } = {}
): void {
  const last = record.history.at(-1);
  if (options.coalesceSameState && last && last.state === state) {
    last.summary = summary;
    last.at = at;
    return;
  }
  if (last && last.state === state && last.summary === summary) return;
  record.history = [...record.history, { state, summary, at }].slice(-maxHistoryEvents);
  if (options.persist !== false) {
    appendActivityLog(record, state, summary, at, {
      toolName: options.toolName,
      toolInputPreview: options.toolInputPreview,
      turnHistory: options.turnHistory,
    });
  }
}

function getExisting(ctx: ActivityContext): ActivityRecord {
  const t = now();
  const existing = activities.get(ctx.threadId);
  if (existing && existing.turnId === ctx.turnId) return existing;
  const summary = ctx.userText ? `考え中: ${truncate(ctx.userText, maxUserChars)}` : '考え中';
  const record: ActivityRecord = {
    state: 'thinking',
    summary,
    userTextPreview: ctx.userText ? truncate(ctx.userText, maxUserChars) : undefined,
    toolLines: [],
    history: [{ state: 'thinking', summary, at: t }],
    turnId: ctx.turnId,
    threadId: ctx.threadId,
    threadLabel: ctx.threadLabel,
    platform: ctx.platform,
    startedAt: t,
    updatedAt: t,
    active: true,
    turnHistory: [],
  };
  activities.set(ctx.threadId, record);
  appendActivityLog(record, record.state, record.summary, t);
  return record;
}

export function startActivity(ctx: ActivityContext): void {
  const t = now();
  const summary = ctx.userText ? `考え中: ${truncate(ctx.userText, maxUserChars)}` : '考え中';
  activities.set(ctx.threadId, {
    state: 'thinking',
    summary,
    userTextPreview: ctx.userText ? truncate(ctx.userText, maxUserChars) : undefined,
    toolLines: [],
    history: [{ state: 'thinking', summary, at: t }],
    turnId: ctx.turnId,
    threadId: ctx.threadId,
    threadLabel: ctx.threadLabel,
    platform: ctx.platform,
    startedAt: t,
    updatedAt: t,
    active: true,
    turnHistory: [],
  });
  const record = activities.get(ctx.threadId);
  if (record) appendActivityLog(record, record.state, record.summary, t);
  notifyActivity(ctx.threadId);
}

export function updateActivityText(ctx: ActivityContext, fullText: string, chunk = fullText): void {
  const record = getExisting(ctx);
  const preview = truncate(fullText, maxPreviewChars);
  const t = now();
  record.state = 'streaming';
  record.summary = preview ? `応答中: ${preview}` : '応答中';
  record.textPreview = preview;
  record.updatedAt = t;
  record.active = true;
  if (record.lastFullText && !fullText.startsWith(record.lastFullText)) {
    flushPendingText(record);
  }
  if (chunk) {
    if (!record.pendingText) record.pendingText = { at: t, text: '' };
    record.pendingText.text += chunk;
  }
  record.lastFullText = fullText;
  pushHistory(
    record,
    record.state,
    fullText ? `応答中: ${truncate(fullText, maxHistoryChars)}` : '応答中',
    t,
    { coalesceSameState: true, persist: false }
  );
  notifyActivity(ctx.threadId);
}

export function updateActivityTool(
  ctx: ActivityContext,
  toolName: string,
  toolInput: Record<string, unknown>
): void {
  const record = getExisting(ctx);
  flushPendingText(record);
  const line = summarizeTool(toolName, toolInput);
  const t = now();
  const inputPreview = truncate(maskSensitive(JSON.stringify(toolInput)), maxToolInputChars);
  record.state = 'tool';
  record.summary = `実行中: ${line}`;
  record.toolLines = [...record.toolLines.filter((x) => x !== line), line].slice(-maxToolLines);
  record.updatedAt = t;
  record.active = true;
  pushHistory(record, record.state, record.summary, t, {
    toolName,
    toolInputPreview: inputPreview,
  });
  record.turnHistory.push({
    kind: 'tool',
    at: t,
    turnId: record.turnId,
    toolName,
    summary: record.summary,
    inputPreview,
  });
  notifyActivity(ctx.threadId);
}

export function completeActivity(ctx: ActivityContext, resultText?: string): void {
  const record = getExisting(ctx);
  const pendingText = record.pendingText?.text.trim();
  if (pendingText && resultText?.trim().endsWith(pendingText)) {
    // The final streamed segment is already preserved as the assistant reply.
    // History keeps only the transient commentary that would otherwise disappear.
    record.pendingText = undefined;
  } else {
    flushPendingText(record);
  }
  const completedTurnHistory = withoutFinalResponse(record.turnHistory, resultText ?? '');
  const preview = resultText ? truncate(resultText, maxPreviewChars) : '';
  const historyPreview = resultText ? truncate(resultText, maxHistoryChars) : '';
  const t = now();
  record.state = 'complete';
  record.summary = preview ? `完了: ${preview}` : '完了';
  record.textPreview = preview || record.textPreview;
  record.updatedAt = t;
  record.active = false;
  pushHistory(record, record.state, historyPreview ? `完了: ${historyPreview}` : '完了', t, {
    turnHistory: completedTurnHistory.map((entry) => ({ ...entry })),
  });
  notifyActivity(ctx.threadId);
}

export function abortActivity(ctx: ActivityContext): void {
  const record = getExisting(ctx);
  flushPendingText(record);
  const t = now();
  record.state = 'aborted';
  record.summary = '中断';
  record.updatedAt = t;
  record.active = false;
  pushHistory(record, record.state, record.summary, t);
  notifyActivity(ctx.threadId);
}

export function errorActivity(ctx: ActivityContext, message: string): void {
  const record = getExisting(ctx);
  flushPendingText(record);
  const t = now();
  record.state = 'error';
  record.summary = `エラー: ${truncate(maskSensitive(message), maxPreviewChars)}`;
  record.updatedAt = t;
  record.active = false;
  pushHistory(record, record.state, record.summary, t);
  notifyActivity(ctx.threadId);
}

export function getTurnHistory(threadId: string, turnId?: string): TurnHistoryEntry[] {
  const record = activities.get(threadId);
  if (!record || (turnId && record.turnId !== turnId)) return [];
  flushPendingText(record);
  return record.turnHistory.map((entry) => ({ ...entry }));
}

export function getActivity(threadId: string, at: number = now()): ActivitySnapshot | undefined {
  const record = activities.get(threadId);
  if (!record) return undefined;

  if (!record.active && at - record.updatedAt > terminalTtlMs) {
    activities.delete(threadId);
    return undefined;
  }

  const stale = record.active && at - record.updatedAt > activeTtlMs;
  const state: ActivityState = stale ? 'stale' : record.state;
  return {
    state,
    summary: stale ? '状態更新なし' : record.summary,
    userTextPreview: record.userTextPreview,
    textPreview: record.textPreview,
    toolLines: [...record.toolLines],
    history: [...record.history],
    turnId: record.turnId,
    threadId: record.threadId,
    threadLabel: record.threadLabel,
    platform: record.platform,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    elapsedSec: Math.max(0, Math.floor((at - record.startedAt) / 1000)),
    active: !stale && record.active,
  };
}

export function clearActivities(): void {
  activities.clear();
}
