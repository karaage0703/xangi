import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  isRealFileWithin,
  parseDisplayedUserAttachments,
} from '../src/web-file-security.js';

describe('web file security', () => {
  it('accepts files inside an allowed root and rejects paths outside it', () => {
    const base = mkdtempSync(join(tmpdir(), 'xangi-web-files-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside.txt');
    mkdirSync(root);
    writeFileSync(join(root, 'inside.txt'), 'inside');
    writeFileSync(outside, 'outside');

    expect(isRealFileWithin(root, join(root, 'inside.txt'))).toBe(true);
    expect(isRealFileWithin(root, outside)).toBe(false);
  });

  it('rejects a symlink that escapes the allowed root', () => {
    const base = mkdtempSync(join(tmpdir(), 'xangi-web-symlink-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside.txt');
    mkdirSync(root);
    writeFileSync(outside, 'outside');
    const link = join(root, 'link.txt');
    symlinkSync(outside, link);

    expect(isRealFileWithin(root, link)).toBe(false);
  });

  it('removes attachment markers and keeps only valid unique files', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-attachments-'));
    const attachment = join(root, 'photo.png');
    writeFileSync(attachment, 'image');

    const parsed = parseDisplayedUserAttachments(
      `説明\n[添付ファイル]\n- ${attachment}\n- ${attachment}\n- /missing/file\n\n続き`,
      [root]
    );

    expect(parsed).toEqual({ content: '説明\n\n続き', attachments: [attachment] });
  });
});
