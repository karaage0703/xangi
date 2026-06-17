/**
 * 環境変数の軽量バリデータ。
 *
 * 方針:
 * - 不正な値は「分かりやすい警告 + デフォルト値へのフォールバック」で起動を続行する
 *   （後方互換: 既存の有効な設定はそのまま通り、これまで NaN や typo が
 *   黙って素通りしていた値だけが警告対象になる）
 * - `XANGI_CONFIG_STRICT=true` の場合は警告をエラーに格上げして起動を中断する
 * - 外部依存なし（zod 等は追加しない）
 */

export interface ConfigIssue {
  /** 環境変数名 */
  key: string;
  /** 実際に設定されていた値 */
  value: string;
  /** 何が問題か + どうフォールバックしたか */
  message: string;
}

export class EnvValidator {
  readonly issues: ConfigIssue[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private raw(key: string): string | undefined {
    const v = this.env[key];
    if (v === undefined || v.trim() === '') return undefined;
    return v.trim();
  }

  /** 呼び出し側で検出した問題を登録する（カスタム検証用） */
  issue(key: string, value: string, message: string): void {
    this.issues.push({ key, value, message });
  }

  private addIssue(key: string, value: string, message: string): void {
    this.issue(key, value, message);
  }

  /** 整数 env。未設定なら def。数値でない / 範囲外なら警告して def */
  int(key: string, def: number, opts: { min?: number; max?: number } = {}): number {
    const raw = this.raw(key);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      this.addIssue(key, raw, `整数ではありません。デフォルト ${def} を使用します`);
      return def;
    }
    if (opts.min !== undefined && n < opts.min) {
      this.addIssue(key, raw, `${opts.min} 以上が必要です。デフォルト ${def} を使用します`);
      return def;
    }
    if (opts.max !== undefined && n > opts.max) {
      this.addIssue(key, raw, `${opts.max} 以下が必要です。デフォルト ${def} を使用します`);
      return def;
    }
    return n;
  }

  /** 小数 env。未設定なら def。数値でない / 範囲外なら警告して def */
  float(key: string, def: number, opts: { min?: number; max?: number } = {}): number {
    const raw = this.raw(key);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      this.addIssue(key, raw, `数値ではありません。デフォルト ${def} を使用します`);
      return def;
    }
    if (opts.min !== undefined && n < opts.min) {
      this.addIssue(key, raw, `${opts.min} 以上が必要です。デフォルト ${def} を使用します`);
      return def;
    }
    if (opts.max !== undefined && n > opts.max) {
      this.addIssue(key, raw, `${opts.max} 以下が必要です。デフォルト ${def} を使用します`);
      return def;
    }
    return n;
  }

  /** enum env（大文字小文字無視）。未設定なら def。許可外なら警告して def */
  enumOf<T extends string>(key: string, allowed: readonly T[], def: T): T {
    const raw = this.raw(key);
    if (raw === undefined) return def;
    const lower = raw.toLowerCase();
    const hit = allowed.find((a) => a.toLowerCase() === lower);
    if (hit) return hit;
    this.addIssue(
      key,
      raw,
      `許可される値は ${allowed.join(' / ')} です。デフォルト '${def}' を使用します`
    );
    return def;
  }

  /**
   * CSV の enum リスト env。未設定なら undefined。
   * 許可外の項目は警告して除外する（有効な項目は残す）
   */
  enumList<T extends string>(key: string, allowed: readonly T[]): T[] | undefined {
    const raw = this.raw(key);
    if (raw === undefined) return undefined;
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const valid: T[] = [];
    for (const item of items) {
      const hit = allowed.find((a) => a.toLowerCase() === item.toLowerCase());
      if (hit) {
        valid.push(hit);
      } else {
        this.addIssue(
          key,
          item,
          `'${item}' は許可される値 (${allowed.join(' / ')}) ではないため無視します`
        );
      }
    }
    return valid;
  }

  /**
   * 検証結果のレポート。
   * 問題があれば一覧を console.error に出し、XANGI_CONFIG_STRICT=true なら throw する
   */
  report(label = 'config'): void {
    if (this.issues.length === 0) return;
    console.error(`[xangi] ⚠️  ${label}: 環境変数に ${this.issues.length} 件の問題があります:`);
    for (const issue of this.issues) {
      console.error(`[xangi]   - ${issue.key}=${issue.value}: ${issue.message}`);
    }
    if (this.env.XANGI_CONFIG_STRICT === 'true') {
      throw new Error(
        `Invalid environment configuration (${this.issues.length} issue(s)): ` +
          this.issues.map((i) => `${i.key}=${i.value}`).join(', ')
      );
    }
    console.error('[xangi]   (XANGI_CONFIG_STRICT=true にすると起動を中断できます)');
  }
}

const VALID_BACKENDS = ['claude-code', 'codex', 'cursor', 'grok', 'local-llm'] as const;
const VALID_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const VALID_LLM_MODES = ['agent', 'lite', 'chat'] as const;

export interface ChannelOverrideIssue {
  channelId: string;
  message: string;
}

/**
 * CHANNEL_OVERRIDES (JSON 文字列) のスキーマ検証。
 * 不正なエントリ・不正なフィールド値は issue として返し、有効な部分だけを残す。
 * JSON 自体が壊れている場合は overrides=null。
 */
export function validateChannelOverrides(raw: string): {
  overrides: Record<
    string,
    { backend?: string; model?: string; effort?: string; localLlmMode?: string }
  > | null;
  issues: ChannelOverrideIssue[];
} {
  const issues: ChannelOverrideIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      overrides: null,
      issues: [{ channelId: '(全体)', message: `JSON として解析できません: ${e}` }],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      overrides: null,
      issues: [
        { channelId: '(全体)', message: 'オブジェクト ({"<channelId>": {...}}) が必要です' },
      ],
    };
  }

  const result: Record<
    string,
    { backend?: string; model?: string; effort?: string; localLlmMode?: string }
  > = {};

  for (const [channelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(channelId)) {
      issues.push({
        channelId,
        message: `チャンネル ID が数値ではありません（typo の可能性）。このエントリは読み込みますが確認してください`,
      });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ channelId, message: 'オブジェクトが必要です。このエントリは無視します' });
      continue;
    }
    const o = value as Record<string, unknown>;
    const entry: { backend?: string; model?: string; effort?: string; localLlmMode?: string } = {};
    let valid = true;

    if (o.backend !== undefined) {
      if (
        typeof o.backend === 'string' &&
        (VALID_BACKENDS as readonly string[]).includes(o.backend)
      ) {
        entry.backend = o.backend;
      } else {
        issues.push({
          channelId,
          message: `backend '${String(o.backend)}' は不正です (${VALID_BACKENDS.join(' / ')})。このエントリは無視します`,
        });
        valid = false;
      }
    }
    if (o.model !== undefined) {
      if (typeof o.model === 'string') {
        entry.model = o.model;
      } else {
        issues.push({ channelId, message: `model は文字列が必要です。このエントリは無視します` });
        valid = false;
      }
    }
    if (o.effort !== undefined) {
      if (typeof o.effort === 'string' && (VALID_EFFORTS as readonly string[]).includes(o.effort)) {
        entry.effort = o.effort;
      } else {
        issues.push({
          channelId,
          message: `effort '${String(o.effort)}' は不正です (${VALID_EFFORTS.join(' / ')})。このエントリは無視します`,
        });
        valid = false;
      }
    }
    if (o.localLlmMode !== undefined) {
      if (
        typeof o.localLlmMode === 'string' &&
        (VALID_LLM_MODES as readonly string[]).includes(o.localLlmMode)
      ) {
        entry.localLlmMode = o.localLlmMode;
      } else {
        issues.push({
          channelId,
          message: `localLlmMode '${String(o.localLlmMode)}' は不正です (${VALID_LLM_MODES.join(' / ')})。このエントリは無視します`,
        });
        valid = false;
      }
    }

    if (valid) {
      result[channelId] = entry;
    }
  }

  return { overrides: result, issues };
}
