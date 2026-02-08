import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  watchFile,
  unwatchFile,
  renameSync,
  unlinkSync,
} from 'fs';
import { dirname, join } from 'path';
import cron from 'node-cron';
// ─── Types ───────────────────────────────────────────────────────────
export type ScheduleType = 'cron' | 'once' | 'startup';
export type Platform = 'discord' | 'slack';
export interface Schedule {
  id: string;
  type: ScheduleType;
  /** cron式（type='cron'の場合）*/
  expression?: string;
  /** 実行時刻 ISO8601（type='once'の場合）*/
  runAt?: string;
  /** 送信メッセージ or エージェントへのプロンプト */
  message: string;
  /** 送信先チャンネルID */
  channelId: string;
  /** プラットフォーム */
  platform: Platform;
  /** 作成日時 ISO8601 */
  createdAt: string;
  /** 有効/無効 */
  enabled: boolean;
  /** ラベル（任意） */
  label?: string;
}
export interface SendMessageFn {
  (channelId: string, message: string): Promise<void>;
}
export interface AgentRunFn {
  (prompt: string, channelId: string): Promise<string>;
}
// ─── Scheduler ───────────────────────────────────────────────────────
export class Scheduler {
  private schedules: Schedule[] = [];
  private cronJobs = new Map<string, cron.ScheduledTask>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private filePath: string;
  private senders = new Map<Platform, SendMessageFn>();
  private agentRunners = new Map<Platform, AgentRunFn>();
  private watching = false;
  private lastSaveTime = 0;
  private lastReloadTime = 0;
  private quiet: boolean;
  private disabled = false;
  constructor(dataDir?: string, options?: { quiet?: boolean }) {
    this.quiet = options?.quiet ?? false;
    const dir = dataDir || join(process.cwd(), '.xangi');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, 'schedules.json');
    this.load();
  }
  private log(message: string): void {
    if (!this.quiet) {
      console.log(message);
    }
  }
  // ─── Sender Registration ──────────────────────────────────────────
  /**
   * プラットフォームのメッセージ送信関数を登録
   */
  registerSender(platform: Platform, sender: SendMessageFn): void {
    this.senders.set(platform, sender);
  }
  /**
   * プラットフォームのエージェント実行関数を登録
   */
  registerAgentRunner(platform: Platform, runner: AgentRunFn): void {
    this.agentRunners.set(platform, runner);
  }
  // ─── CRUD ─────────────────────────────────────────────────────────
  /**
   * スケジュールを追加
   */
  add(schedule: Omit<Schedule, 'id' | 'createdAt' | 'enabled'>): Schedule {
    // Validate
    if (schedule.type === 'cron') {
      if (!schedule.expression || !cron.validate(schedule.expression)) {
        throw new Error(
          `Invalid cron expression: ${schedule.expression}\n` +
            '例: "0 9 * * *"（毎日9時）, "*/30 * * * *"（30分毎）'
        );
      }
    } else if (schedule.type === 'once') {
      if (!schedule.runAt) {
        throw new Error('runAt is required for one-time schedule');
      }
      const runTime = new Date(schedule.runAt).getTime();
      if (isNaN(runTime)) {
        throw new Error(`Invalid date: ${schedule.runAt}`);
      }
      if (runTime <= Date.now()) {
        throw new Error('runAt must be in the future');
      }
    } else if (schedule.type === 'startup') {
      // startup type needs no additional validation
    } else {
      throw new Error(`Unknown schedule type: ${schedule.type}`);
    }
    const newSchedule: Schedule = {
      ...schedule,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
      enabled: true,
    };
    this.schedules.push(newSchedule);
    this.save();
    if (!this.disabled) {
      this.startJob(newSchedule);
    }
    return newSchedule;
  }
  /**
   * スケジュールを削除
   */
  remove(id: string): boolean {
    const index = this.schedules.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.stopJob(id);
    this.schedules.splice(index, 1);
    this.save();
    return true;
  }
  /**
   * スケジュール一覧を取得
   */
  list(channelId?: string, platform?: Platform): Schedule[] {
    let result = this.schedules;
    if (channelId) {
      result = result.filter((s) => s.channelId === channelId);
    }
    if (platform) {
      result = result.filter((s) => s.platform === platform);
    }
    return result;
  }
  /**
   * スケジュールを取得
   */
  get(id: string): Schedule | undefined {
    return this.schedules.find((s) => s.id === id);
  }
  /**
   * スケジュールを有効/無効に切り替え
   */
  toggle(id: string): Schedule | undefined {
    const schedule = this.schedules.find((s) => s.id === id);
    if (!schedule) return undefined;
    schedule.enabled = !schedule.enabled;
    this.save();
    if (!this.disabled) {
      if (schedule.enabled) {
        this.startJob(schedule);
      } else {
        this.stopJob(id);
      }
    }
    return schedule;
  }
  // ─── Job Management ───────────────────────────────────────────────
  /**
   * 全スケジュールのジョブを開始（起動時に呼ぶ）
   */
  startAll(options?: { enabled?: boolean; startupEnabled?: boolean }): void {
    const schedulerEnabled = options?.enabled ?? true;
    const startupEnabled = options?.startupEnabled ?? true;

    if (!schedulerEnabled) {
      this.disabled = true;
      this.log('[scheduler] Scheduler is disabled (SCHEDULER_ENABLED=false), skipping all jobs');
      this.startWatching();
      return;
    }

    const startupTasks: Schedule[] = [];
    for (const schedule of this.schedules) {
      if (schedule.enabled) {
        if (schedule.type === 'startup') {
          startupTasks.push(schedule);
        } else {
          this.startJob(schedule);
        }
      }
    }
    this.startWatching();
    const regularJobs = this.schedules.filter((s) => s.enabled && s.type !== 'startup').length;
    this.log(`[scheduler] Started ${regularJobs} jobs, ${startupTasks.length} startup tasks`);

    if (!startupEnabled) {
      this.log('[scheduler] Startup tasks disabled (STARTUP_ENABLED=false), skipping');
      return;
    }

    // Execute startup tasks
    for (const task of startupTasks) {
      this.log(`[scheduler] Executing startup task: ${task.id}`);
      this.executeJob(task).catch((err) => {
        console.error(`[scheduler] Startup task failed: ${task.id}`, err);
      });
    }
  }
  /**
   * 全ジョブを停止（シャットダウン時に呼ぶ）
   */
  stopAll(): void {
    this.stopWatching();
    for (const [id] of this.cronJobs) {
      this.stopJob(id);
    }
    for (const [id] of this.timers) {
      this.stopJob(id);
    }
  }
  // ─── File Watching ────────────────────────────────────────────────
  /**
   * ファイル変更を監視して自動リロード（CLI等からの外部変更を検知）
   */
  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.filePath, { interval: 2000 }, () => {
      const now = Date.now();
      // 自分自身の保存による変更は無視（2秒以内）
      if (now - this.lastSaveTime < 2000) return;
      // 連続イベント発火を防ぐ（debounce: 1秒以内の重複は無視）
      if (now - this.lastReloadTime < 1000) return;
      this.lastReloadTime = now;
      this.log('[scheduler] File change detected, reloading...');
      this.reload();
    });
  }
  private stopWatching(): void {
    if (!this.watching) return;
    unwatchFile(this.filePath);
    this.watching = false;
  }
  /**
   * ファイルから再読み込みしてジョブを再起動
   */
  private reload(): void {
    // 既存ジョブを全停止
    for (const [id] of this.cronJobs) {
      this.stopJob(id);
    }
    for (const [id] of this.timers) {
      this.stopJob(id);
    }
    // 再読み込み
    this.load();
    // 有効なジョブを再開（スケジューラ無効時はスキップ）
    if (!this.disabled) {
      for (const schedule of this.schedules) {
        if (schedule.enabled) {
          this.startJob(schedule);
        }
      }
    }
    this.log(`[scheduler] Reloaded: ${this.schedules.filter((s) => s.enabled).length} active jobs`);
  }
  private startJob(schedule: Schedule): void {
    // 既に動いていたら止める
    this.stopJob(schedule.id);
    if (schedule.type === 'cron' && schedule.expression) {
      const task = cron.schedule(
        schedule.expression,
        () => {
          this.executeJob(schedule);
        },
        { timezone: 'Asia/Tokyo' }
      );
      this.cronJobs.set(schedule.id, task);
      this.log(
        `[scheduler] Cron job started: ${schedule.id} (${schedule.expression}) → ${schedule.channelId}`
      );
    } else if (schedule.type === 'once' && schedule.runAt) {
      const delay = new Date(schedule.runAt).getTime() - Date.now();
      if (delay <= 0) {
        // 既に過ぎている → 即実行して削除
        this.log(`[scheduler] One-time job ${schedule.id} is past due, executing now`);
        this.executeJob(schedule);
        this.remove(schedule.id);
        return;
      }
      const timer = setTimeout(() => {
        this.executeJob(schedule);
        // 単発は実行後に削除
        this.remove(schedule.id);
      }, delay);
      this.timers.set(schedule.id, timer);
      const runDate = new Date(schedule.runAt);
      this.log(
        `[scheduler] Timer set: ${schedule.id} → ${runDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} (${Math.round(delay / 1000)}s)`
      );
    }
  }
  private stopJob(id: string): void {
    const cronJob = this.cronJobs.get(id);
    if (cronJob) {
      cronJob.stop();
      this.cronJobs.delete(id);
    }
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
  private async executeJob(schedule: Schedule): Promise<void> {
    // 常にagentモードで実行
    const agentRunner = this.agentRunners.get(schedule.platform);
    if (!agentRunner) {
      // agentRunnerがない場合はフォールバック
      const sender = this.senders.get(schedule.platform);
      if (sender) {
        const prefix = schedule.label ? `⏰ **${schedule.label}**\n` : '⏰ ';
        await sender(schedule.channelId, `${prefix}${schedule.message}`);
        this.log(`[scheduler] Executed (fallback): ${schedule.id} → ${schedule.channelId}`);
      } else {
        console.error(`[scheduler] No runner/sender for platform: ${schedule.platform}`);
      }
      return;
    }
    try {
      this.log(`[scheduler] Running agent for: ${schedule.id}`);
      const result = await agentRunner(schedule.message, schedule.channelId);
      this.log(`[scheduler] Agent completed: ${schedule.id} (${result.length} chars)`);
    } catch (error) {
      console.error(`[scheduler] Failed to execute ${schedule.id}:`, error);
    }
  }
  // ─── Persistence ──────────────────────────────────────────────────
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.schedules = JSON.parse(raw);
        this.log(`[scheduler] Loaded ${this.schedules.length} schedules from ${this.filePath}`);
      }
    } catch (error) {
      console.error('[scheduler] Failed to load schedules:', error);
      this.schedules = [];
    }
  }
  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.lastSaveTime = Date.now();
      // アトミック書き込み: 一時ファイル → リネーム
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.schedules, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error('[scheduler] Failed to save schedules:', error);
      // 一時ファイルが残っていたら削除
      const tmpPath = `${this.filePath}.tmp`;
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // クリーンアップ失敗は無視
      }
    }
  }
  private generateId(): string {
    return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
}
// ─── Formatter ───────────────────────────────────────────────────────
/**
 * スケジュール一覧をフォーマット
 */
export function formatScheduleList(
  schedules: Schedule[],
  options?: { enabled?: boolean; startupEnabled?: boolean }
): string {
  const schedulerEnabled = options?.enabled ?? true;
  const startupEnabled = options?.startupEnabled ?? true;

  const statusHeader: string[] = [];
  if (!schedulerEnabled) {
    statusHeader.push('⚠️ **スケジューラは無効です** (`SCHEDULER_ENABLED=false`)');
  }
  if (!startupEnabled) {
    statusHeader.push('⚠️ **スタートアップは無効です** (`STARTUP_ENABLED=false`)');
  }

  if (schedules.length === 0) {
    const header = statusHeader.length > 0 ? statusHeader.join('\n') + '\n\n' : '';
    return header + '📋 スケジュールはありません';
  }

  // Split into regular schedules and startup tasks
  const regularSchedules = schedules.filter((s) => s.type !== 'startup');
  const startupTasks = schedules.filter((s) => s.type === 'startup');

  const formatItem = (s: Schedule, i: number): string => {
    const status = s.enabled ? '✅' : '⏸️';
    const label = s.label ? ` [${s.label}]` : '';
    const channelMention = `<#${s.channelId}>`;

    if (s.type === 'cron' && s.expression) {
      const humanReadable = cronToHuman(s.expression);
      return (
        `**${i + 1}.** ${status} 📅 ${humanReadable}${label}\n` +
        `└ 📝 ${s.message}\n` +
        `└ 📢 ${channelMention}\n` +
        `└ 🔄 \`${s.expression}\`\n` +
        `└ 🆔 \`${s.id}\``
      );
    } else if (s.type === 'startup') {
      return (
        `**${i + 1}.** ${status} 🚀 起動時に実行${label}\n` +
        `└ 📝 ${s.message}\n` +
        `└ 📢 ${channelMention}\n` +
        `└ 🆔 \`${s.id}\``
      );
    } else {
      // once (単発)
      return (
        `**${i + 1}.** ${status} ⏰ ${formatTime(s.runAt!)}${label}\n` +
        `└ 📝 ${s.message}\n` +
        `└ 📢 ${channelMention}\n` +
        `└ 🆔 \`${s.id}\``
      );
    }
  };

  const sections: string[] = [];

  if (regularSchedules.length > 0) {
    const lines = regularSchedules.map((s, i) => formatItem(s, i));
    sections.push(
      `📋 **スケジュール一覧** (${regularSchedules.length}件)\n\n${lines.join('\n\n')}`
    );
  }

  if (startupTasks.length > 0) {
    const lines = startupTasks.map((s, i) => formatItem(s, i));
    sections.push(
      `🚀 **スタートアップタスク** (${startupTasks.length}件)\n\n${lines.join('\n\n')}`
    );
  }

  const header = statusHeader.length > 0 ? statusHeader.join('\n') + '\n\n' : '';
  return header + sections.join('\n\n') + '\n';
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
/**
 * cron式を人間が読める形式に変換
 * @param expression cron式 (分 時 日 月 曜日)
 */
function cronToHuman(expression: string): string {
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
  // 曜日マップ
  const dayNames: Record<string, string> = {
    '0': '日',
    '1': '月',
    '2': '火',
    '3': '水',
    '4': '木',
    '5': '金',
    '6': '土',
    '7': '日',
  };
  // 時刻をフォーマット
  const formatHourMin = (h: string, m: string): string => {
    if (h === '*' && m === '*') return '';
    if (h === '*') return `毎時 ${m}分`;
    if (m === '*') return `${h}時台`;
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  };
  // 毎N分/毎N時間
  const intervalMatch = min.match(/^\*\/(\d+)$/);
  if (intervalMatch && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `${intervalMatch[1]}分毎`;
  }
  const hourIntervalMatch = hour.match(/^\*\/(\d+)$/);
  if (
    hourIntervalMatch &&
    min !== '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `${hourIntervalMatch[1]}時間毎 (${min}分)`;
  }
  // 毎時
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return min === '0' ? '毎時' : `毎時 ${min}分`;
  }
  // 毎日
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `毎日 ${formatHourMin(hour, min)}`;
  }
  // 特定の曜日
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    // 範囲形式 (1-5 = 月〜金)
    const rangeMatch = dayOfWeek.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = dayNames[rangeMatch[1]] || rangeMatch[1];
      const end = dayNames[rangeMatch[2]] || rangeMatch[2];
      if (start === '月' && end === '金') {
        return `平日 ${formatHourMin(hour, min)}`;
      }
      return `${start}〜${end}曜 ${formatHourMin(hour, min)}`;
    }
    // 単一の曜日
    const dayName = dayNames[dayOfWeek] || dayOfWeek;
    return `毎週${dayName}曜 ${formatHourMin(hour, min)}`;
  }
  // 特定の日
  if (dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    return `毎月${dayOfMonth}日 ${formatHourMin(hour, min)}`;
  }
  // その他: そのまま返す
  return expression;
}
// ─── Parser ──────────────────────────────────────────────────────────
/**
 * 自然言語風の入力をパースしてスケジュールパラメータに変換
 *
 * 対応フォーマット:
 * - "30分後 ミーティング開始" → once, 30分後
 * - "1時間後 休憩しよう" → once, 1時間後
 * - "15:00 レビュー" → once, 今日15:00（過ぎていたら明日）
 * - "毎日 9:00 おはよう" → cron, 0 9 * * *
 * - "毎時 チェック" → cron, 0 * * * *
 * - "cron 0 9 * * * おはよう" → cron, 直接指定
 */
export function parseScheduleInput(input: string): {
  type: ScheduleType;
  expression?: string;
  runAt?: string;
  message: string;
  targetChannelId?: string;
} | null {
  let trimmed = input.trim();
  // --agent オプションは無視（常にagentモードで動作）
  trimmed = trimmed.replace(/(?:^|\s)--agent(?:\s|$)/, ' ').trim();
  // -c <#channelId> または --channel <#channelId> オプションを抽出
  let targetChannelId: string | undefined;
  const channelOptMatch = trimmed.match(/(?:^|\s)(?:-c|--channel)\s+<#(\d+)>(?:\s|$)/);
  if (channelOptMatch) {
    targetChannelId = channelOptMatch[1];
    trimmed = trimmed.replace(channelOptMatch[0], ' ').trim();
  }
  // <#channelId> が先頭にある場合も対応
  const channelPrefixMatch = trimmed.match(/^<#(\d+)>\s+/);
  if (!targetChannelId && channelPrefixMatch) {
    targetChannelId = channelPrefixMatch[1];
    trimmed = trimmed.replace(channelPrefixMatch[0], '').trim();
  }
  // cron式の直接指定: "cron 0 9 * * * メッセージ"
  const cronMatch = trimmed.match(/^cron\s+((?:\S+\s+){4}\S+)\s+(.+)$/i);
  if (cronMatch) {
    return {
      type: 'cron',
      expression: cronMatch[1].trim(),
      message: cronMatch[2].trim(),
      targetChannelId,
    };
  }
  // "毎日 HH:MM メッセージ"
  const dailyMatch = trimmed.match(/^毎日\s+(\d{1,2}):(\d{2})\s+(.+)$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const min = parseInt(dailyMatch[2], 10);
    return {
      type: 'cron',
      expression: `${min} ${hour} * * *`,
      message: dailyMatch[3].trim(),
      targetChannelId,
    };
  }
  // "毎時 メッセージ" or "毎時 MM分 メッセージ"
  const hourlyMatch = trimmed.match(/^毎時\s+(?:(\d{1,2})分\s+)?(.+)$/);
  if (hourlyMatch) {
    const min = hourlyMatch[1] ? parseInt(hourlyMatch[1], 10) : 0;
    return {
      type: 'cron',
      expression: `${min} * * * *`,
      message: hourlyMatch[2].trim(),
      targetChannelId,
    };
  }
  // "毎週月曜 HH:MM メッセージ" (曜日対応)
  const weeklyMatch = trimmed.match(/^毎週(月|火|水|木|金|土|日)曜?\s+(\d{1,2}):(\d{2})\s+(.+)$/);
  if (weeklyMatch) {
    const dayMap: Record<string, number> = {
      日: 0,
      月: 1,
      火: 2,
      水: 3,
      木: 4,
      金: 5,
      土: 6,
    };
    const day = dayMap[weeklyMatch[1]] ?? 1;
    const hour = parseInt(weeklyMatch[2], 10);
    const min = parseInt(weeklyMatch[3], 10);
    return {
      type: 'cron',
      expression: `${min} ${hour} * * ${day}`,
      message: weeklyMatch[4].trim(),
      targetChannelId,
    };
  }
  // "N分後 メッセージ" or "N時間後 メッセージ"
  const relativeMatch = trimmed.match(/^(\d+)\s*(分|時間|秒)後?\s+(.+)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    let ms: number;
    switch (unit) {
      case '秒':
        ms = amount * 1000;
        break;
      case '分':
        ms = amount * 60 * 1000;
        break;
      case '時間':
        ms = amount * 60 * 60 * 1000;
        break;
      default:
        return null;
    }
    return {
      type: 'once',
      runAt: new Date(Date.now() + ms).toISOString(),
      message: relativeMatch[3].trim(),
      targetChannelId,
    };
  }
  // "HH:MM メッセージ" → 今日のその時刻（過ぎていたら明日）
  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const min = parseInt(timeMatch[2], 10);
    const now = new Date();
    // Asia/Tokyo で設定
    const jstOffset = 9 * 60; // JST = UTC+9
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const jstMinutes = utcMinutes + jstOffset;
    const targetMinutes = hour * 60 + min;
    // JSTベースで今日か明日かを判定
    const currentJstMinutes = jstMinutes % (24 * 60);
    let diffMinutes = targetMinutes - currentJstMinutes;
    if (diffMinutes <= 0) {
      diffMinutes += 24 * 60; // 明日
    }
    const runAt = new Date(now.getTime() + diffMinutes * 60 * 1000);
    return {
      type: 'once',
      runAt: runAt.toISOString(),
      message: timeMatch[3].trim(),
      targetChannelId,
    };
  }
  // "YYYY-MM-DD HH:MM メッセージ"
  const dateTimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/);
  if (dateTimeMatch) {
    const dateStr = dateTimeMatch[1];
    const hour = parseInt(dateTimeMatch[2], 10);
    const min = parseInt(dateTimeMatch[3], 10);
    // JST として解釈
    const runAt = new Date(
      `${dateStr}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+09:00`
    );
    return {
      type: 'once',
      runAt: runAt.toISOString(),
      message: dateTimeMatch[4].trim(),
      targetChannelId,
    };
  }
  // "起動時 メッセージ" or "startup メッセージ"
  const startupMatch = trimmed.match(/^(?:起動時|startup)\s+(.+)$/i);
  if (startupMatch) {
    return {
      type: 'startup',
      message: startupMatch[1].trim(),
      targetChannelId,
    };
  }
  return null;
}
