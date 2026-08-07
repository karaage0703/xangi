import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../web-ui/src/api.js';
import { uploadForm } from '../web-ui/src/upload.js';

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
});
