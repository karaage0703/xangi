import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

interface RestartIpc extends Pick<EventEmitter, 'on' | 'off'> {
  connected?: boolean;
  send?: (message: object, callback: (error: Error | null) => void) => boolean;
}

const requestType = 'agent-connection-parent-restart';
const replyType = 'agent-connection-parent-restart-result';
const unknownOutcome =
  '親本体の再起動結果を確認できません。状態を確認するまで再実行しないでください。';

/** Use only the existing fork IPC channel; never discover or guess a parent HTTP endpoint. */
export function requestParentRestart(
  ipc: RestartIpc = process,
  timeoutMs = 5_000
): Promise<string> {
  if (!ipc.connected || !ipc.send) {
    return Promise.reject(new Error('親本体への接続がありません。再起動要求は送信していません。'));
  }
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipc.off('message', receive);
      ipc.off('disconnect', disconnected);
      if (error) reject(error);
      else resolve(result!);
    };
    const receive = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const reply = message as Record<string, unknown>;
      if (reply.type !== replyType || reply.requestId !== requestId) return;
      if (typeof reply.result === 'string') finish(undefined, reply.result);
      else finish(new Error(unknownOutcome));
    };
    const disconnected = () => finish(new Error(unknownOutcome));
    const timer = setTimeout(disconnected, timeoutMs);
    ipc.on('message', receive);
    ipc.on('disconnect', disconnected);
    try {
      ipc.send!({ type: requestType, requestId }, (error) => {
        if (error) finish(new Error(unknownOutcome));
      });
    } catch {
      finish(new Error(unknownOutcome));
    }
  });
}

/** Bind requests to an owned child. The callback checks permission and state in the parent. */
export function attachParentRestartHandler(
  child: ChildProcess,
  restart: () => Promise<string>,
  stopping: () => boolean
): void {
  const replies = new Map<string, Promise<string>>();
  const send = (requestId: string, result: string) => {
    if (!child.connected) return;
    try {
      child.send({ type: replyType, requestId, result }, () => undefined);
    } catch {
      // The child may disconnect after the parent accepted; never repeat the restart.
    }
  };
  const receive = (message: unknown) => {
    if (!message || typeof message !== 'object' || !child.connected) return;
    const request = message as Record<string, unknown>;
    if (
      request.type !== requestType ||
      typeof request.requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.requestId)
    )
      return;
    const requestId = request.requestId;
    let result = replies.get(requestId);
    if (!result) {
      if (replies.size >= 64) {
        // Never evict IDs and accidentally execute an old request twice.
        send(requestId, '再起動要求の上限に達しました。親本体の状態を確認してください。');
        return;
      }
      result = Promise.resolve().then(async () => {
        if (!child.connected) return '専用Botの接続が終了しました。再起動は実行していません。';
        if (stopping()) return '親本体は終了処理中です。復帰を確認してください。';
        try {
          return await restart();
        } catch {
          return '親本体の再起動前検証に失敗しました。親本体の状態を確認してください。';
        }
      });
      replies.set(requestId, result);
    }
    void result.then((text) => {
      send(requestId, text);
    });
  };
  child.on('message', receive);
  child.once('close', () => {
    child.off('message', receive);
    replies.clear();
  });
}
