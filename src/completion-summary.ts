export interface CompletionDisplayOptions {
  showElapsed: boolean;
}

export const DEFAULT_COMPLETION_DISPLAY: CompletionDisplayOptions = {
  showElapsed: true,
};

export interface CompletionMetrics {
  elapsedMs: number;
}

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (totalSeconds === 0) return '1秒未満';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}時間${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
  return `${seconds}秒`;
}

export function buildCompletionSummary(
  metrics: CompletionMetrics,
  options: CompletionDisplayOptions = DEFAULT_COMPLETION_DISPLAY,
  status: 'complete' | 'error' = 'complete'
): string {
  const details: string[] = [];
  if (options.showElapsed) details.push(`⏱ ${formatElapsedTime(metrics.elapsedMs)}`);
  const label = status === 'complete' ? '✅ 完了' : '⚠️ 終了';
  return details.length > 0 ? `${label}（${details.join('・')}）` : label;
}

export function appendCompletionSummary(
  text: string,
  metrics: CompletionMetrics,
  options: CompletionDisplayOptions = DEFAULT_COMPLETION_DISPLAY,
  status: 'complete' | 'error' = 'complete'
): string {
  return `${text.trimEnd()}\n\n${buildCompletionSummary(metrics, options, status)}`;
}
