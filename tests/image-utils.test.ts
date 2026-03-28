import { describe, it, expect } from 'vitest';
import { isImageFile, getMimeType, extractAttachmentPaths } from '../src/local-llm/image-utils.js';

describe('isImageFile', () => {
  it('should return true for supported image extensions', () => {
    expect(isImageFile('/tmp/photo.jpg')).toBe(true);
    expect(isImageFile('/tmp/photo.jpeg')).toBe(true);
    expect(isImageFile('/tmp/photo.png')).toBe(true);
    expect(isImageFile('/tmp/photo.gif')).toBe(true);
    expect(isImageFile('/tmp/photo.webp')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isImageFile('/tmp/photo.JPG')).toBe(true);
    expect(isImageFile('/tmp/photo.PNG')).toBe(true);
    expect(isImageFile('/tmp/photo.WebP')).toBe(true);
  });

  it('should return false for non-image files', () => {
    expect(isImageFile('/tmp/document.pdf')).toBe(false);
    expect(isImageFile('/tmp/script.py')).toBe(false);
    expect(isImageFile('/tmp/data.json')).toBe(false);
    expect(isImageFile('/tmp/archive.zip')).toBe(false);
    expect(isImageFile('/tmp/noext')).toBe(false);
  });
});

describe('getMimeType', () => {
  it('should return correct MIME type for image extensions', () => {
    expect(getMimeType('/tmp/photo.jpg')).toBe('image/jpeg');
    expect(getMimeType('/tmp/photo.jpeg')).toBe('image/jpeg');
    expect(getMimeType('/tmp/photo.png')).toBe('image/png');
    expect(getMimeType('/tmp/photo.gif')).toBe('image/gif');
    expect(getMimeType('/tmp/photo.webp')).toBe('image/webp');
  });

  it('should return application/octet-stream for unknown extensions', () => {
    expect(getMimeType('/tmp/file.xyz')).toBe('application/octet-stream');
  });
});

describe('extractAttachmentPaths', () => {
  it('should return empty arrays when no attachments', () => {
    const result = extractAttachmentPaths('Hello, world!');
    expect(result.imagePaths).toEqual([]);
    expect(result.otherPaths).toEqual([]);
    expect(result.cleanPrompt).toBe('Hello, world!');
  });

  it('should extract image paths from attachment section', () => {
    const prompt = 'この画像を分析して\n\n[添付ファイル]\n  - /tmp/photo.jpg\n  - /tmp/screenshot.png';
    const result = extractAttachmentPaths(prompt);
    expect(result.imagePaths).toEqual(['/tmp/photo.jpg', '/tmp/screenshot.png']);
    expect(result.otherPaths).toEqual([]);
    expect(result.cleanPrompt).toBe('この画像を分析して');
  });

  it('should separate image and non-image paths', () => {
    const prompt = 'ファイルを確認して\n\n[添付ファイル]\n  - /tmp/photo.jpg\n  - /tmp/data.csv\n  - /tmp/image.png';
    const result = extractAttachmentPaths(prompt);
    expect(result.imagePaths).toEqual(['/tmp/photo.jpg', '/tmp/image.png']);
    expect(result.otherPaths).toEqual(['/tmp/data.csv']);
    expect(result.cleanPrompt).toBe('ファイルを確認して');
  });

  it('should handle only non-image attachments', () => {
    const prompt = 'ファイルを読んで\n\n[添付ファイル]\n  - /tmp/data.json\n  - /tmp/script.py';
    const result = extractAttachmentPaths(prompt);
    expect(result.imagePaths).toEqual([]);
    expect(result.otherPaths).toEqual(['/tmp/data.json', '/tmp/script.py']);
    expect(result.cleanPrompt).toBe('ファイルを読んで');
  });

  it('should handle prompt with no text before attachments', () => {
    const prompt = '添付ファイルを確認してください\n\n[添付ファイル]\n  - /tmp/photo.jpg';
    const result = extractAttachmentPaths(prompt);
    expect(result.imagePaths).toEqual(['/tmp/photo.jpg']);
    expect(result.cleanPrompt).toBe('添付ファイルを確認してください');
  });
});
