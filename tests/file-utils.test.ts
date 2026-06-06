import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
  resolveAttachmentPath,
  hasUnresolvedMediaMarker,
  buildAttachmentResult,
  getMissingMediaNotice,
} from '../src/file-utils.js';

describe('extractFilePaths', () => {
  let workspace: string;
  let outputsDir: string;
  let imageRel: string; // outputs/reckless_hero.png
  let imageAbs: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'xangi-ws-'));
    outputsDir = join(workspace, 'outputs');
    mkdirSync(outputsDir, { recursive: true });
    imageAbs = join(outputsDir, 'reckless_hero.png');
    imageRel = 'outputs/reckless_hero.png';
    writeFileSync(imageAbs, 'fakepng');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('resolves [IMAGE:relative] against WORKSPACE_PATH (the karaagebot bug)', () => {
    const text = `描いてみたよ！\n\n[IMAGE:${imageRel}]\n\nどうかな？`;
    expect(extractFilePaths(text, workspace)).toEqual([imageAbs]);
  });

  it('handles MEDIA: with absolute path inside workspace', () => {
    const text = `できたよ MEDIA:${imageAbs} 確認して`;
    expect(extractFilePaths(text, workspace)).toEqual([imageAbs]);
  });

  it('handles MEDIA: with a relative path resolved against workspace', () => {
    const text = `MEDIA:${imageRel}`;
    expect(extractFilePaths(text, workspace)).toEqual([imageAbs]);
  });

  it('handles markdown image ![alt](path)', () => {
    const text = `結果: ![hero](${imageRel})`;
    expect(extractFilePaths(text, workspace)).toEqual([imageAbs]);
  });

  it('handles markdown link [label](path)', () => {
    const text = `[完成図](${imageAbs})`;
    expect(extractFilePaths(text, workspace)).toEqual([imageAbs]);
  });

  it('handles [FILE:path] marker', () => {
    const pdf = join(outputsDir, 'report.pdf');
    writeFileSync(pdf, 'pdf');
    const text = `[FILE:outputs/report.pdf]`;
    expect(extractFilePaths(text, workspace)).toEqual([pdf]);
  });

  it('does NOT pick up a bare path without a marker (deliberate: avoid prose false-positives)', () => {
    const text = `生成物は outputs/reckless_hero.png に保存したよ`;
    expect(extractFilePaths(text, workspace)).toEqual([]);
  });

  it('dedupes when the same file appears via multiple syntaxes', () => {
    const text = `MEDIA:${imageAbs}\n[IMAGE:${imageRel}]\n![x](${imageRel})`;
    expect(extractFilePaths(text, workspace)).toEqual([imageAbs]);
  });

  // ---- security / sandbox ----

  it('rejects absolute paths outside the workspace (e.g. /etc/passwd-style)', () => {
    // create a real media file outside the sandbox
    const outsideDir = mkdtempSync(join(tmpdir(), 'xangi-outside-'));
    // NOTE: mkdtemp lives under tmpdir() which IS a broad root, so to truly test
    // "outside" we point at a path that is neither workspace nor tmp.
    rmSync(outsideDir, { recursive: true, force: true });
    const text = `MEDIA:/etc/hostname`;
    // /etc/hostname exists on linux but is outside allowed roots -> not attached
    expect(extractFilePaths(text, workspace)).toEqual([]);
  });

  it('rejects an explicit marker whose path is outside allowed roots (e.g. /etc)', () => {
    const text = `MEDIA:/etc/hostname`;
    expect(extractFilePaths(text, workspace)).toEqual([]);
  });

  it('does not attach a bare path even with a marker-less media filename in prose', () => {
    const stray = join(workspace, 'stray.png');
    writeFileSync(stray, 'x');
    const text = `画像は stray.png にあるよ`;
    expect(extractFilePaths(text, workspace)).toEqual([]);
  });

  it('rejects a marker pointing at a non-existent file', () => {
    const text = `[IMAGE:outputs/missing.png]`;
    expect(extractFilePaths(text, workspace)).toEqual([]);
  });

  it('ignores directories, only attaches files', () => {
    const text = `MEDIA:${outputsDir}`;
    expect(extractFilePaths(text, workspace)).toEqual([]);
  });

  it('canonicalizes via realpath (symlink resolves to its real target, not the link path)', () => {
    // outputs/ 内の実ファイルへ、outputs/ 内の symlink を張る。
    // 抽出結果は symlink のパスではなく realpath（実体）になる。
    const real = join(outputsDir, 'real.png');
    writeFileSync(real, 'x');
    const link = join(outputsDir, 'alias.png');
    symlinkSync(real, link);
    expect(extractFilePaths(`MEDIA:outputs/alias.png`, workspace)).toEqual([real]);
  });

  it('returns empty for empty / undefined-ish input', () => {
    expect(extractFilePaths('', workspace)).toEqual([]);
  });

  it('allows an explicit marker to a file in /tmp (broad root)', () => {
    const tmpImg = join(tmpdir(), `xangi-tmpimg-${Date.now()}.png`);
    writeFileSync(tmpImg, 'x');
    const text = `MEDIA:${tmpImg}`;
    expect(extractFilePaths(text, workspace)).toEqual([tmpImg]);
    rmSync(tmpImg, { force: true });
  });

  it('honors ATTACHMENT_ALLOWED_DIRS for extra roots', () => {
    const extraDir = mkdtempSync(join(tmpdir(), 'xangi-extra-'));
    const f = join(extraDir, 'pic.png');
    writeFileSync(f, 'x');
    const prev = process.env.ATTACHMENT_ALLOWED_DIRS;
    process.env.ATTACHMENT_ALLOWED_DIRS = extraDir;
    try {
      // explicit marker to a file in an extra-allowed dir
      const text = `MEDIA:${f}`;
      expect(extractFilePaths(text, workspace)).toEqual([f]);
    } finally {
      if (prev === undefined) delete process.env.ATTACHMENT_ALLOWED_DIRS;
      else process.env.ATTACHMENT_ALLOWED_DIRS = prev;
      rmSync(extraDir, { recursive: true, force: true });
    }
  });
});

describe('resolveAttachmentPath', () => {
  let workspace: string;
  let imageAbs: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'xangi-ws2-'));
    mkdirSync(join(workspace, 'outputs'), { recursive: true });
    imageAbs = join(workspace, 'outputs', 'pic.png');
    writeFileSync(imageAbs, 'x');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('resolves a relative path against the workspace and returns the realpath', () => {
    expect(resolveAttachmentPath('outputs/pic.png', workspace)).toBe(imageAbs);
  });

  it('accepts an absolute path inside the workspace', () => {
    expect(resolveAttachmentPath(imageAbs, workspace)).toBe(imageAbs);
  });

  it('accepts a workspace-root file (broad tier, not just outputs/)', () => {
    const doc = join(workspace, 'note.md');
    writeFileSync(doc, 'x');
    expect(resolveAttachmentPath('note.md', workspace)).toBe(doc);
  });

  it('returns null for a file outside allowed roots', () => {
    expect(resolveAttachmentPath('/etc/hostname', workspace)).toBeNull();
  });

  it('returns null for a non-existent file', () => {
    expect(resolveAttachmentPath('outputs/missing.png', workspace)).toBeNull();
  });

  it('returns null for a directory', () => {
    expect(resolveAttachmentPath('outputs', workspace)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveAttachmentPath('', workspace)).toBeNull();
  });
});

describe('stripFilePaths', () => {
  it('removes MEDIA: markers', () => {
    expect(stripFilePaths('できたよ\nMEDIA:/workspace/outputs/a.png')).toBe('できたよ');
  });

  it('removes [IMAGE:...] bracket markers', () => {
    expect(stripFilePaths('描いたよ [IMAGE:outputs/a.png] どう？')).toBe('描いたよ  どう？');
  });

  it('removes markdown image syntax', () => {
    expect(stripFilePaths('結果 ![hero](outputs/a.png)')).toBe('結果');
  });

  it('collapses 3+ newlines left behind', () => {
    expect(stripFilePaths('a\nMEDIA:/x/y.png\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('buildPromptWithAttachments', () => {
  it('returns prompt unchanged with no files', () => {
    expect(buildPromptWithAttachments('hi', [])).toBe('hi');
  });

  it('appends the attachment list', () => {
    expect(buildPromptWithAttachments('hi', ['/a/b.png'])).toBe(
      'hi\n\n[添付ファイル]\n  - /a/b.png'
    );
  });
});

describe('hasUnresolvedMediaMarker', () => {
  let workspace: string;
  let outputsDir: string;
  let imageRel: string;
  let imageAbs: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'xangi-ws-'));
    outputsDir = join(workspace, 'outputs');
    mkdirSync(outputsDir, { recursive: true });
    imageAbs = join(outputsDir, 'real.png');
    imageRel = 'outputs/real.png';
    writeFileSync(imageAbs, 'fakepng');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns true when a MEDIA: path does not exist (the phantom-path bug)', () => {
    const text = `描いたよ！\nMEDIA:outputs/phantom.png`;
    expect(hasUnresolvedMediaMarker(text, workspace)).toBe(true);
  });

  it('returns true when an [IMAGE:...] path does not exist', () => {
    const text = `完成！[IMAGE:outputs/phantom.png]`;
    expect(hasUnresolvedMediaMarker(text, workspace)).toBe(true);
  });

  it('returns false when the MEDIA: path is a real file', () => {
    const text = `できたよ MEDIA:${imageRel}`;
    expect(hasUnresolvedMediaMarker(text, workspace)).toBe(false);
  });

  it('returns false for http(s) / data URLs (not an attachment failure)', () => {
    expect(hasUnresolvedMediaMarker('MEDIA:https://example.com/a.png', workspace)).toBe(false);
    expect(hasUnresolvedMediaMarker('MEDIA:data:image/png;base64,AAAA', workspace)).toBe(false);
  });

  it('returns false for plain text with no markers', () => {
    expect(hasUnresolvedMediaMarker('画像は作れなかったよ', workspace)).toBe(false);
  });
});

describe('getMissingMediaNotice', () => {
  afterEach(() => {
    delete process.env.ATTACHMENT_MISSING_NOTICE;
  });

  it('returns the default notice', () => {
    delete process.env.ATTACHMENT_MISSING_NOTICE;
    expect(getMissingMediaNotice()).toContain('添付できませんでした');
  });

  it('can be overridden via ATTACHMENT_MISSING_NOTICE', () => {
    process.env.ATTACHMENT_MISSING_NOTICE = 'カスタム注記';
    expect(getMissingMediaNotice()).toBe('カスタム注記');
  });
});

describe('buildAttachmentResult', () => {
  let workspace: string;
  let outputsDir: string;
  let imageRel: string;
  let imageAbs: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'xangi-ws-'));
    outputsDir = join(workspace, 'outputs');
    mkdirSync(outputsDir, { recursive: true });
    imageAbs = join(outputsDir, 'real.png');
    imageRel = 'outputs/real.png';
    writeFileSync(imageAbs, 'fakepng');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.ATTACHMENT_MISSING_NOTICE;
  });

  it('attaches a real file and strips the marker from display text', () => {
    const { filePaths, displayText } = buildAttachmentResult(
      `描いたよ\nMEDIA:${imageRel}`,
      undefined,
      workspace
    );
    expect(filePaths).toEqual([imageAbs]);
    expect(displayText).toBe('描いたよ');
  });

  it('merges and dedupes structured attachments with text-derived paths', () => {
    const { filePaths } = buildAttachmentResult(`MEDIA:${imageRel}`, [imageAbs], workspace);
    expect(filePaths).toEqual([imageAbs]);
  });

  it('appends the failure notice when a phantom MEDIA path resolves to nothing', () => {
    const { filePaths, displayText } = buildAttachmentResult(
      `描いたよ！\nMEDIA:outputs/phantom.png`,
      undefined,
      workspace
    );
    expect(filePaths).toEqual([]);
    expect(displayText).toContain('描いたよ');
    expect(displayText).toContain(getMissingMediaNotice());
  });

  it('returns the notice alone when stripping leaves an empty body', () => {
    const { filePaths, displayText } = buildAttachmentResult(
      `MEDIA:outputs/phantom.png`,
      undefined,
      workspace
    );
    expect(filePaths).toEqual([]);
    expect(displayText).toBe(getMissingMediaNotice());
  });

  it('passes plain text through untouched when there are no markers', () => {
    const { filePaths, displayText } = buildAttachmentResult(
      '今日はいい天気だね',
      undefined,
      workspace
    );
    expect(filePaths).toEqual([]);
    expect(displayText).toBe('今日はいい天気だね');
  });
});
