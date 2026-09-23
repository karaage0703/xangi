import { randomInt } from 'node:crypto';
import type { Api } from 'grammy';

let nextId = randomInt(1, 2_147_483_647);

export function nextTelegramDraftId(): number {
  const id = nextId;
  nextId = nextId === 2_147_483_647 ? 1 : nextId + 1;
  return id;
}

export function isUnsupportedTelegramDraftError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const status = record.error_code ?? record.statusCode ?? record.status;
  const description = String(record.description ?? record.message ?? '');
  return (
    status === 400 &&
    /method.*not found|unknown method|sendMessageDraft.*not supported/i.test(description)
  );
}

export class TelegramDraftPreview {
  readonly draftId = nextTelegramDraftId();
  private readonly controller = new AbortController();
  private heartbeat?: NodeJS.Timeout;
  private lastText = '';
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private stopped = false;
  private failed = false;

  constructor(
    private readonly api: Pick<Api, 'sendMessageDraft'>,
    private readonly chatId: number,
    private readonly messageThreadId: number | undefined,
    private readonly isCurrent: () => boolean,
    private readonly onFailure: (error: unknown) => void
  ) {}

  start(): void {
    void this.update('考え中...');
    this.heartbeat = setInterval(() => {
      if (this.lastText) void this.send(this.lastText, true);
    }, 20_000);
    this.heartbeat.unref();
  }

  async update(text: string): Promise<void> {
    if (this.stopped || this.failed || !this.isCurrent()) return;
    this.lastText = text;
    await this.send(text, false);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.controller.abort();
  }

  private async send(text: string, heartbeat: boolean): Promise<void> {
    if (this.stopped || this.failed || !this.isCurrent() || this.inFlight) return;
    const now = Date.now();
    if (!heartbeat && now - this.lastSentAt < 1_000) return;
    this.inFlight = true;
    this.lastSentAt = now;
    try {
      await this.api.sendMessageDraft(
        this.chatId,
        this.draftId,
        text,
        {
          ...(this.messageThreadId === undefined
            ? {}
            : { message_thread_id: this.messageThreadId }),
          can_stop: true,
        },
        this.controller.signal as Parameters<Api['sendMessageDraft']>[4]
      );
    } catch (error) {
      if (!this.stopped) {
        this.failed = true;
        this.onFailure(error);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

interface ActiveDraft {
  chatId: number;
  messageThreadId?: number;
  contextKey: string;
  generation: number;
  stop?: () => void;
}

export class TelegramDraftRegistry {
  private readonly active = new Map<number, ActiveDraft>();

  register(draftId: number, draft: ActiveDraft): void {
    this.active.set(draftId, draft);
  }

  unregister(draftId: number): void {
    this.active.delete(draftId);
  }

  stopContext(contextKey: string, reason = 'unknown'): void {
    for (const [draftId, draft] of this.active) {
      if (draft.contextKey !== contextKey) continue;
      console.info(`[xangi-telegram] Draft invalidated: ${draftId} (${reason})`);
      this.active.delete(draftId);
      draft.stop?.();
    }
  }

  consumeStop(
    draftId: number | string,
    chatId: number,
    messageThreadId: number | undefined,
    currentGeneration: (contextKey: string) => number,
    onMismatch?: (reason: 'missing' | 'chat' | 'topic' | 'generation') => void
  ): string | undefined {
    const normalizedDraftId = Number(draftId);
    if (!Number.isSafeInteger(normalizedDraftId) || normalizedDraftId <= 0) {
      onMismatch?.('missing');
      return undefined;
    }
    const draft = this.active.get(normalizedDraftId);
    if (!draft) {
      console.info(
        `[xangi-telegram] Draft lookup miss: received=${JSON.stringify(draftId)} type=${typeof draftId} active=${JSON.stringify([...this.active.keys()])}`
      );
      onMismatch?.('missing');
      return undefined;
    }
    if (draft.chatId !== chatId) {
      onMismatch?.('chat');
      return undefined;
    }
    // Telegram may omit the topic from either side of a private-chat stop update.
    // The draft ID is unique within this registry, so an absent topic is safe to accept.
    if (
      draft.messageThreadId !== undefined &&
      messageThreadId !== undefined &&
      draft.messageThreadId !== messageThreadId
    ) {
      onMismatch?.('topic');
      return undefined;
    }
    this.active.delete(normalizedDraftId);
    if (currentGeneration(draft.contextKey) !== draft.generation) {
      onMismatch?.('generation');
      return undefined;
    }
    draft.stop?.();
    return draft.contextKey;
  }
}
