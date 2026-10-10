/** Best-effort privacy. The ID remains recognizable after close, so late writes stay disabled. */
export const SECRET_PREFIX = 'secret_';
export function isSecretSession(id?: string): boolean {
  return Boolean(id?.startsWith(SECRET_PREFIX));
}
export { parseSecretCommand } from './secret-command-parser.js';
export const SECRET_NOTICE =
  'シークレットモード：xangiの会話・実行ログの保存を抑えます。終了・再起動で会話は失われます。チャットサービス・AI提供元の記録、添付・作成ファイルは残る場合があります。';
const privateContexts = new Map<string, string>();
export function registerSecretContext(platform: string, contextKey: string, id: string): void {
  if (!isSecretSession(id)) return;
  privateContexts.set(`${platform}:${contextKey}`, id);
  // LINE/Telegram context keys already carry their platform prefix; Web uses web-chat:.
  privateContexts.set(contextKey, id);
  if (platform === 'telegram')
    privateContexts.set(contextKey.replace(/^telegram:(?:dm|chat):/, 'telegram:'), id);
  privateContexts.set(`${platform}:${id}`, id);
}
export function forgetSecretContext(id: string): void {
  for (const [key, value] of privateContexts) if (value === id) privateContexts.delete(key);
}
export function isSecretThread(threadId: string): boolean {
  return privateContexts.has(threadId) || threadId.includes(`:${SECRET_PREFIX}`);
}

const privateTurns = new Map<string, number>();
export function isSecretTurn(threadId: string, turnId: string): boolean {
  const key = `${threadId}\0${turnId}`;
  if (isSecretThread(threadId)) {
    privateTurns.set(key, Date.now());
    if (privateTurns.size > 4096) privateTurns.delete(privateTurns.keys().next().value!);
    return true;
  }
  const seen = privateTurns.get(key);
  return seen !== undefined && Date.now() - seen < 24 * 60 * 60 * 1000;
}
