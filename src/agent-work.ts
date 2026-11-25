import { runDelegatingLeader } from './team-delegation.js';
import { randomUUID } from 'node:crypto';
import type { DiscordHistoryContext, getDiscordTimeoutInfoFor } from './discord/ui.js';
import type { TurnHistoryEntry } from './activity-store.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import type { AgentRun, AgentRunStore } from './agent-runs.js';
import { formatAgentWork } from './agent-work-presentation.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { agentWorkChannel } from './agent-selection.js';
import { isSecretSession } from './secret.js';
import {
  activateSession,
  closeSession,
  getSessionEntry,
  setSession,
  setProviderSessionId,
} from './sessions.js';
import { logPrompt, logResponse } from './transcript-logger.js';

export interface WorkThread {
  platform: string;
  channelId: string;
  threadId: string;
  url: string;
  connectionId?: string;
  relayed?: true;
}
export interface WorkHistory {
  context: DiscordHistoryContext;
  entries: TurnHistoryEntry[];
}
export type WorkTimeout = NonNullable<ReturnType<typeof getDiscordTimeoutInfoFor>>;
export interface WorkTransport {
  create(channelId: string, title: string, text: string): Promise<WorkThread>;
  progress(thread: WorkThread, text: string): Promise<void>;
  send(thread: WorkThread, text: string, history?: WorkHistory): Promise<void>;
  begin?(thread: WorkThread, contextKey: string): Promise<void>;
  end?(thread: WorkThread, contextKey: string): Promise<void>;
  updateTimeout?(thread: WorkThread, timeout: WorkTimeout): Promise<void>;
}
const transports = new Map<string, WorkTransport>();
type DiscordWorkRoute = (
  target: { agentId: string } | { connectionId: string }
) => { connectionId: string; transport: WorkTransport; ready(): Promise<void> } | undefined;
let discordWorkRoute: DiscordWorkRoute | undefined;
let workerWorkRoute:
  | {
      create(
        runId: string,
        title: string,
        text: string,
        requesterAgentId?: string
      ): Promise<WorkThread | undefined>;
      transport: WorkTransport;
    }
  | undefined;
export function registerWorkerWorkRoute(route: typeof workerWorkRoute): void {
  workerWorkRoute = route;
}
export function registerDiscordWorkRoute(route: DiscordWorkRoute): () => void {
  discordWorkRoute = route;
  return () => {
    if (discordWorkRoute === route) discordWorkRoute = undefined;
  };
}
export function workThreadTransport(thread: WorkThread): WorkTransport | undefined {
  if (thread.relayed && workerWorkRoute) return workerWorkRoute.transport;
  return thread.connectionId
    ? discordWorkRoute?.({ connectionId: thread.connectionId })?.transport
    : transports.get(thread.platform);
}
export function localDiscordWorkTransport(): WorkTransport | undefined {
  return transports.get('discord');
}

export function registerWorkTransport(platform: string, transport: WorkTransport) {
  transports.set(platform, transport);
}
interface Dependencies {
  store: AgentRunStore;
  runner: AgentRunner;
  notify: (run: AgentRun) => void;
  reserve?: (run: AgentRun) => Promise<() => void>;
}
let dependencies: Dependencies | undefined;
const active = new Map<string, Promise<RunResult>>();
const resuming = new Set<string>();
export function registerAgentWork(value: Dependencies) {
  dependencies = value;
}
export function findAgentWork(platform: string, threadId: string) {
  return dependencies?.store
    .list()
    .find((r) => r.workThread?.platform === platform && r.workThread.threadId === threadId);
}
export function agentWorkBusy(agentId: string) {
  return (
    dependencies?.store
      .list()
      .some(
        (r) =>
          r.agentId === agentId &&
          (['queued', 'running'].includes(r.status) || active.has(r.id) || resuming.has(r.id))
      ) ?? false
  );
}

/** Close only idle work; queued follow-ups and final delivery still own the session. */
export function closeAgentWork(platform: string, threadId: string): 'closed' | 'busy' | 'missing' {
  return closeAgentRun(findAgentWork(platform, threadId));
}

export function agentWorkRunner(): AgentRunner | undefined {
  return dependencies?.runner;
}

/** Shared idle guard for parent acknowledgement and work-thread close. */
export function agentRunBusy(run: AgentRun): boolean {
  return !!(
    ['queued', 'running'].includes(run.status) ||
    active.has(run.id) ||
    resuming.has(run.id) ||
    run.pendingWorkInputs?.length
  );
}

export function closeAgentRun(run: AgentRun | undefined): 'closed' | 'busy' | 'missing' {
  if (!run) return 'missing';
  if (agentRunBusy(run)) return 'busy';
  if (!getSessionEntry(run.appSessionId)) return 'missing';
  closeSession(run.appSessionId, 'leave');
  return 'closed';
}

/** Durable receipt; instructions run on the same provider session at the next turn boundary. */
export function submitAgentWork(
  platform: string,
  threadId: string,
  messageId: string,
  text: string
): string {
  const deps = dependencies;
  const run = findAgentWork(platform, threadId);
  if (!deps || !run) throw new Error('作業が見つかりません');
  if (!text.trim()) throw new Error('追加指示をテキストで入力してください');
  if (text.length > 20000) throw new Error('追加指示は20000文字以内にしてください');
  deps.store.enqueueWorkInput(run.id, { id: messageId, text: text.trim() });
  // Always schedule a drain: a receipt may race the final display/notification await.
  if (!resuming.has(run.id)) {
    resuming.add(run.id);
    const queuedDuringExecution = active.has(run.id);
    void (async () => {
      let release: (() => void) | undefined;
      try {
        await active.get(run.id)?.catch(() => undefined);
        const current = deps.store.get(run.id)!;
        if (
          !current.pendingWorkInputs?.length ||
          (queuedDuringExecution && current.status === 'failed')
        )
          return;
        release = await deps.reserve?.(current);
        const session = getSessionEntry(current.appSessionId);
        if (!session)
          throw new Error('作業セッションが見つかりません。元の会話から再依頼してください');
        const options: RunOptions = {
          channelId: `web-chat:${current.appSessionId}`,
          appSessionId: current.appSessionId,
          platform: 'web',
          workdir: current.workspacePath,
          sessionId: current.providerSessionId,
          defaultBackend: current.backend,
          defaultModel: current.model,
          defaultEffort: current.effort,
          defaultLocalLlmMode: current.localLlmMode,
          defaultLocalLlmReasoningEffort: current.localLlmReasoningEffort,
        };
        await executeAgentWork(
          current,
          deps.store,
          options,
          (prompt, callbacks, next) =>
            runDelegatingLeader(
              current,
              deps.store,
              deps.runner,
              `${session.selectedAgentConfig?.prompt || ''}\n\n${!next.sessionId ? `[Original request]\n${current.task}\n\n` : ''}${prompt}`,
              callbacks,
              next
            ),
          false
        );
        deps.notify(deps.store.get(run.id)!);
      } catch (error) {
        const failed = deps.store.markFailed(run.id, error);
        deps.notify(failed);
        try {
          await workThreadTransport(run.workThread!)?.send(
            run.workThread!,
            `追加指示の実行に失敗しました: ${String(error)}`
          );
        } catch (deliveryError) {
          deps.store.setWorkDeliveryError(run.id, String(deliveryError));
        }
      } finally {
        release?.();
        resuming.delete(run.id);
        // Inputs arriving during final notification must not be stranded.
        const current = deps.store.get(run.id);
        if (current?.pendingWorkInputs?.length && current.status !== 'failed') {
          const first = current.pendingWorkInputs[0];
          submitAgentWork(platform, threadId, first.id, first.text);
        }
      }
    })();
  }
  return '追加指示を受け付けました。現在の応答が終わった後、同じ作業セッションで処理します。';
}

export async function prepareAgentWork(
  run: AgentRun,
  store: AgentRunStore
): Promise<WorkThread | undefined> {
  if (run.workThread) return run.workThread;
  if (!run.agentId || isSecretSession(run.appSessionId) || isSecretSession(run.parentAppSessionId))
    return undefined;
  const name = getSessionEntry(run.appSessionId)?.selectedAgentConfig?.name || run.agentId;
  const { title, text } = formatAgentWork(run.task, name, run.workPresentation);
  const requesterAgentId = run.parentAppSessionId
    ? getSessionEntry(run.parentAppSessionId)?.selectedAgentId
    : undefined;
  const relayed = await workerWorkRoute?.create(run.id, title, text, requesterAgentId);
  const thread =
    relayed ?? (await createAgentWorkThread(run.agentId, title, text, { requesterAgentId }));
  if (thread) store.setWorkThread(run.id, thread);
  return thread;
}

export async function createAgentWorkThread(
  agentId: string,
  title: string,
  text: string,
  origin?: { platform?: 'discord'; requester?: WorkTransport; requesterAgentId?: string }
): Promise<WorkThread | undefined> {
  const target = agentWorkChannel(agentId);
  if (!target || (origin?.platform && target.platform !== origin.platform)) return undefined;
  const dedicated = target.platform === 'discord' ? discordWorkRoute?.({ agentId }) : undefined;
  const shared = transports.get(target.platform);
  const responder = dedicated?.transport ?? shared;
  if (!responder) throw new Error(`${target.platform}の作業チャンネルに接続できません`);
  await dedicated?.ready();
  const requesterAgentId = target.platform === 'discord' ? origin?.requesterAgentId : undefined;
  const requester = requesterAgentId
    ? discordWorkRoute?.({ agentId: requesterAgentId })?.transport
    : origin?.requester;
  const thread = await (requester ?? shared ?? responder).create(target.channelId, title, text);
  return dedicated ? { ...thread, connectionId: dedicated.connectionId } : thread;
}

type Execute = (
  prompt: string,
  callbacks: StreamCallbacks,
  options: RunOptions
) => Promise<RunResult>;
/** Single execution path for standalone and Team children, with optional platform presentation. */
export function executeAgentWork(
  run: AgentRun,
  store: AgentRunStore,
  options: RunOptions,
  execute: Execute,
  initial = true
): Promise<RunResult> {
  if (active.has(run.id)) throw new Error('この作業は実行中です');
  const promise = executeWork(run, store, options, execute, initial);
  active.set(run.id, promise);
  void promise
    .finally(() => {
      if (active.get(run.id) === promise) active.delete(run.id);
    })
    .catch(() => undefined);
  return promise;
}
async function executeWork(
  run: AgentRun,
  store: AgentRunStore,
  options: RunOptions,
  execute: Execute,
  initial: boolean
): Promise<RunResult> {
  activateSession(`web-chat:${run.appSessionId}`, run.appSessionId);
  store.markRunning(run.id);
  let thread = run.workThread;
  let transport: WorkTransport | undefined;
  try {
    if (thread) transport = workThreadTransport(thread);
    if (!thread) {
      thread = await prepareAgentWork(run, store);
      transport = thread ? workThreadTransport(thread) : undefined;
    }
    if (thread && !transport) throw new Error(`${thread.platform}の作業チャンネルに接続できません`);
    const reportFailure = (error: unknown) => {
      store.setWorkDeliveryError(run.id, String(error));
      console.warn(`[agent-work] ${run.id} delivery failed:`, error);
    };
    let latest = '';
    let lastFlush = 0;
    let delivery = Promise.resolve();
    const flush = (text: string) => {
      latest = text;
      if (!thread || !transport || Date.now() - lastFlush < 1500) return;
      lastFlush = Date.now();
      delivery = delivery.then(() => transport!.progress(thread!, latest)).catch(reportFailure);
    };
    const callbacks: StreamCallbacks = {
      onText: (_chunk, fullText) => flush(fullText),
      onToolUse: (name) => flush(`実行中: ${name}`),
    };
    let prompt = initial ? run.task : '';
    let result: RunResult = { result: '', sessionId: run.providerSessionId || '' };
    let nextOptions = { ...options };
    const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    while (true) {
      const inputs = store.takeWorkInputs(run.id);
      if (inputs.length)
        prompt += '\n\n[Additional user instructions]\n' + inputs.map((i) => i.text).join('\n\n');
      if (!prompt.trim()) break;
      if (thread && transport)
        await transport
          .send(thread, initial ? '作業を開始します。' : '追加指示を反映して作業を続けます。')
          .catch(reportFailure);
      logPrompt(run.workspacePath, run.appSessionId, prompt);
      try {
        await transport?.begin?.(thread!, options.channelId!).catch(reportFailure);
        result = await runWithBubbleEvents(
          { runStream: (text, streamCallbacks, opts) => execute(text, streamCallbacks, opts!) },
          prompt,
          {
            threadId: `web:${run.appSessionId}`,
            turnId: randomUUID(),
            platform: 'web',
            userText: prompt,
          },
          callbacks,
          nextOptions
        );
      } finally {
        if (thread && transport)
          await transport.end?.(thread, options.channelId!).catch(reportFailure);
      }
      logResponse(run.workspacePath, run.appSessionId, { ...result });
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const)
        usage[key] += result.usage?.[key] || 0;
      if (result.sessionId) {
        setSession(options.channelId!, result.sessionId);
        setProviderSessionId(
          run.appSessionId,
          result.sessionId,
          run.backend,
          run.model,
          run.effort,
          result.sessionMode
        );
        store.setWorkProviderSession(run.id, result.sessionId);
        nextOptions = { ...nextOptions, sessionId: result.sessionId };
      }
      await delivery;
      if (thread && transport)
        await transport
          .progress(
            thread,
            result.failed ? '作業に失敗しました' : '応答完了。追加指示はこのスレッドへ送れます。'
          )
          .catch(reportFailure);
      if (thread && transport)
        await transport
          .send(
            thread,
            `${result.failed ? '作業に失敗しました' : '応答完了'}\n\n${result.result || '（本文なし）'}`
          )
          .catch(reportFailure);
      if (result.failed || !store.get(run.id)!.pendingWorkInputs?.length) break;
      prompt = '';
      initial = false;
    }
    result = { ...result, usage };
    if (result.failed) store.markFailed(run.id, new Error(result.result));
    else store.markSucceeded(run.id, result);
    return result;
  } catch (error) {
    store.markFailed(run.id, error);
    if (thread && transport)
      await transport.send(thread, `作業に失敗しました: ${String(error)}`).catch(() => undefined);
    throw error;
  }
}
