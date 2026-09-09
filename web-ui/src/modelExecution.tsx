export interface ModelExecution {
  turnId: string;
  backend: string;
  configuredModel?: string;
  effectiveModel?: string;
  modelSelection?: string;
  observedModels: string[];
  source: 'provider' | 'configuration' | 'unknown';
  startedAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed';
  providerSessionId?: string;
}

export function modelExecutionLabel(
  execution?: ModelExecution,
  configured?: { backend: string; model?: string }
): string {
  if (!execution)
    return configured?.model
      ? `${configured.backend} · ${configured.model}（当時の設定値・実行未確認）`
      : 'モデル不明（記録なし）';
  if (
    !execution.effectiveModel &&
    !execution.observedModels.length &&
    execution.modelSelection === 'Auto'
  )
    return `${execution.backend} / Auto（自動選択・内部モデル不明）`;
  const model =
    execution.effectiveModel || execution.observedModels.at(-1) || execution.configuredModel;
  const source =
    execution.source === 'provider' && execution.observedModels.length
      ? '確認済み'
      : model
        ? '設定値・実行未確認'
        : '不明';
  const additional = execution.observedModels.filter((observed) => observed !== model);
  return `${execution.backend} · ${model || 'モデル不明'}（${source}）${additional.length ? ` / 同turnで確認: ${additional.join(', ')}` : ''}`;
}

export function executionStatusLabel(status: ModelExecution['status']): string {
  return { running: '実行中', completed: '完了', failed: '失敗' }[status];
}

export function ModelHistory({ history = [] }: { history?: ModelExecution[] }) {
  return (
    <details className="monitor-technical-details">
      <summary>モデル実行履歴（{history.length} turn）</summary>
      {history.length === 0 ? (
        <p>当時のモデル記録はありません。現在の設定からは推定しません。</p>
      ) : (
        <ol>
          {history.map((execution) => (
            <li key={execution.turnId}>
              <time dateTime={execution.startedAt}>
                {new Date(execution.startedAt).toLocaleString('ja-JP')}
              </time>
              {' — '}
              {modelExecutionLabel(execution)}
              {' / '}
              {executionStatusLabel(execution.status)}
              {execution.configuredModel && <div>当時の設定: {execution.configuredModel}</div>}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
