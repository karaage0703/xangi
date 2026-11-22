import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WebProjectError } from './web-projects.js';

export const AVATAR_BODY_LIMIT = 96 * 1024;
const MAX_AVATAR_BYTES = 68 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function avatarPath(dataDir: string, id: string): string {
  const key = createHash('sha256').update(id).digest('hex');
  return join(dataDir, 'agent-avatars', `${key}.png`);
}

export function findAgentAvatar(dataDir: string, id: string) {
  const file = avatarPath(dataDir, id);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return undefined;
  return {
    file,
    url: `/api/agents/${encodeURIComponent(id)}/avatar?v=${stat.mtimeMs}-${stat.ino}`,
  };
}

export function saveAgentAvatar(dataDir: string, id: string, png: unknown) {
  if (typeof png !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(png)) {
    throw new WebProjectError('アバター画像を指定してください', 400);
  }
  const bytes = Buffer.from(png, 'base64');
  if (
    bytes.length < 33 ||
    bytes.length > MAX_AVATAR_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== 128 ||
    bytes.readUInt32BE(20) !== 128
  ) {
    throw new WebProjectError('アバター画像の形式が正しくありません', 400);
  }
  const file = avatarPath(dataDir, id);
  const temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return findAgentAvatar(dataDir, id)!;
}

export function removeAgentAvatar(dataDir: string, id: string) {
  rmSync(avatarPath(dataDir, id), { force: true });
}
