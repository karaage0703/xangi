import type { RunResult } from './agent-runner.js';
import { handleSecretCommand } from './secret-command.js';
import { parseSecretCommand } from './secret.js';
import { getActiveSessionId } from './sessions.js';
import { ensureSessionWithWorkspace } from './session-workspace.js';

/** Handle controls before an external chat adapter opens an ordinary session. */
export async function handleSecretConversationCommand(
  options: Parameters<typeof ensureSessionWithWorkspace>[0] & { userText?: string }
): Promise<RunResult | undefined> {
  const command = parseSecretCommand(options.userText);
  if (!command) return;
  let appSessionId = getActiveSessionId(options.contextKey);
  if (!appSessionId) {
    if (command !== 'on') {
      return {
        result: 'シークレットモードはOFFです。/secret on で開始します。',
        sessionId: '',
        sessionMode: 'stateless',
      };
    }
    ({ appSessionId } = await ensureSessionWithWorkspace({ ...options, secret: true }));
  }
  const result = handleSecretCommand({ appSessionId, userText: options.userText });
  if (command === 'on' && result && !result.result.includes('/secret off')) {
    result.result += '\n次のメッセージから有効です。/secret off で終了します。';
  }
  return result;
}
