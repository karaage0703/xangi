/**
 * ローカルLLM用ビルトインツール（exec, read, write, edit, glob, grep, web_fetch）
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'fs';
import { promises as fsp } from 'fs';
import { resolve, join, dirname, relative, sep } from 'path';
import { promisify } from 'util';
import type { LLMTool, ToolContext, ToolResult, ToolHandler } from './types.js';
import { getSafeEnv } from '../safe-env.js';
import { getGitHubEnv } from '../github-auth.js';

// child_process を遅延ロード（テストのvi.mockとの衝突を避けるため）
async function shellExec(
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const cp = await import('child_process');
  const execAsync = promisify(cp.exec);
  return execAsync(command, options);
}

// --- Configurable limits ---

const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS ?? '120000', 10);
const WEB_FETCH_TIMEOUT_MS = parseInt(process.env.WEB_FETCH_TIMEOUT_MS ?? '15000', 10);
const READ_MAX_BYTES = parseInt(process.env.LOCAL_LLM_READ_MAX_BYTES ?? String(512 * 1024), 10);
const READ_JSON_MAX_BYTES = parseInt(
  process.env.LOCAL_LLM_READ_JSON_MAX_BYTES ?? String(5 * 1024),
  10
);
const WRITE_MAX_BYTES = parseInt(process.env.LOCAL_LLM_WRITE_MAX_BYTES ?? String(512 * 1024), 10);

/**
 * パスをワークスペース基準で解決し、ワークスペース外（../traversal や絶対パス経由）に
 * 出るパスは Error を投げる。ツール側で try/catch して ToolResult のエラーに変換する。
 */
function resolveWorkspacePath(filePath: string, workspace: string): string {
  const resolved = filePath.startsWith('/') ? filePath : resolve(join(workspace, filePath));
  const rel = relative(workspace, resolved);
  if (rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error(`Path outside workspace: ${filePath}`);
  }
  return resolved;
}

// --- exec tool ---

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bformat\s+[a-z]:/i,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bsudo\s+rm\s+-rf/,
  /:\(\)\s*\{.*\|\s*:\s*&\s*\}/, // fork bomb
];

const execToolHandler: ToolHandler = {
  name: 'exec',
  description: 'Execute a shell command and return its output.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
    },
    required: ['command'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = (args.cwd as string | undefined) ?? context.workspace;

    if (!command || typeof command !== 'string') {
      return { success: false, output: '', error: 'command must be a non-empty string' };
    }
    if (BLOCKED_PATTERNS.some((p) => p.test(command))) {
      return { success: false, output: '', error: `Command blocked for safety: ${command}` };
    }

    try {
      const { stdout, stderr } = await shellExec(command, {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...getSafeEnv(), ...getGitHubEnv(getSafeEnv()) },
      });
      return { success: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim(),
        error: e.message ?? String(err),
      };
    }
  },
};

// --- read tool ---

const readToolHandler: ToolHandler = {
  name: 'read',
  description: 'Read the contents of a file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (absolute or relative to workspace)' },
    },
    required: ['path'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = args.path as string;
    if (!filePath) return { success: false, output: '', error: 'path is required' };

    let resolved: string;
    try {
      resolved = resolveWorkspacePath(filePath, context.workspace);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
    if (!existsSync(resolved))
      return { success: false, output: '', error: `File not found: ${resolved}` };

    const stat = statSync(resolved);
    if (!stat.isFile()) return { success: false, output: '', error: `Not a file: ${resolved}` };
    if (stat.size > READ_MAX_BYTES)
      return { success: false, output: '', error: `File too large: ${stat.size} bytes` };

    // JSONファイルが大きい場合は警告（profile_tool.py等のCLI経由を推奨）
    if (resolved.endsWith('.json') && stat.size > READ_JSON_MAX_BYTES)
      return {
        success: false,
        output: '',
        error: `JSON file too large (${stat.size} bytes). Use a CLI tool to query specific entries instead of reading the entire file.`,
      };

    try {
      return { success: true, output: readFileSync(resolved, 'utf-8') };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

// --- write tool ---

const writeToolHandler: ToolHandler = {
  name: 'write',
  description:
    'Write content to a file. Creates parent directories if needed. Overwrites the file if it already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (absolute or relative to workspace)',
      },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const content = args.content as string;

    if (!filePath) return { success: false, output: '', error: 'path is required' };
    if (typeof content !== 'string')
      return { success: false, output: '', error: 'content must be a string' };

    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > WRITE_MAX_BYTES)
      return {
        success: false,
        output: '',
        error: `Content too large: ${byteLength} bytes (max ${WRITE_MAX_BYTES})`,
      };

    let resolved: string;
    try {
      resolved = resolveWorkspacePath(filePath, context.workspace);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }

    try {
      const parent = dirname(resolved);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return { success: true, output: `Wrote ${byteLength} bytes to ${resolved}` };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

// --- edit tool ---

const editToolHandler: ToolHandler = {
  name: 'edit',
  description:
    'Replace old_string with new_string in a file. By default, old_string must match exactly once; set replace_all=true to replace every occurrence.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (absolute or relative to workspace)',
      },
      old_string: { type: 'string', description: 'Exact text to find' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true;

    if (!filePath) return { success: false, output: '', error: 'path is required' };
    if (typeof oldString !== 'string' || oldString.length === 0)
      return { success: false, output: '', error: 'old_string must be a non-empty string' };
    if (typeof newString !== 'string')
      return { success: false, output: '', error: 'new_string must be a string' };
    if (oldString === newString)
      return { success: false, output: '', error: 'old_string and new_string must differ' };

    let resolved: string;
    try {
      resolved = resolveWorkspacePath(filePath, context.workspace);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
    if (!existsSync(resolved))
      return { success: false, output: '', error: `File not found: ${resolved}` };

    const stat = statSync(resolved);
    if (!stat.isFile()) return { success: false, output: '', error: `Not a file: ${resolved}` };
    if (stat.size > WRITE_MAX_BYTES)
      return { success: false, output: '', error: `File too large: ${stat.size} bytes` };

    let original: string;
    try {
      original = readFileSync(resolved, 'utf-8');
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }

    const occurrences = original.split(oldString).length - 1;
    if (occurrences === 0)
      return { success: false, output: '', error: 'old_string not found in file' };
    if (!replaceAll && occurrences > 1)
      return {
        success: false,
        output: '',
        error: `old_string matches ${occurrences} occurrences; provide a more specific string or set replace_all=true`,
      };

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);

    try {
      writeFileSync(resolved, updated, 'utf-8');
      return {
        success: true,
        output: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${resolved}`,
      };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

// --- glob tool ---

const GLOB_MAX_RESULTS = 500;
const DEFAULT_EXCLUDES = new Set(['node_modules', '.git', 'dist', '.next', '.cache']);

const globToolHandler: ToolHandler = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.{js,ts}"). Returns paths relative to the search directory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      cwd: {
        type: 'string',
        description: 'Directory to search in (defaults to workspace)',
      },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const cwdArg = args.cwd as string | undefined;

    if (!pattern || typeof pattern !== 'string')
      return { success: false, output: '', error: 'pattern must be a non-empty string' };

    let searchRoot: string;
    try {
      searchRoot = cwdArg ? resolveWorkspacePath(cwdArg, context.workspace) : context.workspace;
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }

    if (!existsSync(searchRoot))
      return { success: false, output: '', error: `Directory not found: ${searchRoot}` };

    try {
      const results: string[] = [];
      const iterator = fsp.glob(pattern, {
        cwd: searchRoot,
        exclude: (entry: string) => {
          const base = entry.split('/').pop() ?? entry;
          return DEFAULT_EXCLUDES.has(base);
        },
      } as Parameters<typeof fsp.glob>[1]);

      for await (const entry of iterator) {
        results.push(entry as string);
        if (results.length >= GLOB_MAX_RESULTS) break;
      }

      const truncated = results.length >= GLOB_MAX_RESULTS;
      const output = results.join('\n') + (truncated ? '\n... [truncated]' : '');
      return {
        success: true,
        output: results.length === 0 ? '(no matches)' : output,
      };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

// --- grep tool ---

const GREP_MAX_MATCHES = 200;
const GREP_MAX_LINE_LEN = 500;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2MB

function* walkFiles(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const grepToolHandler: ToolHandler = {
  name: 'grep',
  description:
    'Search file contents for a regular expression. Returns "path:line:matched_line" entries. Skips node_modules, .git, dist, etc.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      path: {
        type: 'string',
        description: 'File or directory to search (defaults to workspace)',
      },
      file_pattern: {
        type: 'string',
        description: 'Optional file extension filter (e.g. ".ts" or ".md")',
      },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match' },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const pathArg = args.path as string | undefined;
    const filePattern = args.file_pattern as string | undefined;
    const ignoreCase = args.ignore_case === true;

    if (!pattern || typeof pattern !== 'string')
      return { success: false, output: '', error: 'pattern must be a non-empty string' };

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (err) {
      return { success: false, output: '', error: `Invalid regex: ${String(err)}` };
    }

    let searchRoot: string;
    try {
      searchRoot = pathArg ? resolveWorkspacePath(pathArg, context.workspace) : context.workspace;
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }

    if (!existsSync(searchRoot))
      return { success: false, output: '', error: `Path not found: ${searchRoot}` };

    const stat = statSync(searchRoot);
    const matches: string[] = [];
    let truncated = false;

    const fileIter: Iterable<string> = stat.isFile()
      ? [searchRoot]
      : stat.isDirectory()
        ? walkFiles(searchRoot)
        : [];

    if (!stat.isFile() && !stat.isDirectory())
      return { success: false, output: '', error: `Not a file or directory: ${searchRoot}` };

    outer: for (const file of fileIter) {
      if (filePattern && !file.endsWith(filePattern)) continue;
      try {
        const fstat = statSync(file);
        if (fstat.size > GREP_MAX_FILE_BYTES) continue;
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const display =
              lines[i].length > GREP_MAX_LINE_LEN
                ? lines[i].slice(0, GREP_MAX_LINE_LEN) + '...'
                : lines[i];
            const rel = relative(context.workspace, file) || file;
            matches.push(`${rel}:${i + 1}:${display}`);
            if (matches.length >= GREP_MAX_MATCHES) {
              truncated = true;
              break outer;
            }
          }
        }
      } catch {
        // unreadable / binary file — skip silently
      }
    }

    if (matches.length === 0) return { success: true, output: '(no matches)' };

    const output = matches.join('\n') + (truncated ? '\n... [truncated]' : '');
    return { success: true, output };
  },
};

// --- web_fetch tool ---

const webFetchToolHandler: ToolHandler = {
  name: 'web_fetch',
  description: 'Fetch the content of a URL.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      method: {
        type: 'string',
        description: 'HTTP method (default: GET)',
        enum: ['GET', 'POST', 'PUT', 'DELETE'],
      },
      body: { type: 'string', description: 'Request body for POST/PUT (JSON string)' },
    },
    required: ['url'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;
    const method = (args.method as string) ?? 'GET';
    const body = args.body as string | undefined;

    if (!url) return { success: false, output: '', error: 'url is required' };

    try {
      new URL(url);
    } catch {
      return { success: false, output: '', error: `Invalid URL: ${url}` };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);

    try {
      const opts: RequestInit = {
        method,
        signal: controller.signal,
        headers: {
          'User-Agent': 'xangi/local-llm',
          Accept: 'text/html,application/json,text/plain,*/*',
        },
      };
      if (body && ['POST', 'PUT'].includes(method)) {
        opts.body = body;
        (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }

      const res = await fetch(url, opts);
      let text = await res.text();
      if (text.length > 100 * 1024) text = text.slice(0, 100 * 1024) + '\n... [truncated]';

      if (!res.ok) return { success: false, output: text, error: `HTTP ${res.status}` };
      return { success: true, output: text };
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError')
        return { success: false, output: '', error: 'Request timed out' };
      return { success: false, output: '', error: String(err) };
    } finally {
      clearTimeout(timeoutId);
    }
  },
};

// --- send_file tool ---

const sendFileToolHandler: ToolHandler = {
  name: 'send_file',
  description:
    'Send a local file to the user as a chat attachment. Use this whenever the user wants the actual file delivered (HTML/text/source/image/audio/PDF/zip etc.), instead of pasting its contents inline. The file is attached to the next chat message.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (absolute or relative to workspace).',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = args.path as string;
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, output: '', error: 'path must be a non-empty string' };
    }

    let resolved: string;
    try {
      resolved = resolveWorkspacePath(filePath, context.workspace);
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }

    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${resolved}` };
    }
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return { success: false, output: '', error: `Not a file: ${resolved}` };
    }

    // 結果に MEDIA: 形式でパスを含めると、runner 側の mediaPattern が拾って
    // 添付として送信される。LLM が応答テキストに MEDIA: を書く必要はない。
    return {
      success: true,
      output: `MEDIA:${resolved}\nQueued ${filePath} (${stat.size} bytes) as attachment.`,
    };
  },
};

// --- Registry ---

const ALL_TOOLS: ToolHandler[] = [
  execToolHandler,
  readToolHandler,
  writeToolHandler,
  editToolHandler,
  globToolHandler,
  grepToolHandler,
  sendFileToolHandler,
  webFetchToolHandler,
];

// 動的に追加されたツール（トリガー由来等）
let dynamicTools: ToolHandler[] = [];

export function getBuiltinTools(): ToolHandler[] {
  return ALL_TOOLS;
}

/**
 * 動的ツールを登録する（トリガーのツール化等）
 */
export function registerDynamicTools(tools: ToolHandler[]): void {
  dynamicTools = tools;
}

/**
 * 全ツール（ビルトイン + 動的）を取得
 */
export function getAllTools(): ToolHandler[] {
  return [...ALL_TOOLS, ...dynamicTools];
}

export function toLLMTools(handlers: ToolHandler[]): LLMTool[] {
  return handlers.map((h) => ({
    name: h.name,
    description: h.description,
    parameters: h.parameters,
  }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const allTools = getAllTools();
  const handler = allTools.find((t) => t.name === name);
  if (!handler) return { success: false, output: '', error: `Unknown tool: ${name}` };

  try {
    return await handler.execute(args, context);
  } catch (err) {
    return { success: false, output: '', error: `Tool error: ${String(err)}` };
  }
}
