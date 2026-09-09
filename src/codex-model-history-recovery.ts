import { readCodexTurnModels } from './codex-model-evidence.js';
import type { ModelExecution } from './model-execution.js';

interface HistoricalMessage {
  id: string;
  role: string;
  createdAt: string;
  content: unknown;
  modelExecution?: ModelExecution;
}

/** Recover old turns using their own response session ID, never today's agent settings. */
export async function recoverCodexModelHistory(
  messages: HistoricalMessage[],
  cwd: string,
  codexHome?: string,
  existing: ModelExecution[] = []
): Promise<ModelExecution[]> {
  const history: ModelExecution[] = [];
  let prompt: HistoricalMessage | undefined;
  const ids = new Set(existing.map((execution) => execution.turnId));
  for (const message of messages) {
    if (message.role === 'user') {
      prompt = message;
      continue;
    }
    if (message.role !== 'assistant' || !prompt) continue;
    const start = prompt.createdAt;
    prompt = undefined; // Never stretch one prompt interval across multiple responses.
    if (!message.content || typeof message.content !== 'object') continue;
    const content = message.content as Record<string, unknown>;
    const providerSessionId = content.sessionId;
    if (typeof providerSessionId !== 'string' || !providerSessionId) continue;
    // Existing new-format snapshots already contain better exact execution intervals.
    if (message.modelExecution || content.modelExecution) continue;
    const startTime = Date.parse(start);
    const endTime = Date.parse(message.createdAt);
    if (
      existing.some(
        (execution) =>
          execution.providerSessionId === providerSessionId &&
          Date.parse(execution.startedAt) >= startTime &&
          Date.parse(execution.updatedAt) <= endTime
      )
    )
      continue;
    const turnId = `recovered:${message.id}`;
    if (ids.has(turnId)) continue;
    const observedModels = await readCodexTurnModels({
      providerSessionId,
      cwd,
      startedAt: start,
      finishedAt: message.createdAt,
      codexHome,
    });
    if (!observedModels.length) continue;
    history.push({
      turnId,
      backend: 'codex',
      source: 'provider',
      status: 'completed',
      startedAt: start,
      updatedAt: message.createdAt,
      providerSessionId,
      observedModels,
      effectiveModel: observedModels[observedModels.length - 1],
    });
  }
  return history;
}
