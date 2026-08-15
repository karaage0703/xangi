import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../web-ui/src/api.js';
import {
  formatUploadBytes,
  uploadErrorMessage,
  uploadForm,
  uploadTooLargeMessage,
} from '../web-ui/src/upload.js';

class FakeUploadRequest extends EventTarget {
  static status = 200;
  static responseText = '{"files":[]}';
  readonly upload = new EventTarget();
  status = FakeUploadRequest.status;
  statusText = '';
  responseText = FakeUploadRequest.responseText;
  responseType = '';
  method = '';
  url = '';

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send() {
    const progress = new Event('progress') as ProgressEvent;
    Object.defineProperties(progress, {
      lengthComputable: { value: true },
      loaded: { value: 5 },
      total: { value: 10 },
    });
    this.upload.dispatchEvent(progress);
    this.dispatchEvent(new Event('load'));
  }
}

describe('Web upload progress', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports browser upload progress and parses the response', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeUploadRequest);
    const updates: Array<{ loaded: number; total?: number }> = [];
    const result = await uploadForm<{ files: unknown[] }>(
      '/api/upload',
      new FormData(),
      (progress) => updates.push(progress)
    );

    expect(updates).toEqual([{ loaded: 5, total: 10 }]);
    expect(result).toEqual({ files: [] });
  });

  it('surfaces the server error body', async () => {
    FakeUploadRequest.status = 413;
    FakeUploadRequest.responseText = '{"error":"Upload too large"}';
    vi.stubGlobal('XMLHttpRequest', FakeUploadRequest);
    try {
      await expect(uploadForm('/api/upload', new FormData(), () => {})).rejects.toMatchObject({
        name: 'ApiError',
        status: 413,
        message: 'Upload too large',
      } satisfies Partial<ApiError>);
    } finally {
      FakeUploadRequest.status = 200;
      FakeUploadRequest.responseText = '{"files":[]}';
    }
  });

  it('formats binary sizes and explains the configured upload limit', () => {
    expect(formatUploadBytes(64 * 1024 * 1024)).toBe('64 MiB');
    expect(formatUploadBytes(32.25 * 1024 * 1024)).toBe('32.3 MiB');
    expect(uploadTooLargeMessage(80 * 1024 * 1024, 64 * 1024 * 1024)).toBe(
      'Upload too large (limit: 64 MiB, selected: 80 MiB). Choose a smaller file or increase WEB_CHAT_UPLOAD_MAX_MB.'
    );
  });

  it('uses the server limit for a 413 upload response', () => {
    const error = new ApiError(
      413,
      JSON.stringify({ error: 'Upload too large', maxBytes: 48 * 1024 * 1024 })
    );
    expect(uploadErrorMessage(error, 52 * 1024 * 1024, 64 * 1024 * 1024)).toBe(
      'Upload too large (limit: 48 MiB, selected: 52 MiB). Choose a smaller file or increase WEB_CHAT_UPLOAD_MAX_MB.'
    );
  });
});
