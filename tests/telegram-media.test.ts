import { describe, expect, it, vi } from 'vitest';
import {
  TelegramMediaError,
  TelegramMediaGroupBuffer,
  classifyTelegramOutboundMedia,
  downloadTelegramMedia,
  extractTelegramMedia,
  isAllowedTelegramMediaMime,
  safeStoredName,
  sendTelegramAttachments,
  validateKnownTelegramMediaSignature,
} from '../src/telegram-media.js';

describe('Telegram inbound media', () => {
  it('preserves the underlying download error for diagnostics', () => {
    const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const error = new TelegramMediaError(
      'Telegram media download failed due to a network or filesystem error',
      'Telegramからファイルをダウンロードできませんでした。',
      { cause }
    );

    expect(error.cause).toBe(cause);
  });

  it('selects the largest photo variant', () => {
    expect(
      extractTelegramMedia({
        photo: [
          {
            file_id: 'small',
            file_unique_id: 'small-u',
            width: 320,
            height: 240,
            file_size: 100,
          },
          {
            file_id: 'large',
            file_unique_id: 'large-u',
            width: 1280,
            height: 960,
            file_size: 1000,
          },
        ],
      })
    ).toEqual([
      {
        fileId: 'large',
        fileUniqueId: 'large-u',
        kind: 'photo',
        mimeType: 'image/jpeg',
        fileSize: 1000,
      },
    ]);
  });

  it('extracts videos and MIME-typed documents', () => {
    expect(
      extractTelegramMedia({
        video: {
          file_id: 'video',
          file_unique_id: 'video-u',
          mime_type: 'video/mp4',
          file_name: 'clip.mp4',
        },
      })[0]
    ).toMatchObject({ kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4' });

    expect(
      extractTelegramMedia({
        document: {
          file_id: 'document',
          file_unique_id: 'document-u',
          mime_type: 'image/png',
          file_name: 'diagram.png',
        },
      })[0]
    ).toMatchObject({ kind: 'document', mimeType: 'image/png', fileName: 'diagram.png' });
  });

  it('supports exact and wildcard MIME allowlists', () => {
    expect(isAllowedTelegramMediaMime('image/jpeg', ['image/*'])).toBe(true);
    expect(isAllowedTelegramMediaMime('video/mp4; charset=binary', ['video/mp4'])).toBe(true);
    expect(isAllowedTelegramMediaMime('application/pdf', ['image/*', 'video/mp4'])).toBe(false);
  });

  it('validates signatures for known binary MIME types', () => {
    expect(
      validateKnownTelegramMediaSignature(
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe(true);
    expect(
      validateKnownTelegramMediaSignature(
        'image/webp',
        Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary')
      )
    ).toBe(true);
    expect(validateKnownTelegramMediaSignature('video/mp4', Buffer.from('0000ftyp'))).toBe(true);
    expect(validateKnownTelegramMediaSignature('application/pdf', Buffer.from('%PDF-1.7'))).toBe(
      true
    );
    expect(
      validateKnownTelegramMediaSignature('application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    ).toBe(true);
  });

  it('rejects mismatched known signatures and leaves custom MIME types unverified', () => {
    expect(validateKnownTelegramMediaSignature('image/jpeg', Buffer.from('not-a-jpeg'))).toBe(
      false
    );
    expect(
      validateKnownTelegramMediaSignature('application/json', Buffer.from('{"ok":true}'))
    ).toBe(undefined);
    expect(
      validateKnownTelegramMediaSignature(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        Buffer.from([0x50, 0x4b, 0x03, 0x04])
      )
    ).toBeUndefined();
  });

  it('preserves safe document extensions for custom allowed MIME types', () => {
    const pdfName = safeStoredName({
      fileId: 'pdf',
      fileUniqueId: 'pdf-u',
      kind: 'document',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
    });
    const sheetName = safeStoredName({
      fileId: 'sheet',
      fileUniqueId: 'sheet-u',
      kind: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'budget.XLSX',
    });

    expect(pdfName).toMatch(/_report\.pdf$/);
    expect(sheetName).toMatch(/_budget\.xlsx$/);
  });

  it('prefers the MIME-derived extension over a mismatched source extension', () => {
    expect(
      safeStoredName({
        fileId: 'image',
        fileUniqueId: 'image-u',
        kind: 'document',
        mimeType: 'image/png',
        fileName: 'misleading.pdf',
      })
    ).toMatch(/_misleading\.png$/);
  });

  it('rejects metadata over the limit before requesting Telegram file data', async () => {
    const getFile = vi.fn(async () => ({ file_path: 'unused' }));
    await expect(
      downloadTelegramMedia(
        {
          fileId: 'large',
          fileUniqueId: 'large-u',
          kind: 'video',
          mimeType: 'video/mp4',
          fileSize: 21 * 1024 * 1024,
        },
        {
          botToken: 'secret',
          getFile,
          maxBytes: 20 * 1024 * 1024,
          allowedMimeTypes: ['video/mp4'],
        }
      )
    ).rejects.toBeInstanceOf(TelegramMediaError);
    expect(getFile).not.toHaveBeenCalled();
  });

  it('rejects a disallowed MIME type before download', async () => {
    const getFile = vi.fn(async () => ({ file_path: 'unused' }));
    await expect(
      downloadTelegramMedia(
        {
          fileId: 'pdf',
          fileUniqueId: 'pdf-u',
          kind: 'document',
          mimeType: 'application/pdf',
        },
        {
          botToken: 'secret',
          getFile,
          maxBytes: 20 * 1024 * 1024,
          allowedMimeTypes: ['image/*'],
        }
      )
    ).rejects.toMatchObject({ userMessage: expect.stringContaining('対応していません') });
    expect(getFile).not.toHaveBeenCalled();
  });
});

describe('Telegram media albums', () => {
  it('debounces album items into one flush', async () => {
    vi.useFakeTimers();
    try {
      const buffer = new TelegramMediaGroupBuffer<number>(750);

      const first = buffer.add('chat:album', 1);
      await vi.advanceTimersByTimeAsync(500);
      const second = buffer.add('chat:album', 2);
      await vi.advanceTimersByTimeAsync(749);
      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(second.ready).toBe(first.ready);
      await vi.advanceTimersByTimeAsync(1);

      await expect(first.ready).resolves.toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains pending albums without starting their normal flush callbacks', async () => {
    vi.useFakeTimers();
    try {
      const buffer = new TelegramMediaGroupBuffer<number>(750);
      const first = buffer.add('chat:album-1', 1);
      buffer.add('chat:album-1', 2);
      const second = buffer.add('chat:album-2', 3);

      expect(buffer.size).toBe(2);
      expect(buffer.drainAll()).toEqual([[1, 2], [3]]);
      expect(buffer.size).toBe(0);
      await expect(first.ready).resolves.toBeUndefined();
      await expect(second.ready).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels one pending album without flushing it later', async () => {
    vi.useFakeTimers();
    try {
      const buffer = new TelegramMediaGroupBuffer<number>(750);
      const admission = buffer.add('chat:album', 1);
      buffer.add('chat:album', 2);

      expect(buffer.cancel('chat:album')).toEqual([1, 2]);
      expect(buffer.size).toBe(0);
      await expect(admission.ready).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await expect(admission.ready).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Telegram outbound media', () => {
  it('maps common image and MP4 extensions to native Telegram methods', () => {
    expect(classifyTelegramOutboundMedia('/tmp/result.PNG')).toBe('photo');
    expect(classifyTelegramOutboundMedia('/tmp/result.mp4')).toBe('video');
    expect(classifyTelegramOutboundMedia('/tmp/report.pdf')).toBe('document');
  });

  it('does not retry a failed upload and continues with later attachments', async () => {
    const timeout = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    const api = {
      sendPhoto: vi.fn(async () => {
        throw timeout;
      }),
      sendVideo: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
    };

    const result = await sendTelegramAttachments(api as never, 'chat', [
      '/tmp/first.png',
      '/tmp/second.mp4',
    ]);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendVideo).toHaveBeenCalledTimes(1);
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(result.sent).toEqual(['/tmp/second.mp4']);
    expect(result.failures).toEqual([{ index: 0, filePath: '/tmp/first.png', error: timeout }]);
  });
});
