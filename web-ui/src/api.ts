import type { ChatSseDataMap, ChatSseEvent, ParsedSsePackets, Platform, SsePacket } from './types';

export const AUTOTALK_SENTINEL = '[__XANGI_AUTOTALK_INTERNAL__]';
const READ_RETRY_DELAYS_MS = [200, 800];

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, fallbackMessage?: string) {
    super(errorMessage(body, fallbackMessage || `HTTP ${status}`));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function errorMessage(body: string, fallback: string): string {
  if (!body.trim()) return fallback;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
  } catch {
    // The response is plain text.
  }
  return body;
}

export async function request(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  const retryable = method === 'GET' || method === 'HEAD';
  let attempt = 0;

  while (true) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      const body = await response.text();
      throw new ApiError(response.status, body, response.statusText);
    } catch (cause) {
      if (
        cause instanceof ApiError ||
        !retryable ||
        init?.signal?.aborted ||
        attempt >= READ_RETRY_DELAYS_MS.length
      ) {
        throw cause;
      }
      await waitForRetry(READ_RETRY_DELAYS_MS[attempt], init?.signal);
      attempt += 1;
    }
  }
}

function waitForRetry(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason || new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init);
  return response.json() as Promise<T>;
}

export async function requestJson<T>(
  url: string,
  init: RequestInit & { body?: BodyInit | null } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return getJson<T>(url, { ...init, headers });
}

export function workspaceFileUrl(path: string): string {
  return `/api/workspace-file?path=${encodeURIComponent(path)}`;
}

export function relativeTime(value: string | number | Date, now = Date.now()): string {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return '今';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

export function formatDateTime(value?: string | number | Date): string {
  if (value === undefined || value === null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes}`;
}

export function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function dateGroupLabel(date: string, now = new Date()): string {
  const today = localDateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === today) return 'Today';
  if (date === localDateKey(yesterday)) return 'Yesterday';
  return date;
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
  ].join('-');
}

export function platformLabel(platform?: Platform): string {
  if (platform === 'web') return 'Web';
  if (platform === 'discord') return 'Discord';
  if (platform === 'slack') return 'Slack';
  if (platform === 'line') return 'LINE';
  if (platform === 'telegram') return 'Telegram';
  return platform || 'Log';
}

export function stripMetadata(text: string): string {
  return text
    .replace(/^\[プラットフォーム: [^\]]*\]\n?/gm, '')
    .replace(/^\[チャンネル: [^\]]*\]\n?/gm, '')
    .replace(/^\[発言者: [^\]]*\]\n?/gm, '')
    .replace(/^\[現在時刻: [^\]]*\]\n?/gm, '')
    .replace(/^\[チャンネルID: [^\]]*\]\n?/gm, '')
    .trim();
}

export function isAutoTalkInternalMessage(message: { role: string; content: unknown }): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(AUTOTALK_SENTINEL)
  );
}

export function isVisibleTranscriptMessage(message: { role: string; content: unknown }): boolean {
  return !isAutoTalkInternalMessage(message);
}

export function splitThreadId(threadId: string): { platform: string; contextKey: string } {
  const separator = threadId.indexOf(':');
  if (separator < 0) return { platform: '', contextKey: threadId };
  return {
    platform: threadId.slice(0, separator),
    contextKey: threadId.slice(separator + 1),
  };
}

export function parseSsePackets(buffer: string): ParsedSsePackets {
  const frames: string[] = [];
  const boundary = /\r\n\r\n|\n\n|\r\r/g;
  let frameStart = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(buffer))) {
    frames.push(buffer.slice(frameStart, match.index));
    frameStart = match.index + match[0].length;
  }
  const remainder = buffer.slice(frameStart);
  const packets = frames.flatMap((frame) => {
    const packet = parseSseFrame(frame);
    return packet ? [packet] : [];
  });
  return { packets, remainder };
}

function parseSseFrame(frame: string): SsePacket | null {
  let event = 'message';
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];

  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else if (field === 'retry') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id, retry };
}

export function parseChatSsePacket(packet: SsePacket): ChatSseEvent | null {
  if (!isChatSseType(packet.event)) return null;
  const data = JSON.parse(packet.data) as ChatSseDataMap[typeof packet.event];
  return { type: packet.event, data } as ChatSseEvent;
}

function isChatSseType(value: string): value is keyof ChatSseDataMap {
  return (
    value === 'text' ||
    value === 'tool' ||
    value === 'done' ||
    value === 'timeout' ||
    value === 'timeout_cleared' ||
    value === 'error'
  );
}
