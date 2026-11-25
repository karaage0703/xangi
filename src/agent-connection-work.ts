import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { getActivity, readTurnHistory, type TurnHistoryEntry } from './activity-store.js';
import type { ResolvedBackend } from './backend-resolver.js';
import type { AgentConnection } from './agent-connections.js';
import {
  closeAgentWork,
  findAgentWork,
  localDiscordWorkTransport,
  registerWorkerWorkRoute,
  agentWorkRunner,
  submitAgentWork,
  type WorkHistory,
  type WorkThread,
  type WorkTimeout,
  type WorkTransport,
} from './agent-work.js';
import { getDiscordTimeoutInfoFor, type DiscordHistoryContext } from './discord/ui.js';
import { processManager } from './process-manager.js';
import { completionHistory } from './completion-history.js';
import type { ExtendTimeoutResult } from './agent-runner.js';
import { formatAgentErrorForUser } from './errors.js';

type PostRequest =
  | { action: 'create'; channelId: string; title: string; text: string }
  | { action: 'send'; thread: WorkThread; text: string; history?: WorkHistory }
  | { action: 'progress'; thread: WorkThread; text: string }
  | { action: 'begin' | 'end'; thread: WorkThread; contextKey: string }
  | { action: 'timeout'; thread: WorkThread; timeout: WorkTimeout };
export type WorkerWorkRequest =
  | { action: 'publish'; runId: string; title: string; text: string; requesterAgentId?: string }
  | { action: 'delivery'; post: Exclude<PostRequest, { action: 'create' }> }
  | { action: 'defaults' };
export type InputRequest = { threadId: string; userId: string } & (
  | { action: 'input'; messageId: string; text: string; hasAttachments: boolean }
  | { action: 'lookup' | 'stop' | 'extend' | 'close' }
  | { action: 'history'; turnId: string }
);
type InputResult = {
  input: string | null;
  lookup: 'accept' | 'ignore';
  stop: boolean;
  extend: ExtendTimeoutResult;
  close: ReturnType<typeof closeAgentWork>;
  history: TurnHistoryEntry[];
};
type Request = PostRequest | InputRequest | WorkerWorkRequest;
type Packet =
  | { type: 'agent-work-request'; id: string; request: Request }
  | { type: 'agent-work-response'; id: string; result?: unknown; error?: string };
type Send = (packet: Packet, onError: (error: Error | null) => void) => void;

function workPeer(send: Send, handle: (request: Request) => Promise<unknown>) {
  const pending = new Map<
    string,
    (reply: Extract<Packet, { type: 'agent-work-response' }>) => void
  >();
  function receive(message: unknown) {
    if (!message || typeof message !== 'object' || !('type' in message) || !('id' in message))
      return;
    const packet = message as Packet;
    if (typeof packet.id !== 'string') return;
    if (packet.type === 'agent-work-response') pending.get(packet.id)?.(packet);
    if (
      packet.type === 'agent-work-request' &&
      packet.request &&
      typeof packet.request === 'object'
    ) {
      const reply = (result?: unknown, error?: string) =>
        send({ type: 'agent-work-response', id: packet.id, result, error }, () => undefined);
      void handle(packet.request)
        .then(
          (result) => reply(result),
          (error: unknown) => reply(undefined, formatAgentErrorForUser(error))
        )
        .catch(() => undefined);
    }
  }
  function request<T>(request: Request): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const finish = ({ error, result }: Extract<Packet, { type: 'agent-work-response' }>) => {
        clearTimeout(timeout);
        pending.delete(id);
        if (error) reject(new Error(error));
        else resolve(result as T);
      };
      const fail = (error: string) => finish({ type: 'agent-work-response', id, error });
      const timeout = setTimeout(
        () => fail('専用Botの作業スレッドへの接続が時間切れになりました'),
        20_000
      );
      timeout.unref();
      pending.set(id, finish);
      try {
        send({ type: 'agent-work-request', id, request }, (error) => {
          if (error) fail('専用Botの作業スレッドに接続できません');
        });
      } catch {
        fail('専用Botの作業スレッドに接続できません');
      }
    });
  }
  function disconnect() {
    for (const [id, finish] of pending)
      finish({ type: 'agent-work-response', id, error: '専用Botの接続が終了しました' });
  }
  return { receive, request, disconnect };
}

export async function handleDedicatedWorkInput(
  connection: Pick<AgentConnection, 'id' | 'agentId' | 'allowedUsers' | 'platform'>,
  request: Request
) {
  if (connection.platform !== 'discord' || !('threadId' in request)) return;
  const { threadId, userId } = request;
  if (typeof threadId !== 'string' || typeof userId !== 'string') return;
  const run = findAgentWork('discord', threadId);
  if (!run || run.workThread?.connectionId !== connection.id || run.agentId !== connection.agentId)
    return;
  const allowed = connection.allowedUsers.split(',').map((user) => user.trim());
  if (!allowed.includes('*') && !allowed.includes(userId)) return;

  return applyWorkInput(request, run.appSessionId);
}

export async function applyRelayedWorkInput(request: InputRequest) {
  const run = findAgentWork('discord', request.threadId);
  if (run?.workThread?.relayed) return applyWorkInput(request, run.appSessionId);
}

async function applyWorkInput(request: InputRequest, appSessionId: string) {
  const contextKey = `web-chat:${appSessionId}`;
  const { threadId } = request;
  switch (request.action) {
    case 'lookup':
      return 'accept';
    case 'input':
      if (typeof request.messageId !== 'string' || typeof request.text !== 'string') return;
      if (request.hasAttachments)
        throw new Error(
          '作業スレッドの追加指示はテキストで送ってください。添付ファイルには未対応です'
        );
      return submitAgentWork('discord', threadId, request.messageId, request.text);
    case 'stop':
      return (
        (await processManager.stopAndWait(contextKey)) ||
        agentWorkRunner()?.cancel?.(contextKey) ||
        false
      );
    case 'extend':
      return agentWorkRunner()?.extendTimeout?.(contextKey) ?? { ok: false, reason: 'unsupported' };
    case 'close':
      return closeAgentWork('discord', threadId);
    case 'history':
      return readTurnHistory(`web:${appSessionId}`, 200).filter(
        (entry) => entry.turnId === request.turnId
      );
  }
}

export function connectDedicatedDiscordWork(
  child: ChildProcess,
  connection: AgentConnection,
  route?: (request: InputRequest | WorkerWorkRequest) => Promise<unknown>
) {
  const peer = workPeer(
    (packet, onError) => {
      child.send(packet, onError);
    },
    async (request) => {
      if ('threadId' in request) {
        const allowed = connection.allowedUsers.split(',').map((user) => user.trim());
        if (!allowed.includes('*') && !allowed.includes(request.userId)) return;
        const response = await route?.(request);
        return response === undefined ? handleDedicatedWorkInput(connection, request) : response;
      }
      if (
        request.action === 'publish' ||
        request.action === 'delivery' ||
        request.action === 'defaults'
      )
        return route?.(request);
    }
  );
  child.on('message', peer.receive);
  child.once('disconnect', peer.disconnect);
  return {
    transport: workTransport(
      peer,
      () => child.connected,
      (stop) => child.once('disconnect', stop)
    ),
    input: (request: InputRequest) => peer.request<unknown>(request),
  };
}

function workTransport(
  peer: ReturnType<typeof workPeer>,
  isConnected: () => boolean,
  onDisconnect: (stop: () => void) => void,
  post = (request: PostRequest) => peer.request<void>(request)
): WorkTransport {
  const turnIds = new Map<string, string | undefined>();
  const histories = new Map<string, DiscordHistoryContext>();
  const timeoutTimers = new Map<string, ReturnType<typeof setInterval>>();
  const timeoutUpdates = new Map<string, Promise<void>>();
  onDisconnect(() => {
    for (const timer of timeoutTimers.values()) clearInterval(timer);
    timeoutTimers.clear();
  });
  return {
    create: (channelId, title, text) =>
      peer.request<WorkThread>({ action: 'create', channelId, title, text }),
    send(thread, text, suppliedHistory) {
      const context = histories.get(thread.threadId);
      const match = /^(?:応答完了|作業に失敗しました)\n\n/.exec(text);
      const history =
        context && match
          ? { context, entries: completionHistory(context, text.slice(match[0].length)) }
          : undefined;
      if (match) histories.delete(thread.threadId);
      return post({ action: 'send', thread, text, history: suppliedHistory ?? history });
    },
    progress: (thread, text) => post({ action: 'progress', thread, text }),
    updateTimeout: (thread, timeout) => post({ action: 'timeout', thread, timeout }),
    async begin(thread, contextKey) {
      turnIds.set(thread.threadId, getActivity(contextKey.replace(/^web-chat:/, 'web:'))?.turnId);
      await post({ action: 'begin', thread, contextKey });
      if (!isConnected()) return;
      const refreshTimeout = () => {
        const runner = agentWorkRunner();
        const timeout = runner && getDiscordTimeoutInfoFor(runner, contextKey);
        if (!timeout || timeoutUpdates.has(thread.threadId)) return;
        timeoutUpdates.set(
          thread.threadId,
          post({ action: 'timeout', thread, timeout })
            .catch(() => undefined)
            .finally(() => {
              timeoutUpdates.delete(thread.threadId);
            })
        );
      };
      const timer = setInterval(refreshTimeout, 10_000);
      timer.unref();
      timeoutTimers.set(thread.threadId, timer);
      refreshTimeout();
    },
    async end(thread, contextKey) {
      clearInterval(timeoutTimers.get(thread.threadId));
      timeoutTimers.delete(thread.threadId);
      await timeoutUpdates.get(thread.threadId);
      const threadId = contextKey.replace(/^web-chat:/, 'web:');
      const activity = getActivity(threadId);
      if (activity && activity.turnId !== turnIds.get(thread.threadId))
        histories.set(thread.threadId, { threadId, turnId: activity.turnId });
      turnIds.delete(thread.threadId);
      await post({ action: 'end', thread, contextKey });
    },
  };
}

export async function deliverWorkPost(transport: WorkTransport, request: PostRequest) {
  switch (request.action) {
    case 'create':
      return transport.create(request.channelId, request.title, request.text);
    case 'send':
      return transport.send(request.thread, request.text, request.history);
    case 'progress':
      return transport.progress(request.thread, request.text);
    case 'begin':
      return transport.begin?.(request.thread, request.contextKey);
    case 'end':
      return transport.end?.(request.thread, request.contextKey);
    case 'timeout':
      return transport.updateTimeout?.(request.thread, request.timeout);
  }
}

let workerPeer: ReturnType<typeof workPeer> | undefined;
let sharedInput: ((request: InputRequest) => Promise<unknown> | undefined) | undefined;
export function registerSharedWorkInput(input: typeof sharedInput): void {
  sharedInput = input;
}

export function installDedicatedDiscordWorkWorker() {
  const peer = workPeer(
    (packet, onError) => {
      if (process.connected && process.send) process.send(packet, onError);
      else onError(new Error('親ランタイムに接続できません'));
    },
    async (request) => {
      if ('threadId' in request) return applyRelayedWorkInput(request);
      if (!('thread' in request) && request.action !== 'create') return;
      const transport = localDiscordWorkTransport();
      if (!transport) throw new Error('専用BotからDiscordへ投稿できません');
      return deliverWorkPost(transport, request);
    }
  );
  workerPeer = peer;
  const transport = workTransport(
    peer,
    () => Boolean(process.connected),
    (stop) => process.once('disconnect', stop),
    (post) =>
      post.action === 'create'
        ? Promise.reject(new Error('依頼先の担当を指定してください'))
        : peer.request<void>({ action: 'delivery', post })
  );
  registerWorkerWorkRoute({
    create: (runId, title, text, requesterAgentId) =>
      peer.request<WorkThread | undefined>({
        action: 'publish',
        runId,
        title,
        text,
        requesterAgentId,
      }),
    transport,
  });
  process.on('message', peer.receive);
  process.once('disconnect', peer.disconnect);
}

export function sharedDelegationDefaults(): Promise<ResolvedBackend> | undefined {
  return workerPeer?.request<ResolvedBackend>({ action: 'defaults' });
}

export function relayDedicatedWorkInput<T extends InputRequest>(
  request: T
): Promise<InputResult[T['action']] | undefined> | undefined {
  return (workerPeer?.request(request) ?? sharedInput?.(request)) as
    Promise<InputResult[T['action']] | undefined> | undefined;
}
