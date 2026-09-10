import type { ModelExecution, SessionEntry } from './sessions.js';

export function latestModelExecution(
  entry?: Pick<SessionEntry, 'modelExecution' | 'modelHistory'>
): ModelExecution | undefined {
  return [entry?.modelExecution, ...(entry?.modelHistory ?? [])].reduce<ModelExecution | undefined>(
    (latest, item) => (item && (!latest || item.startedAt >= latest.startedAt) ? item : latest),
    undefined
  );
}

/** Display durable execution evidence; never resolve historical defaults. */
export function formatModelExecution(
  execution?: ModelExecution,
  configured?: { backend: string; model?: string }
): string {
  if (!execution)
    return configured?.model
      ? `${configured.backend} / ${configured.model}（当時の設定値・実行未確認）`
      : '不明（実行モデルの記録なし）';
  const effort = execution.effectiveEffort
    ? `effort=${execution.effectiveEffort}`
    : execution.configuredEffort
      ? `effort=${execution.configuredEffort}（設定値・実行未確認）`
      : 'effort=default（バックエンドに委任・実効値不明）';
  if (
    !execution.effectiveModel &&
    !execution.observedModels.length &&
    execution.modelSelection === 'Auto'
  )
    return `${execution.backend} / Auto（自動選択・内部モデル不明） / ${effort}`;
  const model =
    execution.effectiveModel || execution.observedModels.at(-1) || execution.configuredModel;
  const evidence =
    execution.source === 'provider' && execution.observedModels.length
      ? ''
      : model
        ? '設定値・実行未確認'
        : 'モデル不明';
  const additional = execution.observedModels.filter((observed) => observed !== model);
  const startedAt = new Date(execution.startedAt);
  const time = Number.isNaN(startedAt.getTime())
    ? ''
    : startedAt.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
  const details = [evidence, time].filter(Boolean).join('、');
  return `${execution.backend} / ${model || '不明'} / ${effort}${details ? `（${details}）` : ''}${additional.length ? ` / 同turnで確認: ${additional.join(', ')}` : ''}`;
}
