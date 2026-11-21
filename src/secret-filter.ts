import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { ValidationError } from './errors.js';

export const SECRET_REPLACEMENT = '[REDACTED_SECRET]';
export const SECRET_BLOCK_NOTICE = '秘密情報を検出したため、送信を停止しました。';
export const SECRET_AI_WARNING =
  '[xangi security notice]\n' +
  'The secret filter masked content or blocked this operation. ' +
  'Briefly warn the user in their preferred language that secret information was detected and masked or blocked. ' +
  'Do not repeat secret values or the original content, or report a blocked operation as successful. ' +
  'Do not retry by encoding, splitting, using another route, or disabling the filter.';

export function withSecretAIWarning(text: string, detected: boolean): string {
  return detected && !text.includes(SECRET_AI_WARNING) ? `${text}\n\n${SECRET_AI_WARNING}` : text;
}

export class SecretFilterBlockedError extends ValidationError {
  constructor() {
    super(withSecretAIWarning(SECRET_BLOCK_NOTICE, true));
  }
}

/** Exact-value DLP, not an OS sandbox or a detector for unknown credentials. */
export class SecretFilter {
  private readonly values: string[];
  private readonly bytes: Buffer[];

  constructor(values: Iterable<string>) {
    const variants = new Set<string>();
    for (const value of values) {
      if (!value) continue;
      variants.add(value);
      variants.add(JSON.stringify(value).slice(1, -1));
      try {
        variants.add(encodeURIComponent(value));
      } catch {
        // Invalid Unicode: retain the literal and JSON representations.
      }
    }
    this.values = [...variants].sort((a, b) => b.length - a.length);
    this.bytes = this.values.map((value) => Buffer.from(value));
  }

  contains(text: string | Buffer): boolean {
    return typeof text === 'string'
      ? this.values.some((value) => text.includes(value))
      : this.bytes.some((value) => text.includes(value));
  }

  redact(text: string): string {
    if (!this.contains(text)) return text;
    // One pass avoids interpreting '$&' in a secret or re-scanning replacement text.
    const pattern = this.values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return text.replace(new RegExp(pattern.join('|'), 'g'), () => SECRET_REPLACEMENT);
  }

  /** Advisory instruction for AI input/tool-result boundaries, never a user-alert guarantee. */
  redactForAI(text: string): string {
    return withSecretAIWarning(this.redact(text), this.contains(text));
  }

  redactValue<T>(value: T): T {
    if (!this.values.length) return value;
    const seen = new WeakMap<object, unknown>();
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.redact(item);
      if (item && typeof item === 'object' && seen.has(item)) return seen.get(item);
      if (item instanceof Error) {
        const output = new Error(this.redact(item.message));
        Object.setPrototypeOf(output, Object.getPrototypeOf(item));
        seen.set(item, output);
        output.name = this.redact(item.name);
        output.stack = item.stack === undefined ? undefined : this.redact(item.stack);
        for (const [key, entry] of Object.entries(item)) {
          Object.defineProperty(output, this.redact(key), {
            value: walk(entry),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return output;
      }
      if (Buffer.isBuffer(item)) return this.contains(item) ? SECRET_REPLACEMENT : item;
      if (item && typeof item === 'object') {
        if (Array.isArray(item)) {
          const output: unknown[] = [];
          seen.set(item, output);
          output.push(...item.map(walk));
          return output;
        }
        const output: Record<string, unknown> = Object.create(null);
        seen.set(item, output);
        for (const [key, entry] of Object.entries(item)) output[this.redact(key)] = walk(entry);
        return output;
      }
      return item;
    };
    return walk(value) as T;
  }

  assertSafe(text: string | Buffer): void {
    if (this.contains(text)) throw new SecretFilterBlockedError();
  }

  containsValue(value: unknown): boolean {
    const seen = new WeakSet<object>();
    const walk = (item: unknown): boolean => {
      if (typeof item === 'string' || Buffer.isBuffer(item)) return this.contains(item);
      if (item && typeof item === 'object' && !seen.has(item)) {
        seen.add(item);
        if (
          item instanceof Error &&
          (this.contains(item.message) || this.contains(item.stack ?? ''))
        )
          return true;
        return Object.entries(item).some(([key, entry]) => this.contains(key) || walk(entry));
      }
      return false;
    };
    return walk(value);
  }

  assertValueSafe(value: unknown): void {
    if (this.containsValue(value)) throw new SecretFilterBlockedError();
  }

  /** Hold a possible secret prefix until subsequent chunks disambiguate it. */
  pendingPrefixLength(text: string): number {
    let length = 0;
    for (const value of this.values) {
      for (let size = Math.min(text.length, value.length - 1); size > length; size--) {
        if (text.endsWith(value.slice(0, size))) {
          length = size;
          break;
        }
      }
    }
    return length;
  }

  /** UTF-8 literal scanning, including matches spanning read boundaries. No decompression. */
  assertFileSafe(filePath: string): void {
    this.assertSafe(filePath);
    if (!this.bytes.length) return;
    let fd: number | undefined;
    try {
      fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('Not a regular file');
      const buffer = Buffer.alloc(64 * 1024);
      const overlap = Math.max(...this.bytes.map((value) => value.length)) - 1;
      let tail = Buffer.alloc(0);
      let count: number;
      let remaining = stat.size;
      while (
        remaining > 0 &&
        (count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null)) > 0
      ) {
        remaining -= count;
        const chunk = Buffer.concat([tail, buffer.subarray(0, count)]);
        this.assertSafe(chunk);
        tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - overlap)));
      }
      if (remaining > 0) throw new Error('File changed during inspection');
    } catch (error) {
      if (error instanceof SecretFilterBlockedError) throw error;
      // Fail closed; never echo a path or the underlying filesystem/secret error.
      throw new ValidationError('添付ファイルの秘密情報検査に失敗したため、送信を停止しました。');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/** Match nonempty credential values already loaded into the environment. */
export function secretFilterFromEnv(env: NodeJS.ProcessEnv = process.env): SecretFilter {
  if (env.XANGI_SECRET_FILTER_ENABLED === 'false') return new SecretFilter([]);
  const explicit = new Set(
    (env.XANGI_SECRET_FILTER_ENV_KEYS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const secretName = /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|CLIENT_SECRET)$/;
  return new SecretFilter(
    Object.entries(env)
      .filter(
        ([name, value]) =>
          name !== 'XANGI_SECRET_FILTER_ENV_KEYS' &&
          (secretName.test(name) || explicit.has(name)) &&
          value
      )
      .map(([, value]) => value!)
  );
}

/** Streaming output never emits an unfinished prefix of a known secret. */
export class SecretOutputStream {
  private pending = '';
  blocked = false;

  constructor(private readonly filter: SecretFilter) {}

  push(delta: string): string {
    if (this.blocked) return '';
    this.pending += delta;
    if (this.filter.contains(this.pending)) {
      this.blocked = true;
      this.pending = '';
      return '';
    }
    const hold = this.filter.pendingPrefixLength(this.pending);
    const ready = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return ready;
  }

  finish(): string {
    const tail = this.blocked ? '' : this.pending;
    this.pending = '';
    return tail;
  }
}
