import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { realFileWithinRoots } from './file-utils.js';

const exec = promisify(execFile);
const OFFICE = /\.(?:docx?|docm|odt|rtf|pptx?|pptm|ppsx?|odp|xlsx?|xlsm|ods)$/i;
const TEXT =
  /\.(?:txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|log|rst|tex|ini|toml|py|[cm]?js|tsx?|css|sh)$/i;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;
export class AttachmentError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Explicit attachments only; code examples and user-supplied filesystem strings are not grants. */
export function attachmentPaths(messages: { role: string; content: unknown }[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (
      message.content &&
      typeof message.content === 'object' &&
      'attachments' in message.content &&
      Array.isArray(message.content.attachments)
    ) {
      for (const file of message.content.attachments) {
        if (
          typeof file === 'string' &&
          file.startsWith('/') &&
          !file.startsWith('//') &&
          !file.split('/').includes('..') &&
          ![...file].some((char) => char.charCodeAt(0) < 32)
        )
          paths.add(file);
      }
    }

    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content && typeof message.content === 'object' && 'result' in message.content
          ? message.content.result
          : undefined;
    if (typeof content !== 'string') continue;
    let fence = '';
    for (const line of content.split(/\r?\n/)) {
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (line.trim().length >= fence.length && [...line.trim()].every((c) => c === fence[0]))
          fence = '';
        continue;
      }
      if (marker) {
        fence = marker[1];
        continue;
      }
      if (/^(?: {4}|\t)/.test(line)) continue;
      const ranges: [number, number][] = [];
      const ticks = /`+/g;
      let tick;
      while ((tick = ticks.exec(line))) {
        const end = line.indexOf(tick[0], ticks.lastIndex);
        if (end < 0) continue;
        ranges.push([tick.index, end + tick[0].length]);
        ticks.lastIndex = end + tick[0].length;
      }
      for (const match of line.matchAll(
        /MEDIA:([^\s`"'<>()[\]{}（）［］【】「」『』、。！？,;]+)/g
      )) {
        if (ranges.some(([a, b]) => match.index >= a && match.index < b)) continue;
        const path = match[1];
        if (
          path.startsWith('/') &&
          !path.startsWith('//') &&
          ![...path].some((char) => char.charCodeAt(0) < 32) &&
          !/[\\?#]/.test(path) &&
          !path.split('/').includes('..')
        )
          paths.add(path);
      }
    }
  }
  return [...paths];
}

export class DocumentAttachments {
  private pending = new Map<string, Promise<void>>();
  private active = 0;
  constructor(private root: string) {}

  async source(
    sessionId: string,
    path: string,
    declared: string[],
    workspace: string,
    allowedExtensions: string[] = [],
    download = false
  ) {
    if (!declared.includes(path))
      throw new AttachmentError('この会話の添付ファイルではありません。', 403);
    if (allowedExtensions.length && !allowedExtensions.includes(extname(path).toLowerCase()))
      throw new AttachmentError('この形式のダウンロードは設定で許可されていません。', 403);
    const slot = createHash('sha256')
      .update(JSON.stringify([sessionId, path]))
      .digest('hex');
    const pointer = join(this.root, `${slot}.json`);
    const source = realFileWithinRoots(path, [
      workspace,
      tmpdir(),
      join(this.root, '..', 'media', 'attachments'),
    ]);
    if (!source) {
      // A missing temporary original can be recovered from a previously viewed snapshot.
      // A present but disallowed path (including an escaping symlink) is never recovered.
      if (!(await fs.lstat(path).catch(() => null))) {
        const previous = await fs
          .readFile(pointer, 'utf8')
          .then((value) => JSON.parse(value))
          .catch(() => null);
        if (typeof previous?.id === 'string' && /^[a-f0-9]{64}$/.test(previous.id)) {
          const dir = join(this.root, previous.id);
          const file = realFileWithinRoots(join(dir, `source${extname(path).toLowerCase()}`), [
            this.root,
          ]);
          if (file) return { file, dir, name: basename(path), size: (await fs.stat(file)).size };
        }
      }
      throw new AttachmentError('添付ファイルが見つからないか、許可された場所にありません。', 404);
    }
    const stat = await fs.stat(source);
    if (download) return { file: source, dir: '', name: basename(path), size: stat.size };
    if (stat.size > 100 * 1024 * 1024)
      throw new AttachmentError('プレビューは100MB以下のファイルに対応しています。', 413);
    const id = createHash('sha256')
      .update(JSON.stringify([sessionId, source, stat.size, stat.mtimeMs, stat.ctimeMs]))
      .digest('hex');
    const dir = join(this.root, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `source${extname(path).toLowerCase()}`);
    await this.once(file, async () => {
      if (await fs.stat(file).catch(() => null)) return;
      const data = await fs.readFile(source);
      if (data.length > 100 * 1024 * 1024)
        throw new AttachmentError('プレビューは100MB以下です。', 413);
      const temporary = `${file}.part`;
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    const temporaryPointer = `${pointer}.${randomUUID()}.part`;
    await fs.writeFile(temporaryPointer, JSON.stringify({ id }), { mode: 0o600 });
    await fs.rename(temporaryPointer, pointer).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return { file, dir, name: basename(path), size: stat.size };
  }

  private async once(key: string, job: () => Promise<void>) {
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.active >= 2)
      throw new AttachmentError('他の文書を変換中です。少し待って再試行してください。', 503);
    this.active++;
    const promise = job().finally(() => {
      this.active--;
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  private async pdf(file: string, dir: string): Promise<string> {
    if (/\.pdf$/i.test(file)) return file;
    const header = Buffer.alloc(8);
    const handle = await fs.open(file, 'r');
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    const modern = /\.(?:docx|docm|pptx|pptm|ppsx|xlsx|xlsm|odt|odp|ods)$/i.test(file);
    const valid = modern
      ? header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      : /\.rtf$/i.test(file)
        ? header.toString('ascii').startsWith('{\\rtf')
        : header.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if (!valid)
      throw new AttachmentError(
        '文書の形式を確認できません。ファイルが破損しているか、拡張子と内容が一致していません。原本はダウンロードできます。',
        422
      );
    const output = join(dir, 'source.pdf');
    if (await fs.stat(output).catch(() => null)) return output;
    await this.once(output, async () => {
      const profile = join(dir, 'profile');
      await fs.mkdir(join(profile, 'user'), { recursive: true });
      await fs.writeFile(
        join(profile, 'user', 'registrymodifications.xcu'),
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>'
      );
      try {
        await exec(
          'libreoffice',
          [
            `-env:UserInstallation=${pathToFileURL(profile).href}`,
            '--headless',
            '--norestore',
            '--convert-to',
            'pdf',
            '--outdir',
            dir,
            file,
          ],
          { timeout: 60000, maxBuffer: 1024 * 1024 }
        );
        await fs.access(output);
      } catch {
        throw new AttachmentError(
          '文書を変換できませんでした。LibreOfficeの導入、ファイルの破損・パスワード保護を確認してください。原本はダウンロードできます。',
          422
        );
      }
    });
    return output;
  }

  async info(file: string, dir: string) {
    if (TEXT.test(file)) {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(2 * 1024 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          kind: /\.(md|markdown)$/i.test(file) ? 'markdown' : 'text',
          text: buffer.subarray(0, bytesRead).toString('utf8'),
          truncated: (await handle.stat()).size > bytesRead,
        };
      } finally {
        await handle.close();
      }
    }
    if (IMAGE.test(file)) return { kind: 'image' };
    if (/\.html?$/i.test(file)) return { kind: 'html' };
    if (/\.(?:mp3|wav|m4a|ogg|flac|aac)$/i.test(file)) return { kind: 'audio' };
    if (/\.(?:mp4|webm|mov|m4v)$/i.test(file)) return { kind: 'video' };
    if (/\.pdf$/i.test(file) || OFFICE.test(file)) {
      const pdf = await this.pdf(file, dir);
      try {
        const { stdout } = await exec('pdfinfo', [pdf], {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, LC_ALL: 'C' },
        });
        const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
        if (!Number.isInteger(pages) || pages < 1) throw new Error('pages');
        return { kind: 'pages', pages };
      } catch {
        throw new AttachmentError(
          'PDFを読み取れませんでした。Popplerの導入、破損・パスワード保護を確認してください。原本はダウンロードできます。',
          422
        );
      }
    }
    return { kind: 'download' };
  }

  async page(file: string, dir: string, page: number) {
    if (!Number.isInteger(page) || page < 1) throw new AttachmentError('ページ番号が不正です。');
    const info = await this.info(file, dir);
    if (info.kind !== 'pages' || page > (info.pages ?? 0))
      throw new AttachmentError('ページが見つかりません。', 404);
    const output = join(dir, `page-${page}.png`);
    if (!(await fs.stat(output).catch(() => null))) {
      await this.once(output, async () => {
        try {
          await exec(
            'pdftoppm',
            [
              '-f',
              String(page),
              '-l',
              String(page),
              '-singlefile',
              '-scale-to',
              '1600',
              '-png',
              await this.pdf(file, dir),
              output.slice(0, -4),
            ],
            { timeout: 30000, maxBuffer: 1024 * 1024 }
          );
        } catch {
          throw new AttachmentError(
            'ページを表示できませんでした。原本をダウンロードしてください。',
            422
          );
        }
      });
    }
    return output;
  }
}
