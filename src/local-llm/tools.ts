/**
 * ローカルLLM用ビルトインツール（exec, read, web_fetch）
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { promisify } from 'util';
import type { LLMTool, ToolContext, ToolResult, ToolHandler } from './types.js';
import { getSafeEnv } from '../safe-env.js';

// child_process を遅延ロード（テストのvi.mockとの衝突を避けるため）
async function shellExec(
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const cp = await import('child_process');
  const execAsync = promisify(cp.exec);
  return execAsync(command, options);
}

// --- Configurable timeouts ---

const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS ?? '120000', 10);
const WEB_FETCH_TIMEOUT_MS = parseInt(process.env.WEB_FETCH_TIMEOUT_MS ?? '15000', 10);

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
        env: getSafeEnv(),
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

    const resolved = filePath.startsWith('/')
      ? filePath
      : resolve(join(context.workspace, filePath));
    if (!existsSync(resolved))
      return { success: false, output: '', error: `File not found: ${resolved}` };

    const stat = statSync(resolved);
    if (!stat.isFile()) return { success: false, output: '', error: `Not a file: ${resolved}` };
    if (stat.size > 512 * 1024)
      return { success: false, output: '', error: `File too large: ${stat.size} bytes` };

    // JSONファイルが大きい場合は警告（profile_tool.py等のCLI経由を推奨）
    if (resolved.endsWith('.json') && stat.size > 5 * 1024)
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

// --- Registry ---

const ALL_TOOLS: ToolHandler[] = [execToolHandler, readToolHandler, webFetchToolHandler];

export function getBuiltinTools(): ToolHandler[] {
  return ALL_TOOLS;
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
  const handler = ALL_TOOLS.find((t) => t.name === name);
  if (!handler) return { success: false, output: '', error: `Unknown tool: ${name}` };

  try {
    return await handler.execute(args, context);
  } catch (err) {
    return { success: false, output: '', error: `Tool error: ${String(err)}` };
  }
}
