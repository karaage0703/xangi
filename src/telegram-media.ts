import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InputFile, type Api } from 'grammy';
import { getAttachmentDownloadDir } from './file-utils.js';

export const TELEGRAM_FILE_API_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TELEGRAM_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
] as const;

type TelegramFileDescriptor = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
};

export interface TelegramMediaMessage {
  photo?: Array<TelegramFileDescriptor & { width: number; height: number }>;
  video?: TelegramFileDescriptor & {
    mime_type?: string;
    file_name?: string;
  };
  document?: TelegramFileDescriptor & {
    mime_type?: string;
    file_name?: string;
  };
}

export interface TelegramMediaCandidate {
  fileId: string;
  fileUniqueId: string;
  kind: 'photo' | 'video' | 'document';
  mimeType: string;
  fileName?: string;
  fileSize?: number;
}

export interface TelegramRemoteFile {
  file_path?: string;
  file_size?: number;
}

export class TelegramMediaError extends Error {
  constructor(
    message: string,
    readonly userMessage: string
  ) {
    super(message);
    this.name = 'TelegramMediaError';
  }
}

export function extractTelegramMedia(message: TelegramMediaMessage): TelegramMediaCandidate[] {
  if (message.photo?.length) {
    const photo = [...message.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return [
      {
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        kind: 'photo',
        mimeType: 'image/jpeg',
        fileSize: photo.file_size,
      },
    ];
  }

  if (message.video) {
    return [
      {
        fileId: message.video.file_id,
        fileUniqueId: message.video.file_unique_id,
        kind: 'video',
        mimeType: message.video.mime_type || 'video/mp4',
        fileName: message.video.file_name,
        fileSize: message.video.file_size,
      },
    ];
  }

  if (message.document) {
    return [
      {
        fileId: message.document.file_id,
        fileUniqueId: message.document.file_unique_id,
        kind: 'document',
        mimeType: message.document.mime_type || 'application/octet-stream',
        fileName: message.document.file_name,
        fileSize: message.document.file_size,
      },
    ];
  }

  return [];
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0].trim().toLowerCase();
}

const TELEGRAM_MEDIA_SIGNATURE_BYTES = 16;

function startsWithBytes(data: Uint8Array, signature: readonly number[]): boolean {
  return (
    data.length >= signature.length && signature.every((value, index) => data[index] === value)
  );
}

/** Returns undefined when the MIME type has no reliable binary signature check. */
export function validateKnownTelegramMediaSignature(
  mimeType: string,
  data: Uint8Array
): boolean | undefined {
  switch (normalizeMimeType(mimeType)) {
    case 'image/jpeg':
      return startsWithBytes(data, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return (
        startsWithBytes(data, [0x52, 0x49, 0x46, 0x46]) &&
        data.length >= 12 &&
        startsWithBytes(data.subarray(8), [0x57, 0x45, 0x42, 0x50])
      );
    case 'video/mp4':
      return data.length >= 8 && startsWithBytes(data.subarray(4), [0x66, 0x74, 0x79, 0x70]);
    case 'application/pdf':
      return startsWithBytes(data, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'application/zip':
      return (
        startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWithBytes(data, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWithBytes(data, [0x50, 0x4b, 0x07, 0x08])
      );
    default:
      return undefined;
  }
}

export function isAllowedTelegramMediaMime(
  mimeType: string,
  allowedMimeTypes: readonly string[]
): boolean {
  const normalized = normalizeMimeType(mimeType);
  return allowedMimeTypes.some((allowed) => {
    const pattern = normalizeMimeType(allowed);
    return pattern.endsWith('/*')
      ? normalized.startsWith(pattern.slice(0, -1))
      : normalized === pattern;
  });
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/zip': '.zip',
  'text/csv': '.csv',
  'text/plain': '.txt',
};

const SAFE_SOURCE_EXTENSION = /^\.[a-z0-9]{1,16}$/i;

export function safeStoredName(candidate: TelegramMediaCandidate): string {
  const mimeType = normalizeMimeType(candidate.mimeType);
  const sourceExtension = candidate.fileName ? path.extname(candidate.fileName).toLowerCase() : '';
  const extension =
    MIME_EXTENSIONS[mimeType] ||
    (SAFE_SOURCE_EXTENSION.test(sourceExtension) ? sourceExtension : '.bin');
  const sourceBase = candidate.fileName
    ? path.basename(candidate.fileName, path.extname(candidate.fileName))
    : candidate.fileUniqueId;
  const base = sourceBase.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'telegram-media';
  return `${Date.now()}_${randomUUID()}_${base}${extension}`;
}

function requestTelegramFile(url: string, forceIpv4: boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = forceIpv4 ? httpsGet(url, { family: 4 }, resolve) : httpsGet(url, resolve);
    request.setTimeout(60_000, () => {
      const error = Object.assign(new Error('Telegram file download timed out'), {
        code: 'ETIMEDOUT',
      });
      request.destroy(error);
    });
    request.once('error', reject);
  });
}

export async function downloadTelegramMedia(
  candidate: TelegramMediaCandidate,
  options: {
    botToken: string;
    getFile: (fileId: string) => Promise<TelegramRemoteFile>;
    maxBytes: number;
    allowedMimeTypes: readonly string[];
    forceIpv4?: boolean;
  }
): Promise<string> {
  const maxBytes = Math.min(options.maxBytes, TELEGRAM_FILE_API_MAX_BYTES);
  if (!isAllowedTelegramMediaMime(candidate.mimeType, options.allowedMimeTypes)) {
    throw new TelegramMediaError(
      `Telegram media MIME type is not allowed: ${candidate.mimeType}`,
      `このファイル形式（${candidate.mimeType}）には対応していません。`
    );
  }
  if (candidate.fileSize !== undefined && candidate.fileSize > maxBytes) {
    throw new TelegramMediaError(
      `Telegram media exceeds configured limit: ${candidate.fileSize} > ${maxBytes}`,
      `ファイルサイズが上限（${Math.floor(maxBytes / 1024 / 1024)}MB）を超えています。`
    );
  }

  const remote = await options.getFile(candidate.fileId);
  if (!remote.file_path) {
    throw new TelegramMediaError(
      'Telegram getFile response did not contain file_path',
      'Telegramからファイル情報を取得できませんでした。'
    );
  }
  if (remote.file_size !== undefined && remote.file_size > maxBytes) {
    throw new TelegramMediaError(
      `Telegram remote file exceeds configured limit: ${remote.file_size} > ${maxBytes}`,
      `ファイルサイズが上限（${Math.floor(maxBytes / 1024 / 1024)}MB）を超えています。`
    );
  }

  const targetDir = path.join(getAttachmentDownloadDir(), 'telegram');
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, safeStoredName(candidate));
  const temporaryPath = `${targetPath}.part`;
  const encodedPath = remote.file_path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `https://api.telegram.org/file/bot${options.botToken}/${encodedPath}`;

  try {
    const response = await requestTelegramFile(url, options.forceIpv4 === true);
    if (response.statusCode !== 200) {
      response.resume();
      throw new TelegramMediaError(
        `Telegram file download failed with status ${response.statusCode ?? 'unknown'}`,
        'Telegramからファイルをダウンロードできませんでした。'
      );
    }

    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      response.destroy();
      throw new TelegramMediaError(
        `Telegram file Content-Length exceeds configured limit: ${contentLength} > ${maxBytes}`,
        `ファイルサイズが上限（${Math.floor(maxBytes / 1024 / 1024)}MB）を超えています。`
      );
    }

    let received = 0;
    const signatureChunks: Buffer[] = [];
    let signatureBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(
            new TelegramMediaError(
              `Telegram file stream exceeds configured limit: ${received} > ${maxBytes}`,
              `ファイルサイズが上限（${Math.floor(maxBytes / 1024 / 1024)}MB）を超えています。`
            )
          );
          return;
        }
        if (signatureBytes < TELEGRAM_MEDIA_SIGNATURE_BYTES) {
          const remaining = TELEGRAM_MEDIA_SIGNATURE_BYTES - signatureBytes;
          const prefix = chunk.subarray(0, remaining);
          signatureChunks.push(Buffer.from(prefix));
          signatureBytes += prefix.length;
        }
        callback(null, chunk);
      },
    });

    await pipeline(response, limiter, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
    const signatureMatches = validateKnownTelegramMediaSignature(
      candidate.mimeType,
      Buffer.concat(signatureChunks)
    );
    if (signatureMatches === false) {
      throw new TelegramMediaError(
        `Telegram media content does not match declared MIME type: ${candidate.mimeType}`,
        'ファイルの内容が申告された形式と一致しないため、受信を拒否しました。'
      );
    }
    fs.renameSync(temporaryPath, targetPath);
    return targetPath;
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (error instanceof TelegramMediaError) throw error;
    throw new TelegramMediaError(
      'Telegram media download failed due to a network or filesystem error',
      'Telegramからファイルをダウンロードできませんでした。'
    );
  }
}

export function cleanupTelegramMedia(retentionHours: number, now = Date.now()): number {
  const targetDir = path.join(getAttachmentDownloadDir(), 'telegram');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const cutoff = now - retentionHours * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(targetDir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.rmSync(filePath, { force: true });
        removed++;
      }
    } catch {
      // Another cleanup or process may have removed the file already.
    }
  }
  return removed;
}

export function discardTelegramMediaFiles(filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Retention cleanup will make another best-effort attempt later.
    }
  }
}

export type TelegramOutboundMediaKind = 'photo' | 'video' | 'document';

export interface TelegramAttachmentSendFailure {
  index: number;
  filePath: string;
  error: unknown;
}

export interface TelegramAttachmentSendResult {
  sent: string[];
  failures: TelegramAttachmentSendFailure[];
}

export function classifyTelegramOutboundMedia(filePath: string): TelegramOutboundMediaKind {
  const extension = path.extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return 'photo';
  if (extension === '.mp4') return 'video';
  return 'document';
}

export async function sendTelegramAttachments(
  api: Pick<Api, 'sendPhoto' | 'sendVideo' | 'sendDocument'>,
  chatId: number | string,
  filePaths: readonly string[],
  messageThreadId?: number
): Promise<TelegramAttachmentSendResult> {
  const options = messageThreadId ? { message_thread_id: messageThreadId } : undefined;
  const sent: string[] = [];
  const failures: TelegramAttachmentSendFailure[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    try {
      const input = new InputFile(filePath);
      const kind = classifyTelegramOutboundMedia(filePath);
      if (kind === 'photo') {
        await api.sendPhoto(chatId, input, options);
      } else if (kind === 'video') {
        await api.sendVideo(chatId, input, options);
      } else {
        await api.sendDocument(chatId, input, options);
      }
      sent.push(filePath);
    } catch (error) {
      failures.push({ index: i, filePath, error });
    }
  }
  return { sent, failures };
}

export class TelegramMediaGroupBuffer<T> {
  private readonly groups = new Map<
    string,
    { items: T[]; timer: ReturnType<typeof setTimeout>; flush: (items: T[]) => Promise<void> }
  >();

  constructor(private readonly delayMs: number) {}

  get size(): number {
    return this.groups.size;
  }

  add(key: string, item: T, flush: (items: T[]) => Promise<void>): void {
    const current = this.groups.get(key);
    if (current) clearTimeout(current.timer);
    const items = current ? [...current.items, item] : [item];
    const timer = setTimeout(() => {
      this.groups.delete(key);
      void flush(items).catch(() => {
        // The caller owns update-specific logging; avoid an unhandled timer rejection here.
      });
    }, this.delayMs);
    timer.unref?.();
    this.groups.set(key, { items, timer, flush });
  }

  drainAll(): T[][] {
    const pending = [...this.groups.values()].map((group) => group.items);
    for (const group of this.groups.values()) clearTimeout(group.timer);
    this.groups.clear();
    return pending;
  }
}
