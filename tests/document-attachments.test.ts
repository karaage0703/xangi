import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentAttachments, attachmentPaths } from '../src/document-attachments.js';

describe('document attachments', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'document-attachments-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it('extracts all declared formats while excluding examples and traversal', () => {
    expect(
      attachmentPaths([
        { role: 'user', content: 'MEDIA:/tmp/not-granted.txt' },
        { role: 'assistant', content: { result: 'MEDIA:/tmp/a.txt' } },
        {
          role: 'assistant',
          content:
            'MEDIA:/tmp/a.txt\nMEDIA:/tmp/deck.pptx\nMEDIA:/tmp/a.txt\n`MEDIA:/tmp/code.xlsx`\n```\nMEDIA:/tmp/code.pdf\n```\nMEDIA:/tmp/../secret.txt\nMEDIA:https://example.com/a.pdf\nMEDIA:/tmp/日本語.pdf',
        },
      ])
    ).toEqual(['/tmp/a.txt', '/tmp/deck.pptx', '/tmp/日本語.pdf']);
  });
  it('serves an explicitly attached temporary text through a private snapshot', async () => {
    const file = join(root, '日本語.txt');
    writeFileSync(file, '文字起こし\n<script>bad()</script>');
    const service = new DocumentAttachments(join(root, '.xangi', 'document-previews'));
    const source = await service.source('session', file, [file], root);
    expect(source.file).not.toBe(file);
    expect(await service.info(source.file, source.dir)).toMatchObject({
      kind: 'text',
      text: '文字起こし\n<script>bad()</script>',
      truncated: false,
    });
    await expect(service.source('session', file, [], root)).rejects.toMatchObject({ status: 403 });
    await expect(service.source('session', file, [file], root, ['.pdf'])).rejects.toMatchObject({
      status: 403,
    });
  });
  it('retains a viewed temporary attachment and invalidates modified originals', async () => {
    const file = join(root, 'retained.txt');
    writeFileSync(file, 'first');
    const service = new DocumentAttachments(join(root, 'cache'));
    const first = await service.source('session', file, [file], root);
    writeFileSync(file, 'second version');
    const second = await service.source('session', file, [file], root);
    expect(second.file).not.toBe(first.file);
    rmSync(file);
    const restored = await service.source('session', file, [file], root);
    expect(await service.info(restored.file, restored.dir)).toMatchObject({
      text: 'second version',
    });
    await expect(service.source('other', file, [file], root)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('rejects symlink escapes and undeclared files', async () => {
    const file = join(root, 'link.txt');
    symlinkSync('/etc/passwd', file);
    const service = new DocumentAttachments(join(root, 'cache'));
    await expect(service.source('session', file, [file], root)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('keeps unknown types downloadable and rejects invalid pages', async () => {
    const file = join(root, 'archive.bin');
    writeFileSync(file, 'binary');
    const service = new DocumentAttachments(join(root, 'cache'));
    const source = await service.source('session', file, [file], root);
    expect(await service.info(source.file, source.dir)).toEqual({ kind: 'download' });
    await expect(service.page(source.file, source.dir, -1)).rejects.toMatchObject({ status: 400 });
    await expect(service.page(source.file, source.dir, 1)).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    ['pdf', '%PDF-1.4\nfixture', 'Poppler'],
    ['docx', 'PK\x03\x04fixture', 'LibreOffice'],
  ])('keeps %s downloadable when its preview tool is absent', async (ext, body, tool) => {
    const file = join(root, `attachment.${ext}`);
    writeFileSync(file, body);
    const service = new DocumentAttachments(join(root, 'cache'));
    const source = await service.source('session', file, [file], root);
    const oldPath = process.env.PATH;
    process.env.PATH = join(root, 'no-converters');
    try {
      await expect(service.info(source.file, source.dir)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining(tool),
      });
      const download = await service.source('session', file, [file], root, [], true);
      expect(download.file).toBe(file);
      expect(download.size).toBe(Buffer.byteLength(body));
      const text = join(root, 'still-works.txt');
      writeFileSync(text, 'still works');
      expect(await service.info(text, root)).toMatchObject({ kind: 'text', text: 'still works' });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
  it('reports text preview truncation and preserves the original download', async () => {
    const file = join(root, 'large.txt');
    writeFileSync(file, 'a'.repeat(2 * 1024 * 1024 + 4));
    const service = new DocumentAttachments(join(root, 'cache'));
    const source = await service.source('session', file, [file], root);
    expect(await service.info(source.file, source.dir)).toMatchObject({ truncated: true });
    const download = await service.source('session', file, [file], root, [], true);
    expect(download.size).toBe(2 * 1024 * 1024 + 4);
    expect(download.file).toBe(file);
  });
});

it('discovers structured backend attachments without requiring MEDIA text', () => {
  expect(
    attachmentPaths([
      {
        role: 'assistant',
        content: { result: 'created', attachments: ['/tmp/deck.pptx', '/tmp/book.xlsx'] },
      },
    ])
  ).toEqual(['/tmp/deck.pptx', '/tmp/book.xlsx']);
});

it('rejects mislabeled Office input rather than silently importing it as text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'invalid-office-'));
  try {
    const file = join(root, 'deck.pptx');
    writeFileSync(file, 'plain text pretending to be slides');
    const service = new DocumentAttachments(join(root, 'cache'));
    const source = await service.source('session', file, [file], root);
    await expect(service.info(source.file, source.dir)).rejects.toMatchObject({ status: 422 });
    expect((await service.source('session', file, [file], root, [], true)).file).toBe(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
