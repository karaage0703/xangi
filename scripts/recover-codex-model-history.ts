/**
 * 過去の Codex モデル証跡を、対象セッション 1 件ずつ復元する。
 * 既定は読み取りのみ。--apply-offline の前に対象 xangi を停止すること。
 * 例: npx tsx scripts/recover-codex-model-history.ts --sessions /data/sessions.json
 *     --transcripts /data/logs/sessions --session APP_SESSION_ID [--codex-home /home/user/.codex]
 * 保存: 同じ引数に --apply-offline を追加。元ファイルを .model-history-<timestamp>.bak に退避。
 * 当時の provider session ID、cwd、prompt/response 時刻で絞り、設定値から推測しない。
 * 過去 transcript は変更しない。session の時刻、タイトル、active 状態も変更しない。
 */
import { readFile, stat, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoverCodexModelHistory } from '../src/codex-model-history-recovery.js';

const args = process.argv.slice(2);
const allowed = new Set([
  '--sessions',
  '--transcripts',
  '--session',
  '--codex-home',
  '--apply-offline',
]);
const values = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (!allowed.has(flag) || values.has(flag))
    throw new Error(`Unknown or duplicate argument: ${flag}`);
  if (flag === '--apply-offline') values.set(flag, 'true');
  else {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }
}
const sessionId = values.get('--session');
const sessionsArg = values.get('--sessions');
const transcriptsArg = values.get('--transcripts');
if (!sessionsArg || !transcriptsArg || !sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
  throw new Error(
    'Required: --sessions FILE --transcripts DIRECTORY --session APP_SESSION_ID [--codex-home DIRECTORY] [--apply-offline]'
  );
}
const sessionsPath = resolve(sessionsArg);
const transcriptPath = join(resolve(transcriptsArg), `${sessionId}.jsonl`);
for (const file of [sessionsPath, transcriptPath]) {
  if ((await stat(file)).size > 64 * 1024 * 1024)
    throw new Error('Input exceeds 64 MiB safety limit');
}
const original = await readFile(sessionsPath, 'utf8');
const data = JSON.parse(original);
const session = data.sessions?.[sessionId];
if (!session || typeof session.workspacePath !== 'string' || !session.workspacePath) {
  throw new Error(
    'Session must have its original workspacePath; no current-workspace fallback is allowed'
  );
}
const messages = (await readFile(transcriptPath, 'utf8'))
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
if (messages.length > 10000) throw new Error('Transcript exceeds 10000 message safety limit');
const recovered = await recoverCodexModelHistory(
  messages,
  session.workspacePath,
  values.get('--codex-home'),
  session.modelHistory ?? []
);
console.log(
  JSON.stringify(
    {
      sessionId,
      mode: values.has('--apply-offline') ? 'apply-offline' : 'dry-run',
      recoveredTurns: recovered.length,
      history: recovered,
    },
    null,
    2
  )
);
if (values.has('--apply-offline') && recovered.length) {
  // No live writer lock exists in sessions.ts. Operator must have stopped xangi.
  if ((await readFile(sessionsPath, 'utf8')) !== original)
    throw new Error('Sessions changed during recovery; refusing write');
  session.modelHistory = [...(session.modelHistory ?? []), ...recovered].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  );
  const backup = `${sessionsPath}.model-history-${Date.now()}.bak`;
  await copyFile(sessionsPath, backup, constants.COPYFILE_EXCL);
  const temporary = `${sessionsPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if ((await readFile(sessionsPath, 'utf8')) !== original)
      throw new Error('Sessions changed before replacement; refusing write');
    await rename(temporary, sessionsPath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  console.log(`Saved model history; backup: ${backup}`);
}
