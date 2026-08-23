import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import readline from 'node:readline/promises';
import type { AppLayout } from '../installer/types.js';

export interface OpenCodeSetupResult {
  configPath?: string;
  model?: string;
}

export interface OpenCodeSetupOptions {
  layout: AppLayout;
  question?: (prompt: string) => Promise<string>;
}

function parsePositiveInteger(value: string, fallback: number, label: string): number {
  const normalized = value.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}は正の整数で指定してください`);
  }
  return parsed;
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim() || 'http://127.0.0.1:8001/v1';
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenCode provider URLはhttpまたはhttpsで指定してください');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OpenCode provider URLへ認証情報・query・fragmentを含めないでください');
  }
  return url.href.replace(/\/$/, '');
}

function normalizeModelId(value: string): string {
  const model = value.trim();
  if (!model || model.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new Error('OpenCode model IDを英数字、.、_、:、-で指定してください');
  }
  return model;
}

export function buildOpenCodeCompatibleConfig(options: {
  baseUrl: string;
  modelId: string;
  context: number;
  output: number;
}): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    provider: {
      'xangi-local': {
        npm: '@ai-sdk/openai-compatible',
        name: 'xangi OpenAI-compatible provider',
        options: {
          baseURL: options.baseUrl,
          apiKey: 'not-needed',
        },
        models: {
          [options.modelId]: {
            name: options.modelId,
            limit: {
              context: options.context,
              output: options.output,
            },
            variants: {
              low: { reasoningEffort: 'low' },
              medium: { reasoningEffort: 'medium' },
              high: { reasoningEffort: 'high' },
              max: { reasoningEffort: 'high' },
            },
          },
        },
      },
    },
  };
}

async function writeConfig(path: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function configureOpenCodeSetup(
  options: OpenCodeSetupOptions
): Promise<OpenCodeSetupResult> {
  let terminal: readline.Interface | undefined;
  const question =
    options.question ??
    (async (prompt: string) => {
      terminal ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      return terminal.question(prompt);
    });

  try {
    const mode = (
      await question(
        'OpenCodeの設定を選んでください（1: 既存設定・認証を使う、2: OpenAI互換ローカルLLM）[1]: '
      )
    ).trim();
    if (!mode || mode === '1') return {};
    if (mode !== '2') throw new Error('OpenCodeの設定は1または2を選んでください');

    const baseUrl = normalizeBaseUrl(
      await question('OpenAI互換APIのbase URL [http://127.0.0.1:8001/v1]: ')
    );
    const modelId = normalizeModelId(await question('OpenCodeで使うmodel ID: '));
    const context = parsePositiveInteger(
      await question('context上限 [262144]: '),
      262_144,
      'context上限'
    );
    const output = parsePositiveInteger(
      await question('output token上限 [8192]: '),
      8192,
      'output token上限'
    );
    if (output > context) throw new Error('output token上限はcontext上限以下にしてください');

    const configPath = join(options.layout.configDir, 'opencode.json');
    await writeConfig(
      configPath,
      buildOpenCodeCompatibleConfig({ baseUrl, modelId, context, output })
    );
    return { configPath, model: `xangi-local/${modelId}` };
  } finally {
    terminal?.close();
  }
}
