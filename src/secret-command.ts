import type { RunOptions, RunResult } from './agent-runner.js';
import { closeSession, createSession, getSessionEntry } from './sessions.js';
import { SECRET_NOTICE, isSecretSession, parseSecretCommand } from './secret.js';

export function handleSecretCommand(options?: RunOptions): RunResult | undefined {
  if (options?.internalTask) return;
  const command = parseSecretCommand(options?.userText);
  if (!command || !options?.appSessionId) return;
  const entry = getSessionEntry(options.appSessionId);
  if (!entry) return;
  const active = isSecretSession(entry.id);
  const reply = (result: string): RunResult => ({
    result,
    sessionId: '',
    sessionMode: 'stateless',
  });
  if (command === 'status')
    return reply(active ? SECRET_NOTICE : 'シークレットモードはOFFです。/secret on で開始します。');
  if ((command === 'on') === active)
    return reply(active ? SECRET_NOTICE : 'シークレットモードはOFFです。');
  // Web owns explicit session IDs; its UI/API creates a new session instead of routing by context.
  if (entry.platform === 'web')
    return reply(
      'Webでは「シークレット」から新規会話を開いてください。終了は会話の「完了」、通常モードは「新規」です。'
    );
  closeSession(entry.id);
  // Leave normal session creation to the next message, as with /new.
  // Creating one here leaves an empty channel entry when replies move to a thread.
  if (command === 'on') {
    createSession(entry.contextKey, {
      platform: entry.platform,
      secret: true,
      title: 'シークレット',
      workspaceId: entry.workspaceId,
      workspacePath: entry.workspacePath,
      selectedAgentId: entry.selectedAgentId,
      selectedAgentConfig: entry.selectedAgentConfig,
      agentBindingKey: entry.agentBindingKey,
    });
  }
  return reply(
    command === 'on'
      ? `${SECRET_NOTICE}\n次のメッセージから有効です。/secret off で終了します。`
      : 'シークレットの会話を破棄しました。次のメッセージから通常モードです。'
  );
}
