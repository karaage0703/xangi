import { ApiError } from './api';

export interface UploadProgress {
  loaded: number;
  total?: number;
}

export function uploadForm<T>(
  url: string,
  body: FormData,
  onProgress: (progress: UploadProgress) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.responseType = 'text';
    request.upload.addEventListener('progress', (event) => {
      onProgress({
        loaded: event.loaded,
        total: event.lengthComputable && event.total > 0 ? event.total : undefined,
      });
    });
    request.addEventListener('load', () => {
      const bodyText = request.responseText || '';
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(request.status, bodyText, request.statusText || 'Upload failed'));
        return;
      }
      try {
        resolve(JSON.parse(bodyText) as T);
      } catch {
        reject(new Error('Upload response was not valid JSON'));
      }
    });
    request.addEventListener('error', () => reject(new Error('Upload failed')));
    request.addEventListener('abort', () =>
      reject(new DOMException('Upload aborted', 'AbortError'))
    );
    request.send(body);
  });
}
