const URI_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const EXPLICIT_URI_SCHEME = /^(?:https?|mailto|tel|data|javascript|vbscript|file):/i;

export interface WorkspaceLinkTarget {
  path: string;
  line?: number;
  column?: number;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function positiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function workspaceTargetFromHref(href: string): WorkspaceLinkTarget | undefined {
  if (
    href.startsWith('#') ||
    href.startsWith('?') ||
    href.startsWith('//') ||
    href === '/' ||
    /^\/(?:monitor|schedules)(?:$|[/?#])/.test(href) ||
    /^\/workspace(?:$|[?#])/.test(href) ||
    /^\/(?:api|assets)\//.test(href) ||
    EXPLICIT_URI_SCHEME.test(href)
  ) {
    return undefined;
  }

  let path = decodePath(href);
  let line: number | undefined;
  let column: number | undefined;
  const hashLocation = /#L(\d+)(?::(\d+))?$/.exec(path);
  if (hashLocation) {
    line = positiveInteger(hashLocation[1]);
    column = positiveInteger(hashLocation[2]);
    path = path.slice(0, hashLocation.index);
  } else {
    const suffixLocation = /:(\d+)(?::(\d+))?$/.exec(path);
    if (suffixLocation) {
      line = positiveInteger(suffixLocation[1]);
      column = positiveInteger(suffixLocation[2]);
      path = path.slice(0, suffixLocation.index);
    }
  }

  if (path.startsWith('/workspace/')) path = path.slice('/workspace/'.length);
  path = path.replace(/^\.\//, '');
  if (URI_SCHEME.test(path) && !WINDOWS_ABSOLUTE_PATH.test(path)) return undefined;
  if (!path) return undefined;
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function workspaceViewerUrl(target: WorkspaceLinkTarget): string {
  const params = new URLSearchParams({ path: target.path });
  if (target.line) params.set('line', String(target.line));
  if (target.column) params.set('column', String(target.column));
  return `/workspace?${params.toString()}`;
}

export function workspaceTargetFromSearch(search: string): WorkspaceLinkTarget | undefined {
  const params = new URLSearchParams(search);
  const path = params.get('path')?.trim();
  if (!path) return undefined;
  const line = positiveInteger(params.get('line') ?? undefined);
  const column = positiveInteger(params.get('column') ?? undefined);
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function workspaceParentPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

export function lineSelection(
  content: string,
  requestedLine: number,
  requestedColumn = 1
): { start: number; end: number; line: number; column: number } {
  const lines = content.split('\n');
  const line = Math.min(Math.max(1, requestedLine), Math.max(1, lines.length));
  const lineText = lines[line - 1] ?? '';
  const column = Math.min(Math.max(1, requestedColumn), lineText.length + 1);
  let lineStart = 0;
  for (let index = 0; index < line - 1; index += 1) lineStart += (lines[index]?.length ?? 0) + 1;
  const start = lineStart + column - 1;
  return { start, end: lineStart + lineText.length, line, column };
}
