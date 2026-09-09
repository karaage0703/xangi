import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { ProviderModels } from './provider-model.js';
import { normalizeModelId } from './model-execution.js';

/** Native export contract: https://opencode.ai/docs/cli#export.
 * Assistant metadata fields are defined by @opencode-ai/sdk (MIT), not response text.
 */
export function modelsFromOpenCodeExport(
  payload: unknown,
  sessionId: string,
  startedAt: number,
  finishedAt: number,
  cwd?: string
): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = payload as { info?: { id?: unknown }; messages?: unknown };
  if (data.info?.id !== sessionId || !Array.isArray(data.messages)) return [];
  const models = new ProviderModels();
  const transitions: string[] = [];
  for (const message of data.messages) {
    if (!message || typeof message !== 'object') continue;
    const info = (message as { info?: Record<string, unknown> }).info;
    if (!info || info.role !== 'assistant' || info.sessionID !== sessionId || info.summary)
      continue;
    const time = info.time as { created?: unknown } | undefined;
    const path = info.path as { cwd?: unknown } | undefined;
    if (typeof time?.created !== 'number' || time.created < startedAt || time.created > finishedAt)
      continue;
    if (cwd && (typeof path?.cwd !== 'string' || resolve(path.cwd) !== resolve(cwd))) continue;
    if (typeof info.providerID !== 'string' || typeof info.modelID !== 'string') continue;
    if (!info.providerID.trim() || !info.modelID.trim()) continue;
    if (!normalizeModelId(info.modelID) || !normalizeModelId(info.providerID)) continue;
    const model = `${info.providerID}/${info.modelID}`;
    models.add(model);
    if (models.result().model === model && transitions.at(-1) !== model) transitions.push(model);
  }
  return transitions;
}

export async function readOpenCodeTurnModels(options: {
  command: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  // A missing ID must never launch the interactive session picker.
  if (!/^[a-zA-Z0-9_-]+$/.test(options.sessionId)) return [];
  return new Promise((resolveModels) => {
    execFile(
      options.command,
      ['export', options.sessionId],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: 5_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolveModels([]);
          return;
        }
        try {
          resolveModels(
            modelsFromOpenCodeExport(
              JSON.parse(stdout),
              options.sessionId,
              options.startedAt,
              options.finishedAt,
              options.cwd
            )
          );
        } catch {
          resolveModels([]);
        }
      }
    );
  });
}
