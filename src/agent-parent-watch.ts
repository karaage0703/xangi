import type { AgentRun, AgentRunStore } from './agent-runs.js';

export const PARENT_CHECK_MS = 30_000;
export const PARENT_PROGRESS_MS = 180_000;
export const PARENT_DELIVERY_LIMIT = 3;

export function parentWatchSettings(env: NodeJS.ProcessEnv = process.env) {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1000 || Number(raw) > 86400000)
      throw new Error(`${name} must be an integer between 1000 and 86400000 (milliseconds)`);
    return Number(raw);
  };
  return {
    checkMs: read('AGENT_PARENT_CHECK_INTERVAL_MS', PARENT_CHECK_MS),
    progressMs: read('AGENT_PARENT_PROGRESS_INTERVAL_MS', PARENT_PROGRESS_MS),
  };
}

export function parentDeliveryDue(
  run: AgentRun,
  now = Date.now(),
  checkMs = PARENT_CHECK_MS
): boolean {
  return (
    run.parentDeliveryTracked === true &&
    !!run.completedAt &&
    !run.parentNotifiedAt &&
    (run.parentDeliveryAttempts || 0) < PARENT_DELIVERY_LIMIT &&
    (!run.parentDeliveryAttemptAt || now - Date.parse(run.parentDeliveryAttemptAt) >= checkMs)
  );
}

/** Host-side checks never start an LLM turn merely to poll running children. */
export async function checkAgentParents(options: {
  store: AgentRunStore;
  destination: (run: AgentRun) => { parent?: string; platform?: AgentRun['parentPlatform'] };
  notify: (run: AgentRun) => void;
  isDelivering?: (parent: string) => boolean;
  send: (
    platform: NonNullable<AgentRun['parentPlatform']>,
    destination: string,
    text: string
  ) => Promise<void>;
  now?: number;
  checkMs?: number;
  progressMs?: number;
}): Promise<void> {
  const now = options.now ?? Date.now();
  const groups = new Map<string, AgentRun[]>();
  for (const run of options.store.list()) {
    if (run.parentDeliveryTracked !== true) continue;
    const { parent, platform } = options.destination(run);
    if (!parent || !platform) continue;
    if (parentDeliveryDue(run, now, options.checkMs)) options.notify(run);
    if (
      run.completedAt &&
      !run.parentNotifiedAt &&
      (run.parentDeliveryAttempts || 0) >= PARENT_DELIVERY_LIMIT &&
      !options.isDelivering?.(parent) &&
      !run.parentDeliveryFallbackAttempted
    ) {
      options.store.markParentFallbackAttempted(run.id);
      try {
        await options.send(
          platform,
          parent,
          `子Agentの実行は${run.status === 'failed' ? '失敗' : '完了'}しましたが、親の結果処理を再開できませんでした。実行ID: ${run.id}\n${run.error || run.result?.slice(0, 1500) || ''}\n自動再試行は停止しました。`
        );
      } catch (error) {
        console.error(`[agent-run] Final delivery alert failed for ${run.id}:`, error);
      }
    }
    if (run.status !== 'queued' && run.status !== 'running') continue;
    const key = JSON.stringify([platform, parent]);
    groups.set(key, [...(groups.get(key) || []), run]);
  }
  for (const [key, runs] of groups) {
    if (
      !runs.some(
        (run) =>
          now - Date.parse(run.parentProgressAt || run.startedAt || run.createdAt) >=
          (options.progressMs ?? PARENT_PROGRESS_MS)
      )
    )
      continue;
    const [platform, parent] = JSON.parse(key) as [NonNullable<AgentRun['parentPlatform']>, string];
    // Persist before delivery to bound retries even when a transport is unavailable.
    for (const run of runs) options.store.markParentProgress(run.id);
    try {
      await options.send(
        platform,
        parent,
        '子Agentの処理は継続中です。\n' +
          runs
            .map(
              (run) =>
                `・${run.agentId || run.id}: ${run.status === 'queued' ? '実行待ち' : '実行中'}（開始から約${Math.floor((now - Date.parse(run.startedAt || run.createdAt)) / 60_000)}分）${run.workThread?.url ? ` ${run.workThread.url}` : ''}`
            )
            .join('\n')
      );
    } catch (error) {
      console.error('[agent-run] Progress delivery failed:', error);
    }
  }
}
