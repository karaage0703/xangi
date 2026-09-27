import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface FileChange {
  path: string;
  operation: 'added' | 'modified' | 'deleted';
  added?: number;
  deleted?: number;
  diff?: string;
  truncated?: boolean;
  binary?: boolean;
  omittedReason?: string;
  approximate?: boolean;
  workspaceId?: string;
}
export interface FileChangeReport {
  files: FileChange[];
  partial: boolean;
  concurrent: boolean;
}
/** A successful backend-native file change, not a requested tool operation. */
export interface BackendFileChange {
  path: string;
  operation: 'added' | 'modified' | 'deleted';
  diff?: string;
  omittedReason?: string;
}
interface SnapshotFile {
  exists?: boolean;
  hash?: string;
  text?: string;
  binary?: boolean;
  reason?: string;
}
const excluded = new Set([
  '.git',
  '.xangi',
  '.xangi-search',
  '.state',
  '.workspace_rag',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  'logs',
  '.cache',
  '.next',
]);
const sensitive =
  /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519).*)$|\.(?:pem|key|p12|pfx)$/i;
const MAX_FILE = 128 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DIFF = 8000;
const MAX_FILES = 100;
const activeTargets = new Map<string, Set<{ concurrent: boolean }>>();
function redact(text: string): string {
  const secretKey = String.raw`[\w.-]*(?:token|api[_-]?key|authorization|password|secret|access[_-]?key|private[_-]?key)[\w.-]*`;
  const blockStart = new RegExp(
    String.raw`^(\s*)(?:-\s*)?["']?${secretKey}["']?\s*:\s*(?:[|>][\d+-]*)?\s*(?:#.*)?$`,
    'i'
  );
  // YAML block scalars and nested secret values span subsequent indented lines.
  let secretIndent: number | undefined;
  const safeLines = text
    .split('\n')
    .map((line) => {
      const prefix = /^[+-]/.test(line) ? line[0] : '';
      const content = prefix ? line.slice(1) : line;
      if (secretIndent !== undefined) {
        if (!content.trim()) return '';
        const indent = content.match(/^\s*/)![0].length;
        if (indent > secretIndent) return `${prefix}${' '.repeat(indent)}***`;
        secretIndent = undefined;
      }
      const block = blockStart.exec(content);
      if (block) {
        secretIndent = block[1].length;
        return `${prefix}${content.slice(0, content.indexOf(':') + 1)} ***`;
      }
      return line;
    })
    .join('\n');
  return safeLines
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#<>"'`\\]*@/gi, '$1***@')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(
      new RegExp(
        String.raw`\b(${secretKey})["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"',\s}]+)`,
        'gi'
      ),
      '$1=***'
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[PRIVATE KEY REDACTED]'
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      '***'
    );
}

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}
/** A valid contiguous replacement hunk, bounded even for generated/minified files. */
export function fileDiff(
  before: string,
  after: string
): Pick<FileChange, 'added' | 'deleted' | 'diff' | 'truncated' | 'approximate'> {
  const a = lines(redact(before)),
    b = lines(redact(after));
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - end - 1] === b[b.length - end - 1]
  )
    end++;
  const oldLines = a.slice(start, a.length - end),
    newLines = b.slice(start, b.length - end);
  const approximate = (oldLines.length + 1) * (newLines.length + 1) > 1000000;
  let operations: string[];
  if (approximate || !oldLines.length || !newLines.length) {
    operations = [...oldLines.map((x) => `-${x}`), ...newLines.map((x) => `+${x}`)];
  } else {
    const width = newLines.length + 1;
    const lcs = new Uint32Array((oldLines.length + 1) * width);
    for (let i = oldLines.length - 1; i >= 0; i--) {
      for (let j = newLines.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          oldLines[i] === newLines[j]
            ? 1 + lcs[(i + 1) * width + j + 1]
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    operations = [];
    let i = 0,
      j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        operations.push(` ${oldLines[i++]}`);
        j++;
      } else if (
        j >= newLines.length ||
        (i < oldLines.length && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
      )
        operations.push(`-${oldLines[i++]}`);
      else operations.push(`+${newLines[j++]}`);
    }
  }
  const deleted = operations.filter((x) => x.startsWith('-')).length;
  const added = operations.filter((x) => x.startsWith('+')).length;
  const contextStart = Math.max(0, start - 3),
    tail = Math.min(3, end);
  const oldCount = start - contextStart + oldLines.length + tail;
  const newCount = start - contextStart + newLines.length + tail;
  const diff = [
    `@@ -${oldCount ? contextStart + 1 : contextStart},${oldCount} +${newCount ? contextStart + 1 : contextStart},${newCount} @@`,
    ...a.slice(contextStart, start).map((x) => ` ${x}`),
    ...operations,
    ...a.slice(a.length - end, a.length - end + tail).map((x) => ` ${x}`),
    ...(before.endsWith('\n') !== after.endsWith('\n')
      ? ['\\ No newline at end of file (changed)']
      : []),
  ].join('\n');
  return {
    added,
    deleted,
    diff: redact(diff).slice(0, MAX_DIFF),
    truncated: diff.length > MAX_DIFF,
    approximate,
  };
}

/** Only explicit editor arguments are inspected. Shell commands are never parsed. */
export function editedPaths(tool: string, input: Record<string, unknown>): string[] {
  const name = tool.replace(/^functions\./, '').toLowerCase();
  if (
    [
      'write',
      'write_file',
      'edit',
      'edit_file',
      'multiedit',
      'str_replace_editor',
      'create',
      'create_file',
      'write_to_file',
      'replace_file_content',
      'multi_replace_file_content',
    ].includes(name)
  ) {
    if (
      name === 'str_replace_editor' &&
      !['create', 'str_replace', 'insert', 'undo_edit'].includes(String(input.command))
    )
      return [];
    const path = input.file_path ?? input.filePath ?? input.path ?? input.TargetFile;
    return typeof path === 'string' ? [path] : [];
  }
  if (name !== 'apply_patch') return [];
  if (input.dry_run === true) return [];
  if (Array.isArray(input.edits))
    return input.edits
      .slice(0, MAX_FILES + 1)
      .flatMap((edit) => {
        if (!edit || typeof edit !== 'object') return [];
        const path = (edit as Record<string, unknown>).path;
        return typeof path === 'string' ? [path] : [];
      })
      .slice(0, MAX_FILES + 1);
  const patch = input.patch ?? input.input;
  if (typeof patch !== 'string' || patch.length > 2 * 1024 * 1024) return [];
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
    .slice(0, MAX_FILES + 1)
    .map((m) => m[1].trim());
}

/** Validate all ancestors, including missing leaves, without enumerating a directory. */
function targetPath(root: string, path: string): { absolute: string; path: string } | undefined {
  if (!path || path.includes('\0') || /[\r\n]/.test(path)) return;
  const absolute = resolve(root, path),
    rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  const parts = rel.split(sep);
  if (parts.some((p) => excluded.has(p) || sensitive.test(p) || p === '.git-credentials')) return;
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || (!st.isDirectory() && current !== absolute)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
  return { absolute, path: parts.join('/') };
}

/** Lazy observation: construction and ordinary conversation perform no filesystem I/O. */
export function createFileObservation(workdir: string, workspaceId?: string) {
  const before = new Map<string, SnapshotFile>();
  const confirmed = new Map<string, BackendFileChange>();
  const marker = { concurrent: false };
  const registered = new Set<string>();
  function register(absolute: string) {
    if (registered.has(absolute)) return;
    const owners = activeTargets.get(absolute) ?? new Set();
    if (owners.size) {
      marker.concurrent = true;
      for (const owner of owners) owner.concurrent = true;
    }
    owners.add(marker);
    activeTargets.set(absolute, owners);
    registered.add(absolute);
  }
  function release() {
    for (const path of registered) {
      const owners = activeTargets.get(path);
      owners?.delete(marker);
      if (!owners?.size) activeTargets.delete(path);
    }
    registered.clear();
  }
  let root: string | undefined;
  let bytes = 0,
    partial = false,
    closed = false;
  function target(path: string) {
    try {
      root ??= realpathSync(workdir);
      return targetPath(root, path);
    } catch {
      partial = true;
      return undefined;
    }
  }
  function read(path: string): SnapshotFile {
    let fd: number | undefined;
    try {
      const t = target(path);
      if (!t) return { reason: '対象パスを安全に読み取れません。' };
      fd = openSync(t.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { reason: '通常のファイルではありません。' };
      if (stat.size > MAX_FILE)
        return { exists: true, reason: 'ファイルが128 KiBを超えたため本文を取得していません。' };
      if (bytes + stat.size + 1 > MAX_BYTES)
        return { exists: true, reason: '対象ファイルの読み取り総量の上限（16 MiB）に達しました。' };
      const buffer = Buffer.alloc(stat.size + 1);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      bytes += count;
      if (count !== stat.size)
        return { exists: true, reason: '読み取り中にファイルのサイズが変わりました。' };
      const data = buffer.subarray(0, count),
        binary = data.includes(0);
      return {
        exists: true,
        hash: createHash('sha256').update(data).digest('hex'),
        binary,
        ...(binary
          ? { reason: 'バイナリファイルのため内容を表示できません。' }
          : { text: data.toString('utf8') }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '' };
      return { reason: '対象ファイルを読み取れませんでした。' };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          partial = true;
        }
      }
    }
  }
  return {
    onToolUse(tool: string, input: Record<string, unknown>) {
      if (closed) return;
      for (const path of editedPaths(tool, input)) {
        if (before.size >= MAX_FILES) {
          partial = true;
          break;
        }
        const t = target(path);
        if (!t || before.has(t.path)) continue;
        // Synchronous capture completes before an in-process tool can execute.
        register(t.absolute);
        before.set(t.path, read(t.path));
      }
    },
    onFileChanges(changes: BackendFileChange[]) {
      if (closed) return;
      for (const change of changes) {
        if (confirmed.size >= MAX_FILES) {
          partial = true;
          break;
        }
        const t = target(change.path);
        if (!t) continue;
        // Several patches to one path are not a single net diff. Keep the confirmed path.
        register(t.absolute);
        const previous = confirmed.get(t.path);
        const oversized = (change.diff?.length ?? 0) > MAX_FILE;
        const operation = previous
          ? previous.operation === 'added' && change.operation !== 'deleted'
            ? 'added'
            : change.operation === 'deleted'
              ? 'deleted'
              : 'modified'
          : change.operation;
        confirmed.set(t.path, {
          ...change,
          operation,
          path: t.path,
          diff: previous || oversized ? undefined : change.diff ? redact(change.diff) : undefined,
          omittedReason: oversized
            ? 'バックエンドの差分が128 KiB相当の文字数上限を超えたため省略しました。'
            : undefined,
        });
      }
    },
    finish(): FileChangeReport {
      if (closed) return { files: [], partial: false, concurrent: false };
      closed = true;
      const report: FileChangeReport = { files: [], partial, concurrent: marker.concurrent };
      try {
        let diffBytes = 0;
        for (const path of new Set([...before.keys(), ...confirmed.keys()])) {
          if (report.files.length >= MAX_FILES) {
            report.partial = true;
            break;
          }
          // Revalidate at completion: a tool may have replaced an ancestor with a link.
          if (!target(path)) continue;
          const a = before.get(path),
            native = confirmed.get(path);
          const b = a ? read(path) : undefined;
          const comparable =
            a &&
            b &&
            a.exists !== undefined &&
            b.exists !== undefined &&
            (!a.exists || a.hash !== undefined) &&
            (!b.exists || b.hash !== undefined);
          if (comparable && a.exists === b.exists && a.hash === b.hash && !native) continue;
          if (!native && !comparable) {
            report.partial = true;
            continue;
          }
          const observed = comparable && (a.exists !== b.exists || a.hash !== b.hash);
          const operation = observed
            ? !a.exists
              ? 'added'
              : !b.exists
                ? 'deleted'
                : 'modified'
            : native?.operation;
          if (!operation) continue;
          const file: FileChange = { path, operation, workspaceId };
          if (observed && a.text !== undefined && b.text !== undefined && diffBytes < 160000) {
            Object.assign(file, fileDiff(a.text, b.text));
          } else if (native?.diff && diffBytes < 160000) {
            const diff = redact(native.diff);
            file.diff = diff.slice(0, MAX_DIFF);
            file.truncated = diff.length > MAX_DIFF;
            // Native diffs can contain headers or be partial; do not invent exact counts.
          } else {
            file.truncated = true;
            file.binary = a?.binary || b?.binary;
            file.omittedReason =
              a?.reason ??
              b?.reason ??
              native?.omittedReason ??
              (diffBytes >= 160000
                ? 'この実行の差分表示量の上限に達しました。'
                : 'バックエンドが変更を通知しましたが、比較用の内容は取得できませんでした。');
          }
          if (file.truncated && !file.omittedReason)
            file.omittedReason = '差分が8,000文字を超えたため、先頭部分のみ表示しています。';
          diffBytes += file.diff?.length ?? 0;
          report.files.push(file);
        }
      } catch {
        report.partial = true;
      } finally {
        release();
        before.clear();
        confirmed.clear();
      }
      report.partial ||= partial;
      return report;
    },
  };
}

/** Normalize only successful Codex-native completion events. */
export function codexFileChanges(item: Record<string, unknown>): BackendFileChange[] {
  if (
    !['file_change', 'fileChange'].includes(String(item.type)) ||
    item.status !== 'completed' ||
    !Array.isArray(item.changes)
  )
    return [];
  return item.changes.slice(0, MAX_FILES + 1).flatMap((entry): BackendFileChange[] => {
    if (!entry || typeof entry !== 'object') return [];
    const change = entry as Record<string, unknown>;
    const kind =
      typeof change.kind === 'string'
        ? change.kind
        : (change.kind as Record<string, unknown> | undefined)?.type;
    const operation =
      kind === 'add'
        ? 'added'
        : kind === 'delete'
          ? 'deleted'
          : kind === 'update'
            ? 'modified'
            : undefined;
    if (typeof change.path !== 'string' || !operation) return [];
    const move =
      typeof change.kind === 'object' && change.kind
        ? (change.kind as Record<string, unknown>).move_path
        : undefined;
    if (typeof move === 'string')
      return [
        { path: change.path, operation: 'deleted' },
        { path: move, operation: 'added' },
      ];
    return [
      {
        path: change.path,
        operation,
        diff: typeof change.diff === 'string' ? change.diff : undefined,
      },
    ];
  });
}
export function fileChangeSummary(report: FileChangeReport): string {
  const files = report.files.map(
    (file) =>
      `${file.operation === 'added' ? '追加' : file.operation === 'deleted' ? '削除' : '変更'} ${file.path.replace(/[\r\n`<>]/g, '_')} ${file.added === undefined ? '（差分省略）' : `+${file.added} −${file.deleted}${file.approximate ? '（概算）' : ''}`}`
  );
  return [
    '実行中に確認したファイル変更',
    ...files,
    ...(report.concurrent ? ['同じ作業フォルダで他の実行も進行していました。'] : []),
    ...(report.partial ? ['一部のみ確認（走査上限または読み取り不可）。'] : []),
  ].join('\n');
}
