import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  CopilotClient,
  RuntimeConnection,
  type ModelInfo as CopilotModelInfo,
} from '@github/copilot-sdk';
import {
  extractAntigravityOutputError,
  reportsUnsupportedOutputFormat,
} from './antigravity-output.js';
import { inferEffortFromModelName } from './backend-effort.js';
import type { AgentBackend } from './config.js';
import { resolveExtensionAgentBackend } from './extensions.js';
import { getSafeEnv } from './safe-env.js';
import { configuredBackendCommand } from './setup/backend-executable.js';

const MODEL_DISCOVERY_TIMEOUT_MS = 5000;

export interface BackendModel {
  id: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  supportedEfforts?: string[];
}

export interface BackendModelDiscovery {
  backend: AgentBackend;
  source: string;
  status: 'available' | 'unsupported' | 'unavailable';
  models: BackendModel[];
  message?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type ModelDiscoveryCommandRunner = (
  command: string,
  args: string[],
  input?: string
) => Promise<CommandResult>;

export type CopilotModelLister = () => Promise<CopilotModelInfo[]>;

const STANDARD_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

function standardEfforts(values: string[]): string[] {
  return values.filter((value) => STANDARD_EFFORTS.has(value));
}

function hasAuthenticationError(result: CommandResult): boolean {
  return /not authenticated|not logged in|sign.?in required|login required/i.test(
    `${result.stdout}\n${result.stderr}`
  );
}

function runCommand(command: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env = getSafeEnv();
    const child = spawn(configuredBackendCommand(command, env), args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`${command} model discovery timed out`));
      }
    }, MODEL_DISCOVERY_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      // Codex app-server stays alive while stdin is open. Once the requested
      // response arrives, resolve and stop this short-lived discovery process.
      if (input !== undefined && parseCodexModels(stdout).length > 0 && !settled) {
        clearTimeout(timer);
        settled = true;
        child.kill();
        resolve({ stdout, stderr });
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin?.on('error', () => {
        // Spawn/early-exit errors are reported by the child process handlers.
      });
      child.stdin?.write(input);
    }
  });
}

export function parseCodexModels(output: string): BackendModel[] {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as {
        id?: number;
        result?: {
          data?: Array<{
            id?: string;
            displayName?: string;
            description?: string;
            isDefault?: boolean;
            supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
          }>;
        };
      };
      if (event.id !== 2 || !Array.isArray(event.result?.data)) continue;
      return event.result.data
        .filter((model): model is typeof model & { id: string } => Boolean(model.id))
        .map((model) => ({
          id: model.id,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
          supportedEfforts: model.supportedReasoningEfforts
            ?.map((effort) => effort.reasoningEffort)
            .filter((effort): effort is string => Boolean(effort)),
        }));
    } catch {
      // app-server notifications and non-JSON diagnostics are irrelevant here.
    }
  }
  return [];
}

export function parseCursorModels(output: string): BackendModel[] {
  const models: BackendModel[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^([^\s]+)\s+-\s+(.+)$/);
    if (!match) continue;
    const [, id, rawName] = match;
    const isDefault = /\(.*default.*\)$/i.test(rawName);
    const displayName = rawName.replace(/\s*\([^)]*default[^)]*\)\s*$/i, '').trim();
    const effort = inferEffortFromModelName(id, displayName);
    models.push({
      id,
      displayName,
      isDefault,
      // Cursor's catalog exposes many effort-specific model IDs. Do not offer a
      // second, incompatible effort for those IDs, and never parameterize Auto.
      supportedEfforts: id === 'auto' ? [] : effort ? [effort] : undefined,
    });
  }
  const effortByFamily = new Map<string, Set<string>>();
  const familyOf = (id: string) =>
    id.replace(/-fast$/, '').replace(/-(?:extra-high|xhigh|minimal|medium|high|low|none|max)$/, '');
  for (const model of models) {
    const effort = model.supportedEfforts?.[0];
    if (!effort) continue;
    const family = familyOf(model.id);
    const efforts = effortByFamily.get(family) ?? new Set<string>();
    efforts.add(effort);
    effortByFamily.set(family, efforts);
  }
  return models.map((model) => {
    if (model.supportedEfforts !== undefined) return model;
    const familyEfforts = effortByFamily.get(familyOf(model.id));
    return {
      ...model,
      supportedEfforts: familyEfforts ? [...new Set([...familyEfforts, 'medium'])] : [],
    };
  });
}

export function parseGrokModels(output: string): BackendModel[] {
  const models: BackendModel[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^[*-]\s+([^\s]+)(?:\s+\(default\))?$/i);
    if (!match) continue;
    models.push({ id: match[1], isDefault: /\(default\)$/i.test(line.trim()) });
  }
  return models;
}

export function applyGrokModelMetadata(models: BackendModel[], output: string): BackendModel[] {
  const parsed = JSON.parse(output) as {
    models?: Record<
      string,
      {
        info?: {
          supports_reasoning_effort?: boolean;
          reasoning_efforts?: Array<{ id?: string; value?: string }>;
        };
      }
    >;
  };
  return models.map((model) => {
    const info = parsed.models?.[model.id]?.info;
    if (!info) return model;
    return {
      ...model,
      supportedEfforts:
        info.supports_reasoning_effort === true
          ? standardEfforts(
              (info.reasoning_efforts ?? []).flatMap((effort) =>
                effort.value || effort.id ? [effort.value || effort.id || ''] : []
              )
            )
          : [],
    };
  });
}

export function parseOpenCodeModels(output: string): BackendModel[] {
  const lines = output.split('\n');
  const models: BackendModel[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index].trim();
    if (!id || id.startsWith('{') || !id.includes('/')) continue;
    let metadata: { name?: string; variants?: Record<string, unknown> } | undefined;
    const jsonLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (jsonLines.length === 0 && !line.trim().startsWith('{')) break;
      jsonLines.push(line);
      try {
        metadata = JSON.parse(jsonLines.join('\n')) as typeof metadata;
        index = cursor;
        break;
      } catch {
        // Pretty-printed model metadata spans multiple lines.
      }
    }
    models.push({
      id,
      displayName: metadata?.name,
      supportedEfforts: metadata
        ? standardEfforts(Object.keys(metadata.variants ?? {}))
        : undefined,
    });
  }
  return models;
}

interface AntigravityModelsCommand {
  name?: string;
  data?: {
    models?: Array<{ id?: string; label?: string }>;
  };
}

function parseAntigravityModelsCommand(value: unknown): BackendModel[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as {
    command?: AntigravityModelsCommand;
    result?: { command?: AntigravityModelsCommand };
  };
  const command = envelope.command ?? envelope.result?.command;
  if (command?.name !== 'models' || !Array.isArray(command.data?.models)) return undefined;

  return command.data.models
    .filter((model): model is { id: string; label?: string } =>
      Boolean(model && typeof model === 'object' && typeof model.id === 'string' && model.id.trim())
    )
    .map((model) => {
      const id = model.id.trim();
      const displayName = model.label?.trim() || undefined;
      const effort = inferEffortFromModelName(id, displayName);
      return { id, displayName, supportedEfforts: effort ? [effort] : undefined };
    });
}

export function parseAntigravityModels(output: string): BackendModel[] {
  for (const candidate of [output, ...output.split('\n')]) {
    try {
      const models = parseAntigravityModelsCommand(JSON.parse(candidate.trim()));
      if (models) return models;
    } catch {
      // Fall through to the plain-text formats used by older agy versions.
    }
  }

  return output.split('\n').flatMap((line): BackendModel[] => {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('{') ||
      /^(available models|usage|you are not authenticated|error:)/i.test(trimmed)
    ) {
      return [];
    }
    const [id, ...labelParts] = trimmed.split('\t');
    const displayName = labelParts.join('\t').trim();
    const normalizedId = id.trim();
    const normalizedName = displayName || undefined;
    const effort = inferEffortFromModelName(normalizedId, normalizedName);
    return [
      {
        id: normalizedId,
        displayName: normalizedName,
        supportedEfforts: effort ? [effort] : undefined,
      },
    ];
  });
}

async function listCopilotModels(): Promise<CopilotModelInfo[]> {
  const env = getSafeEnv();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const configuredCommand = configuredBackendCommand('copilot', env);
  const executable = isAbsolute(configuredCommand)
    ? configuredCommand
    : (childEnv.PATH?.split(delimiter)
        .map((directory) => join(directory, configuredCommand))
        .find((candidate) => existsSync(candidate)) ?? configuredCommand);
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: executable,
      env: childEnv,
    }),
    logLevel: 'none',
  });
  try {
    await client.start();
    return await client.listModels();
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function isUnsupportedAntigravityOutputFormat(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return reportsUnsupportedOutputFormat(detail);
}

async function discoverLocalLlmModels(fetchFn: typeof fetch): Promise<BackendModelDiscovery> {
  const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const ollama = await fetchFn(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (ollama.ok) {
      const data = (await ollama.json()) as { models?: Array<{ name?: string }> };
      const models = (data.models ?? [])
        .filter((model): model is { name: string } => Boolean(model.name))
        .map((model) => ({ id: model.name }));
      if (models.length > 0) {
        return { backend: 'local-llm', source: 'Ollama /api/tags', status: 'available', models };
      }
    }
  } catch {
    // Try the OpenAI-compatible endpoint below.
  }

  try {
    const compatible = await fetchFn(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (compatible.ok) {
      const data = (await compatible.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? [])
        .filter((model): model is { id: string } => Boolean(model.id))
        .map((model) => ({ id: model.id }));
      if (models.length > 0) {
        return {
          backend: 'local-llm',
          source: 'OpenAI-compatible /v1/models',
          status: 'available',
          models,
        };
      }
    }
  } catch {
    // Report the combined failure below.
  }

  return {
    backend: 'local-llm',
    source: `${baseUrl}/api/tags or /v1/models`,
    status: 'unavailable',
    models: [],
    message: 'Local LLMサーバーからモデル一覧を取得できませんでした',
  };
}

export async function discoverBackendModels(
  backend: AgentBackend,
  options: {
    runner?: ModelDiscoveryCommandRunner;
    fetchFn?: typeof fetch;
    copilotModelLister?: CopilotModelLister;
    grokModelMetadataReader?: () => Promise<string>;
  } = {}
): Promise<BackendModelDiscovery> {
  const runner = options.runner ?? runCommand;
  let antigravitySource = 'agy --output-format json models';
  try {
    if (backend === 'claude-code') {
      return {
        backend,
        source: 'Claude Code CLI',
        status: 'unsupported',
        models: [],
        message: 'CLIに独立した機械可読モデル一覧コマンドがありません',
      };
    }
    const extensionBackend = resolveExtensionAgentBackend(backend);
    if (extensionBackend) {
      return {
        backend,
        source: extensionBackend.displayName,
        status: 'unsupported',
        models: [],
        message: '拡張バックエンドはモデル一覧を提供していません',
      };
    }
    if (backend === 'local-llm') {
      return discoverLocalLlmModels(options.fetchFn ?? fetch);
    }
    if (backend === 'github-copilot') {
      const models = await (options.copilotModelLister ?? listCopilotModels)();
      if (models.length === 0) throw new Error('Copilot SDK listModels returned no models');
      return {
        backend,
        source: 'GitHub Copilot SDK listModels',
        status: 'available',
        models: models.map((model) => ({
          id: model.id,
          displayName: model.name,
          isDefault: model.id === 'auto',
          supportedEfforts:
            model.capabilities?.supports?.reasoningEffort === true
              ? standardEfforts(model.supportedReasoningEfforts ?? [])
              : [],
        })),
      };
    }
    if (backend === 'codex') {
      const input = [
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'xangi', version: '0.1.0' } },
        }),
        JSON.stringify({
          id: 2,
          method: 'model/list',
          params: { limit: 100, includeHidden: false },
        }),
        '',
      ].join('\n');
      const { stdout } = await runner('codex', ['app-server', '--stdio'], input);
      const models = parseCodexModels(stdout);
      if (models.length === 0) throw new Error('model/list returned no models');
      return { backend, source: 'codex app-server model/list', status: 'available', models };
    }
    if (backend === 'cursor') {
      const result = await runner('cursor-agent', ['models']);
      if (hasAuthenticationError(result)) throw new Error('Cursor CLI is not authenticated');
      const { stdout } = result;
      const models = parseCursorModels(stdout);
      if (models.length === 0) throw new Error('cursor-agent models returned no models');
      return { backend, source: 'cursor-agent models', status: 'available', models };
    }
    if (backend === 'grok') {
      const result = await runner('grok', ['models']);
      if (hasAuthenticationError(result)) throw new Error('Grok CLI is not authenticated');
      const { stdout } = result;
      let models = parseGrokModels(stdout);
      if (models.length === 0) throw new Error('grok models returned no models');
      let source = 'grok models';
      try {
        const readMetadata =
          options.grokModelMetadataReader ??
          (() => {
            const env = getSafeEnv();
            const grokHome = process.env.GROK_HOME || (env.HOME ? join(env.HOME, '.grok') : '');
            if (!grokHome) throw new Error('Grok home is unavailable');
            return readFile(join(grokHome, 'models_cache.json'), 'utf8');
          });
        models = applyGrokModelMetadata(models, await readMetadata());
        source = 'grok models + CLI model cache';
      } catch {
        // Older Grok CLI versions may not keep structured model metadata.
      }
      return { backend, source, status: 'available', models };
    }
    if (backend === 'opencode') {
      const { stdout } = await runner('opencode', ['models', '--verbose']);
      const models = parseOpenCodeModels(stdout);
      if (models.length === 0) throw new Error('opencode models returned no models');
      return { backend, source: 'opencode models --verbose', status: 'available', models };
    }
    let result: CommandResult;
    try {
      result = await runner('agy', ['--output-format', 'json', 'models']);
    } catch (error) {
      if (!isUnsupportedAntigravityOutputFormat(error)) throw error;
      antigravitySource = 'agy models (legacy fallback)';
      result = await runner('agy', ['models']);
    }
    if (hasAuthenticationError(result)) throw new Error('Antigravity CLI is not authenticated');
    const { stdout } = result;
    const outputError = extractAntigravityOutputError(stdout);
    if (outputError) throw new Error(outputError);
    const models = parseAntigravityModels(stdout);
    if (models.length === 0) throw new Error('agy models returned no models');
    return { backend, source: antigravitySource, status: 'available', models };
  } catch (error) {
    return {
      backend,
      source:
        backend === 'codex'
          ? 'codex app-server model/list'
          : backend === 'cursor'
            ? 'cursor-agent models'
            : backend === 'grok'
              ? 'grok models'
              : backend === 'opencode'
                ? 'opencode models --verbose'
                : backend === 'github-copilot'
                  ? 'GitHub Copilot SDK listModels'
                  : antigravitySource,
      status: 'unavailable',
      models: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatBackendModels(discovery: BackendModelDiscovery): string {
  const title = discovery.backend;
  if (discovery.status !== 'available') {
    const label = discovery.status === 'unsupported' ? '取得非対応' : '取得失敗';
    return `### ${title}\n- ${label}: ${discovery.message ?? discovery.source}`;
  }

  const lines = [`### ${title}`, `- 取得元: ${discovery.source}`];
  if (discovery.models.length === 0) {
    lines.push('- 利用可能なモデルなし');
    return lines.join('\n');
  }
  for (const model of discovery.models) {
    const name =
      model.displayName && model.displayName !== model.id ? ` — ${model.displayName}` : '';
    const defaultLabel = model.isDefault ? ' (default)' : '';
    const efforts = model.supportedEfforts?.length
      ? ` [effort: ${model.supportedEfforts.join(', ')}]`
      : '';
    lines.push(`- \`${model.id}\`${name}${defaultLabel}${efforts}`);
  }
  return lines.join('\n');
}
