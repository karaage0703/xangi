import { normalizeModelId } from './model-execution.js';

/** Request-scoped provider evidence. Never resolve old runs from current configuration. */
export class ProviderModels {
  private readonly observed: string[] = [];
  private latest?: string;
  constructor(private readonly onModel?: (model: string) => void) {}
  add(value: unknown): void {
    const model = normalizeModelId(value);
    if (!model) return;
    if (this.latest === model) return;
    this.latest = model;
    if (!this.observed.includes(model)) this.observed.push(model);
    this.onModel?.(model);
  }
  result(): { model?: string; models?: string[] } {
    return this.observed.length ? { model: this.latest, models: [...this.observed] } : {};
  }
}

/** Claude nested assistant events belong to subagents, not the user's main turn. */
export function observeClaudeModel(
  models: ProviderModels,
  event: {
    type?: string;
    subtype?: string;
    model?: unknown;
    parent_tool_use_id?: unknown;
    message?: { model?: unknown };
    modelUsage?: Record<string, unknown>;
  }
): void {
  if (event.parent_tool_use_id) return;
  if (event.type === 'assistant') models.add(event.message?.model);
  if (event.type === 'system' && event.subtype === 'init') models.add(event.model);
  // Aggregate modelUsage may include auxiliary calls and is not main-turn proof.
}
