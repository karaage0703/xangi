import { ApiError } from './api';

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * 1024;

export interface UploadProgress {
  loaded: number;
  total?: number;
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < KIBIBYTE) return `${bytes} B`;
  if (bytes < MEBIBYTE) return `${(bytes / KIBIBYTE).toFixed(1)} KiB`;
  const mebibytes = bytes / MEBIBYTE;
  return `${Number.isInteger(mebibytes) ? mebibytes.toFixed(0) : mebibytes.toFixed(1)} MiB`;
}

export function uploadTooLargeMessage(selectedBytes: number, maxBytes: number): string {
  return `Upload too large (limit: ${formatUploadBytes(maxBytes)}, selected: ${formatUploadBytes(selectedBytes)}). Choose a smaller file or increase WEB_CHAT_UPLOAD_MAX_MB.`;
}

export function uploadErrorMessage(
  cause: unknown,
  selectedBytes: number | undefined,
  configuredMaxBytes: number
): string {
  if (cause instanceof ApiError && cause.status === 413 && selectedBytes !== undefined) {
    let maxBytes = configuredMaxBytes;
    try {
      const parsed = JSON.parse(cause.body) as { maxBytes?: unknown };
      if (typeof parsed.maxBytes === 'number' && parsed.maxBytes > 0) {
        maxBytes = parsed.maxBytes;
      }
    } catch {
      // Fall back to the runtime configuration when the error body is not JSON.
    }
    return uploadTooLargeMessage(selectedBytes, maxBytes);
  }
  return cause instanceof Error ? cause.message : String(cause);
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
