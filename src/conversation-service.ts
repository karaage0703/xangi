import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { reserveConversation } from './conversation-locks.js';

export interface ConversationInput {
  /** Internal child completion; never mirror this as a Web user's message. */
  source?: 'agent-completion';
  requestId: string;
  appSessionId: string;
  contextKey: string;
  message: string;
  attachments: string[];
}

export interface ConversationTurn extends ConversationInput {
  id: string;
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  result?: string;
  resultAttachments?: string[];
  assistantMessageId?: string;
  assistantName?: string;
  error?: string;
  delivery: 'none' | 'pending' | 'sending' | 'delivered' | 'failed' | 'unknown';
  deliveryError?: string;
  messageIds?: string[];
}

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class DeliveryUnavailable extends Error {}

interface Options {
  directory: string;
  busy: (input: ConversationInput) => boolean;
  execute: (
    turn: ConversationTurn,
    cancelled: () => boolean
  ) => Promise<{
    text: string;
    attachments?: string[];
    assistantMessageId?: string;
    assistantName?: string;
  }>;
  deliver: (turn: ConversationTurn) => Promise<string[] | undefined>;
  changed: () => void;
}

/** Durable receipts own execution; an HTTP connection never owns a turn. */
export class ConversationService {
  private readonly changeListeners = new Set<() => void>();
  private readonly records = new Map<string, ConversationTurn>();
  private readonly tasks = new Map<string, Promise<void>>();
  private closing = false;
  private readonly cancelled = new Set<string>();

  constructor(private readonly options: Options) {
    mkdirSync(options.directory, { recursive: true });
    for (const name of readdirSync(options.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = JSON.parse(
        readFileSync(join(options.directory, name), 'utf8')
      ) as ConversationTurn;
      if (this.key(record.appSessionId, record.requestId) + '.json' !== name)
        throw new Error('Invalid conversation receipt');
      if (record.state === 'running') record.state = 'interrupted';
      if (record.delivery === 'sending') record.delivery = 'unknown';
      this.save(record);
      this.records.set(this.key(record.appSessionId, record.requestId), record);
    }
  }

  private key(sessionId: string, requestId: string): string {
    return createHash('sha256')
      .update(JSON.stringify([sessionId, requestId]))
      .digest('hex');
  }

  private save(record: ConversationTurn): void {
    record.updatedAt = new Date().toISOString();
    const path = join(
      this.options.directory,
      this.key(record.appSessionId, record.requestId) + '.json'
    );
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flush: true });
    renameSync(temporary, path);
    for (const listener of this.changeListeners) listener();
  }

  lookup(sessionId: string, requestId: string): ConversationTurn | undefined {
    const record = this.records.get(this.key(sessionId, requestId));
    return record ? structuredClone(record) : undefined;
  }

  /** Notification-backed receipt read, bounded so disconnects never retain listeners. */
  async waitForChange(
    sessionId: string,
    requestId: string,
    after: string,
    signal: AbortSignal
  ): Promise<ConversationTurn | undefined> {
    const version = (record: ConversationTurn | undefined) =>
      record ? JSON.stringify([record.state, record.delivery, record.updatedAt]) : '';
    const initial = this.lookup(sessionId, requestId);
    if (signal.aborted || version(initial) !== after) return initial;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.changeListeners.delete(changed);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const changed = () => {
        if (version(this.lookup(sessionId, requestId)) !== after) finish();
      };
      const timer = setTimeout(finish, 8000);
      this.changeListeners.add(changed);
      signal.addEventListener('abort', finish, { once: true });
      changed();
    });
    return this.lookup(sessionId, requestId);
  }

  submit(input: ConversationInput): ConversationTurn {
    if (this.closing) throw new ConversationError('サーバーを終了しています', 503);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId))
      throw new ConversationError('requestIdが不正です', 400);
    const previous = this.lookup(input.appSessionId, input.requestId);
    if (previous) {
      if (
        previous.source !== input.source ||
        previous.message !== input.message ||
        JSON.stringify(previous.attachments) !== JSON.stringify(input.attachments)
      )
        throw new ConversationError('同じrequestIdに異なる入力は送信できません', 409);
      return previous;
    }
    if (this.options.busy(input)) throw new ConversationError('この会話は処理中です', 409);
    const release = reserveConversation(input.contextKey);
    if (!release) throw new ConversationError('この会話は処理中です', 409);
    const now = new Date().toISOString();
    const record: ConversationTurn = {
      ...structuredClone(input),
      id: randomUUID(),
      state: 'accepted',
      createdAt: now,
      updatedAt: now,
      delivery: 'none',
    };
    try {
      this.save(record);
      this.records.set(this.key(input.appSessionId, input.requestId), record);
    } catch (error) {
      release();
      throw error;
    }
    this.start(record, release);
    return structuredClone(record);
  }

  private start(record: ConversationTurn, release: () => void): void {
    // Scheduling after submit returns makes receipt persistence precede execution.
    const task = Promise.resolve()
      .then(async () => {
        try {
          if (this.cancelled.has(record.id)) return;
          record.state = 'running';
          this.save(record);
          this.options.changed();
          const result = await this.options.execute(structuredClone(record), () =>
            this.cancelled.has(record.id)
          );
          if (this.cancelled.has(record.id)) return;
          record.result = result.text;
          record.resultAttachments = result.attachments;
          record.assistantMessageId = result.assistantMessageId;
          record.assistantName = result.assistantName;
          record.state = 'completed';
          record.delivery = 'pending';
          this.save(record);
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          record.state =
            this.cancelled.has(record.id) || record.error === 'Request cancelled by user'
              ? 'cancelled'
              : 'failed';
          this.save(record);
        } finally {
          release();
          this.options.changed();
        }
        if (record.state === 'completed') await this.deliver(record);
      })
      .catch((error: unknown) => {
        // A storage failure must never turn into an unhandled process rejection.
        console.error('[conversation] Failed to persist turn state:', error);
      })
      .finally(() => this.tasks.delete(record.id));
    this.tasks.set(record.id, task);
  }

  /** Start only receipts that never entered running. Interrupted turns are not replayed. */
  resume(): void {
    for (const record of this.records.values()) {
      if (record.state === 'completed' && record.delivery === 'pending') {
        const task = this.deliver(record)
          .catch((error: unknown) =>
            console.error('[conversation] Failed to resume delivery:', error)
          )
          .finally(() => this.tasks.delete(record.id));
        this.tasks.set(record.id, task);
        continue;
      }
      if (record.state !== 'accepted' || this.options.busy(record)) continue;
      const release = reserveConversation(record.contextKey);
      if (release) this.start(record, release);
    }
  }

  cancel(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.appSessionId !== sessionId || !['accepted', 'running'].includes(record.state))
        continue;
      this.cancelled.add(record.id);
      record.state = 'cancelled';
      this.save(record);
    }
    this.options.changed();
  }

  private async deliver(record: ConversationTurn): Promise<void> {
    record.delivery = 'sending';
    this.save(record);
    try {
      const ids = await this.options.deliver(structuredClone(record));
      record.messageIds = ids;
      record.delivery = ids ? 'delivered' : 'none';
      record.deliveryError = undefined;
    } catch (error) {
      record.delivery = error instanceof DeliveryUnavailable ? 'failed' : 'unknown';
      record.deliveryError = error instanceof Error ? error.message : String(error);
    }
    this.save(record);
    this.options.changed();
  }

  async retryDelivery(sessionId: string, requestId: string): Promise<ConversationTurn> {
    const record = this.records.get(this.key(sessionId, requestId));
    if (!record) throw new ConversationError('受付が見つかりません', 404);
    if (record.state !== 'completed' || !['pending', 'failed'].includes(record.delivery))
      throw new ConversationError('投稿結果が未確定、または再投稿が不要です', 409);
    await this.deliver(record);
    return structuredClone(record);
  }

  async idle(): Promise<void> {
    await Promise.all(this.tasks.values());
  }

  /** Await one durable request, including delivery, without waiting for other conversations. */
  async settled(sessionId: string, requestId: string): Promise<ConversationTurn> {
    const record = this.lookup(sessionId, requestId);
    if (!record) throw new ConversationError('受付が見つかりません', 404);
    await this.tasks.get(record.id);
    return this.lookup(sessionId, requestId)!;
  }

  forget(sessionId: string): void {
    const records = [...this.records.values()].filter(
      (record) => record.appSessionId === sessionId
    );
    if (records.some((record) => this.tasks.has(record.id)))
      throw new ConversationError('処理や投稿の完了後に会話を削除してください', 409);
    for (const record of records) {
      const key = this.key(sessionId, record.requestId);
      unlinkSync(join(this.options.directory, key + '.json'));
      this.records.delete(key);
    }
  }

  close(): void {
    this.closing = true;
  }
}
