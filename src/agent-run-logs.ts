import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { AgentRun } from './agent-runs.js';
import { resolveGrokSessionFile } from './grok-model-evidence.js';
import { maskHomePath, maskUrlSecrets } from './tool-trajectory/sanitize.js';

const MAX_BYTES = 32 * 1024 * 1024;
type Row = Record<string, unknown>;
export interface LogEvent {
  kind: 'tool' | 'retry' | 'error';
  tool?: string;
  status?: string;
  queries: string[];
  urls: string[];
  error?: string;
  source: string;
  line: number;
}
function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}
function safe(value: unknown): string {
  if (typeof value !== 'string') return '';
  return maskUrlSecrets(maskHomePath(value))
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[REDACTED]'
    )
    .slice(0, 500);
}
/** Only input fields are evidence of actions; search-result URLs are not visited URLs. */
function inputs(args: unknown): { queries: string[]; urls: string[] } {
  const queries = new Set<string>();
  const urls = new Set<string>();
  function visit(value: unknown, key = '', depth = 0) {
    if (depth > 8 || /token|password|secret|cookie|authorization|key/i.test(key)) return;
    if (typeof value === 'string') {
      if (/^(q|query|search_query)$/.test(key) && queries.size < 10) queries.add(safe(value));
      if (/^(url|urls|ref_id)$/.test(key) && /^https?:\/\//.test(value) && urls.size < 10)
        urls.add(safe(value));
      // Shell commands may contain URLs, but cannot prove that they were fetched.
      // Do not guess queries/URLs from arbitrary code, results, or page content.
    } else if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item) => visit(item, key, depth + 1));
    } else {
      for (const [k, v] of Object.entries(object(value)).slice(0, 30)) {
        if (!/^(sources|results|content|output)$/.test(k)) visit(v, k, depth + 1);
      }
    }
  }
  visit(args);
  return { queries: [...queries], urls: [...urls] };
}
export function logPageOptions(flags: Record<string, string>) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = flags[name];
    if (raw === undefined) return fallback;
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min ||
      Number(raw) > max
    )
      throw new Error(`--${name} must be an integer from ${min} to ${max}`);
    return Number(raw);
  };
  return {
    offset: integer('offset', 0, 0, Number.MAX_SAFE_INTEGER),
    limit: integer('limit', 20, 1, 100),
  };
}

/** Shared read-only inspection for standalone Agent runs and Team members. */
export async function inspectAgentRunLogs(
  run: AgentRun,
  options: { offset: number; limit: number; grokHome?: string }
) {
  const warnings: string[] = [];
  const sources: string[] = [];
  const events: LogEvent[] = [];
  const read = async (file: string, native: boolean) => {
    const parsed: LogEvent[] = [];
    try {
      const handle = await open(file, 'r');
      let text: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES) {
          warnings.push(`${file}: unavailable or larger than 32 MiB`);
          return parsed;
        }
        // Bound the read even if the file grows while the request is running.
        const buffer = Buffer.alloc(info.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      sources.push(file);
      let malformed = 0;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let row: Row;
        try {
          row = object(JSON.parse(lines[i]));
        } catch {
          malformed++;
          continue;
        }
        if (native) {
          if (row.type !== 'backend_tool_call') continue;
          const kind = object(row.kind);
          const action = object(kind.action);
          if (typeof action.type !== 'string') continue;
          parsed.push({
            kind: 'tool',
            tool: safe(action.type),
            status: safe(kind.status) || 'unknown',
            ...inputs(action),
            source: file,
            line: i + 1,
          });
        } else {
          if (row.appSessionId !== run.appSessionId) continue;
          if (row.kind === 'tool_call' && typeof row.tool_name === 'string') {
            parsed.push({
              kind: 'tool',
              tool: safe(row.tool_name),
              status: safe(row.status) || 'unknown',
              ...inputs(row.args_sanitized),
              error: safe(row.error_truncated) || undefined,
              source: file,
              line: i + 1,
            });
          } else if (row.kind === 'runner_event' && row.event === 'session_retry') {
            parsed.push({ kind: 'retry', queries: [], urls: [], source: file, line: i + 1 });
          }
        }
      }
      if (malformed) warnings.push(`${file}: ${malformed} malformed/partial lines skipped`);
    } catch {
      warnings.push(`${file}: log not found or unreadable`);
    }
    return parsed;
  };
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(run.appSessionId)) {
    const directory = join(run.workspacePath, 'logs', 'tool-trajectory');
    const candidate = join(directory, `${run.appSessionId}.jsonl`);
    try {
      const [root, file] = await Promise.all([realpath(directory), realpath(candidate)]);
      if (!file.startsWith(root + sep))
        warnings.push('trajectory symlink outside log directory rejected');
      else events.push(...(await read(file, false)));
    } catch {
      warnings.push('tool trajectory not found or unreadable');
    }
  } else warnings.push('invalid app session ID');
  if (run.backend === 'grok' && run.providerSessionId) {
    const file = await resolveGrokSessionFile(
      {
        providerSessionId: run.providerSessionId,
        cwd: run.workspacePath,
        grokHome: options.grokHome,
      },
      'chat_history.jsonl'
    );
    if (file) {
      const native = await read(file, true);
      if (native.length) {
        // Native Grok web actions include input detail; do not count timing traces twice.
        events.splice(
          0,
          events.length,
          ...events.filter(
            (event) => event.kind !== 'tool' || !/web|search|open_page/i.test(event.tool ?? '')
          ),
          ...native
        );
      }
    } else warnings.push('Grok native log not found, unsafe, or larger than 32 MiB');
  }
  const counts: Record<string, number> = Object.create(null);
  let errors = 0;
  let retries = 0;
  for (const event of events) {
    if (event.kind === 'tool') counts[event.tool!] = (counts[event.tool!] ?? 0) + 1;
    if (event.error || /^(error|failed|failure)$/.test(event.status ?? '')) errors++;
    if (event.kind === 'retry') retries++;
  }
  const end = options.offset + options.limit;
  return {
    id: run.id,
    agentId: run.agentId,
    backend: run.backend,
    model: run.model,
    appSessionId: run.appSessionId,
    providerSessionId: run.providerSessionId,
    status: run.status,
    runError: safe(run.error) || undefined,
    sources,
    counts,
    errors,
    retries,
    totalEvents: events.length,
    offset: options.offset,
    nextOffset: end < events.length ? end : null,
    events: events.slice(options.offset, end),
    warnings,
    coverage:
      'Recorded tools only. Missing input fields, shell-internal actions and unrecorded retries are unknown. Grok native history covers the provider session.',
  };
}
