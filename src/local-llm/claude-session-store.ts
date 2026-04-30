/**
 * Claude CLI session store
 *
 * channel_id → claude session_id の対応を `~/.izuna-claude-sessions/<channelId>.json` に永続化する。
 * 30 日経過した entry は get() で null を返し、新規 session 開始を促す。
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

interface SessionRecord {
  sessionId: string;
  updatedAt: number; // epoch ms
}

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export class ClaudeSessionStore {
  private readonly dir: string;
  private mkdirOnce: Promise<void> | null = null;

  constructor(dir?: string) {
    this.dir = dir || path.join(os.homedir(), '.izuna-claude-sessions');
  }

  private async ensureDir(): Promise<void> {
    if (!this.mkdirOnce) {
      this.mkdirOnce = fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
    }
    return this.mkdirOnce;
  }

  private filePath(channelId: string): string {
    const safe = channelId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  async get(channelId: string): Promise<string | null> {
    try {
      const buf = await fs.readFile(this.filePath(channelId), 'utf8');
      const rec = JSON.parse(buf) as SessionRecord;
      if (!rec?.sessionId || typeof rec.updatedAt !== 'number') return null;
      if (Date.now() - rec.updatedAt > STALE_MS) return null;
      return rec.sessionId;
    } catch {
      return null;
    }
  }

  async set(channelId: string, sessionId: string): Promise<void> {
    await this.ensureDir();
    const rec: SessionRecord = { sessionId, updatedAt: Date.now() };
    await fs.writeFile(this.filePath(channelId), JSON.stringify(rec, null, 2), 'utf8');
  }

  async clear(channelId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(channelId));
    } catch {
      /* ignore — already gone */
    }
  }
}
