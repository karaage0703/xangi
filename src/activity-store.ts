import type { Platform } from './events-emitter.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

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
const maxUserChars = 80;
const maxToolLines = 3;
const maxHistoryEvents = 12;
const monitorActivityDir = 'logs/monitor-activity';

const activities = new Map<string, ActivityRecord>();

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

function appendActivityLog(
  record: ActivityRecord,
  state: ActivityState,
  summary: string,
  at: number
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

function pushHistory(
  record: ActivityRecord,
  state: ActivityState,
  summary: string,
  at: number,
  options: { coalesceSameState?: boolean; persist?: boolean } = {}
): void {
  const last = record.history.at(-1);
  if (options.coalesceSameState && last && last.state === state) {
    last.summary = summary;
    last.at = at;
    return;
  }
  if (last && last.state === state && last.summary === summary) return;
  record.history = [...record.history, { state, summary, at }].slice(-maxHistoryEvents);
  if (options.persist !== false) appendActivityLog(record, state, summary, at);
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
  });
  const record = activities.get(ctx.threadId);
  if (record) appendActivityLog(record, record.state, record.summary, t);
}

export function updateActivityText(ctx: ActivityContext, fullText: string): void {
  const record = getExisting(ctx);
  const preview = truncate(fullText, maxPreviewChars);
  const t = now();
  record.state = 'streaming';
  record.summary = preview ? `応答中: ${preview}` : '応答中';
  record.textPreview = preview;
  record.updatedAt = t;
  record.active = true;
  pushHistory(
    record,
    record.state,
    fullText ? `応答中: ${truncate(fullText, maxHistoryChars)}` : '応答中',
    t,
    { coalesceSameState: true, persist: false }
  );
}

export function updateActivityTool(
  ctx: ActivityContext,
  toolName: string,
  toolInput: Record<string, unknown>
): void {
  const record = getExisting(ctx);
  const line = summarizeTool(toolName, toolInput);
  const t = now();
  record.state = 'tool';
  record.summary = `実行中: ${line}`;
  record.toolLines = [...record.toolLines.filter((x) => x !== line), line].slice(-maxToolLines);
  record.updatedAt = t;
  record.active = true;
  pushHistory(record, record.state, record.summary, t);
}

export function completeActivity(ctx: ActivityContext, resultText?: string): void {
  const record = getExisting(ctx);
  const preview = resultText ? truncate(resultText, maxPreviewChars) : '';
  const historyPreview = resultText ? truncate(resultText, maxHistoryChars) : '';
  const t = now();
  record.state = 'complete';
  record.summary = preview ? `完了: ${preview}` : '完了';
  record.textPreview = preview || record.textPreview;
  record.updatedAt = t;
  record.active = false;
  pushHistory(record, record.state, historyPreview ? `完了: ${historyPreview}` : '完了', t);
}

export function abortActivity(ctx: ActivityContext): void {
  const record = getExisting(ctx);
  const t = now();
  record.state = 'aborted';
  record.summary = '中断';
  record.updatedAt = t;
  record.active = false;
  pushHistory(record, record.state, record.summary, t);
}

export function errorActivity(ctx: ActivityContext, message: string): void {
  const record = getExisting(ctx);
  const t = now();
  record.state = 'error';
  record.summary = `エラー: ${truncate(maskSensitive(message), maxPreviewChars)}`;
  record.updatedAt = t;
  record.active = false;
  pushHistory(record, record.state, record.summary, t);
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
