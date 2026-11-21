import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { ConversationError } from './conversation-service.js';

/** An uncertain external thread creation is never repeated with the same ID. */
export async function createLinkedConversation(
  directory: string,
  requestId: unknown,
  projectId: string,
  message: string,
  create: () => Promise<{ sessionId: string }>,
  destination?: string
): Promise<{ sessionId: string }> {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))
    throw new ConversationError('requestIdが不正です', 400);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, createHash('sha256').update(requestId).digest('hex') + '.json');
  if (existsSync(path)) {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (
      record.projectId !== projectId ||
      record.message !== message ||
      (record.destination !== undefined && record.destination !== destination)
    )
      throw new ConversationError('同じrequestIdに異なる入力は送信できません', 409);
    if (record.sessionId) return { sessionId: record.sessionId };
    throw new ConversationError(
      '会話の作成結果を確認できません。接続先の履歴を確認してください',
      409
    );
  }
  const save = (record: object) => {
    writeFileSync(path + '.tmp', JSON.stringify(record), { mode: 0o600, flush: true });
    renameSync(path + '.tmp', path);
  };
  save({ projectId, message, destination });
  const result = await create();
  save({ projectId, message, destination, sessionId: result.sessionId });
  return result;
}

export function forgetLinkedConversation(directory: string, sessionId: string): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(directory, name);
    if (JSON.parse(readFileSync(path, 'utf8')).sessionId === sessionId) unlinkSync(path);
  }
}
