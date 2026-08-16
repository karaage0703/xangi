/**
 * スケジュール操作CLIモジュール
 *
 * Tool Server からは実行中の Scheduler を同期更新する。
 * 単体CLI・テストでは .xangi/schedules.json を直接操作する。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import {
  parseScheduleInput,
  formatScheduleList,
  validateScheduleInput,
  type Scheduler,
  type Schedule,
  type ScheduleInput,
} from '../scheduler.js';
import { webAppSessionId } from '../sessions.js';
import { ValidationError } from '../errors.js';

type SchedulePlatform = Schedule['platform'];

function isSchedulePlatform(value: string): value is SchedulePlatform {
  return value === 'discord' || value === 'slack' || value === 'telegram' || value === 'web';
}

function resolveSchedulePlatform(flags: Record<string, string>): SchedulePlatform {
  const value = flags['platform'] || process.env.XANGI_PLATFORM || 'discord';
  if (!isSchedulePlatform(value)) {
    throw new Error(`--platform must be discord, slack, telegram, or web: ${value}`);
  }
  return value;
}

function getScheduleFilePath(): string {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'schedules.json');
}

function loadSchedules(): Schedule[] {
  const filePath = getScheduleFilePath();
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid schedules file (expected an array): ${filePath}`);
  }
  return parsed as Schedule[];
}

function saveSchedules(schedules: Schedule[]): void {
  const filePath = getScheduleFilePath();
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const mode = existsSync(filePath) ? statSync(filePath).mode : 0o600;
  try {
    writeFileSync(temporaryPath, JSON.stringify(schedules, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
      mode,
    });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

function generateId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function validateForCommand(schedule: ScheduleInput): void {
  try {
    validateScheduleInput(schedule);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

function parseForCommand(input: string): ReturnType<typeof parseScheduleInput> {
  try {
    return parseScheduleInput(input);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

function toScheduleInput(schedule: Schedule): ScheduleInput {
  return {
    type: schedule.type,
    expression: schedule.expression,
    runAt: schedule.runAt,
    message: schedule.message,
    channelId: schedule.channelId,
    platform: schedule.platform,
    label: schedule.label,
    projectId: schedule.projectId,
  };
}

async function scheduleList(scheduler?: Scheduler): Promise<string> {
  const schedules = scheduler?.list() ?? loadSchedules();
  if (schedules.length === 0) {
    return '📋 スケジュールはありません';
  }
  return formatScheduleList(schedules);
}

async function scheduleAdd(flags: Record<string, string>, scheduler?: Scheduler): Promise<string> {
  const input = flags['input'];
  const channelId = flags['channel'];
  const platform = resolveSchedulePlatform(flags);

  if (!input) throw new Error('--input is required');
  if (!channelId) throw new Error('--channel is required');

  const parsed = parseForCommand(input);
  if (!parsed) {
    throw new Error(`スケジュール形式を解析できません: ${input}`);
  }

  // targetChannelId が指定されていればそちらを優先
  const requestedChannel = parsed.targetChannelId || channelId;
  const targetChannel = platform === 'web' ? webAppSessionId(requestedChannel) : requestedChannel;

  const scheduleInput: ScheduleInput = {
    type: parsed.type,
    expression: parsed.expression,
    runAt: parsed.runAt,
    message: parsed.message,
    channelId: targetChannel,
    platform,
  };
  validateForCommand(scheduleInput);

  if (scheduler) {
    const newSchedule = scheduler.add(scheduleInput);
    return `✅ スケジュールを追加しました (ID: ${newSchedule.id})`;
  }

  const schedules = loadSchedules();
  const newSchedule: Schedule = {
    id: generateId(),
    type: parsed.type,
    expression: parsed.expression,
    runAt: parsed.runAt,
    message: parsed.message,
    channelId: targetChannel,
    platform,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  schedules.push(newSchedule);
  saveSchedules(schedules);

  return `✅ スケジュールを追加しました (ID: ${newSchedule.id})`;
}

const SCHEDULE_UPDATE_FLAGS = new Set(['id', 'input', 'message', 'channel', 'platform']);

async function scheduleUpdate(
  flags: Record<string, string>,
  scheduler?: Scheduler
): Promise<string> {
  for (const key of Object.keys(flags)) {
    if (!SCHEDULE_UPDATE_FLAGS.has(key)) {
      throw new ValidationError(`Unknown schedule_update flag: --${key}`);
    }
  }

  const id = flags['id']?.trim();
  if (!id) throw new ValidationError('--id is required');

  const hasInput = Object.hasOwn(flags, 'input');
  const hasMessage = Object.hasOwn(flags, 'message');
  const hasChannel = Object.hasOwn(flags, 'channel');
  const hasPlatform = Object.hasOwn(flags, 'platform');
  if (!hasInput && !hasMessage && !hasChannel && !hasPlatform) {
    throw new ValidationError(
      'At least one of --input, --message, --channel, or --platform is required'
    );
  }
  if (hasInput && hasMessage) {
    throw new ValidationError('--input and --message cannot be used together');
  }

  const parsed = hasInput ? parseForCommand(flags['input']) : undefined;
  if (hasInput && !parsed) {
    throw new ValidationError(`スケジュール形式を解析できません: ${flags['input']}`);
  }
  if (hasMessage && !flags['message'].trim()) {
    throw new ValidationError('--message must not be empty');
  }
  if (hasChannel && !flags['channel'].trim()) {
    throw new ValidationError('--channel must not be empty');
  }
  if (hasPlatform && !isSchedulePlatform(flags['platform'])) {
    throw new ValidationError(
      `--platform must be discord, slack, telegram, or web: ${flags['platform']}`
    );
  }

  const embeddedChannel = parsed?.targetChannelId;
  const explicitChannel = hasChannel ? flags['channel'].trim() : undefined;
  if (embeddedChannel && explicitChannel && embeddedChannel !== explicitChannel) {
    throw new ValidationError('--input channel and --channel must match when both are specified');
  }

  const schedules = scheduler ? undefined : loadSchedules();
  const index = schedules?.findIndex((schedule) => schedule.id === id) ?? -1;
  const current = scheduler?.get(id) ?? (index >= 0 ? schedules?.[index] : undefined);
  if (!current) {
    throw new ValidationError(`スケジュールが見つかりません: ${id}`);
  }

  const platform = hasPlatform ? (flags['platform'] as SchedulePlatform) : current.platform;
  const requestedChannel = embeddedChannel ?? explicitChannel;
  if (platform !== current.platform && !requestedChannel) {
    throw new ValidationError('--channel is required when changing --platform');
  }

  const updated: Schedule = { ...current };
  if (parsed) {
    updated.type = parsed.type;
    updated.message = parsed.message;
    delete updated.expression;
    delete updated.runAt;
    if (parsed.type === 'cron') updated.expression = parsed.expression;
    if (parsed.type === 'once') updated.runAt = parsed.runAt;
  } else if (hasMessage) {
    updated.message = flags['message'];
  }

  updated.platform = platform;
  const channel = requestedChannel ?? current.channelId;
  updated.channelId = platform === 'web' ? webAppSessionId(channel) : channel;
  if (platform !== 'web') {
    delete updated.projectId;
  }

  const scheduleInput = toScheduleInput(updated);
  validateForCommand(scheduleInput);

  if (scheduler) {
    scheduler.update(id, scheduleInput);
  } else {
    schedules![index] = updated;
    saveSchedules(schedules!);
  }

  return (
    `✅ スケジュールを更新しました (ID: ${updated.id})\n` +
    `- 種別: ${updated.type}\n` +
    `- 送信先: ${updated.platform}:${updated.channelId}\n` +
    `- 内容: ${updated.message}`
  );
}

async function scheduleRemove(
  flags: Record<string, string>,
  scheduler?: Scheduler
): Promise<string> {
  const id = flags['id'];
  if (!id) throw new Error('--id is required');

  if (scheduler) {
    if (!scheduler.remove(id)) {
      return `❌ スケジュールが見つかりません: ${id}`;
    }
    return `🗑️ スケジュールを削除しました: ${id}`;
  }

  const schedules = loadSchedules();
  const index = schedules.findIndex((s) => s.id === id);
  if (index === -1) {
    return `❌ スケジュールが見つかりません: ${id}`;
  }

  schedules.splice(index, 1);
  saveSchedules(schedules);

  return `🗑️ スケジュールを削除しました: ${id}`;
}

async function scheduleToggle(
  flags: Record<string, string>,
  scheduler?: Scheduler
): Promise<string> {
  const id = flags['id'];
  if (!id) throw new Error('--id is required');

  const schedules = scheduler ? undefined : loadSchedules();
  const schedule = scheduler?.toggle(id) ?? schedules?.find((s) => s.id === id);
  if (!schedule) {
    return `❌ スケジュールが見つかりません: ${id}`;
  }

  if (!scheduler) {
    schedule.enabled = !schedule.enabled;
    saveSchedules(schedules!);
  }

  return `🔄 スケジュール ${id}: ${schedule.enabled ? '有効' : '無効'} に切り替えました`;
}

// ─── Router ─────────────────────────────────────────────────────────

export async function scheduleCmd(
  command: string,
  flags: Record<string, string>,
  scheduler?: Scheduler
): Promise<string> {
  switch (command) {
    case 'schedule_list':
      return scheduleList(scheduler);
    case 'schedule_add':
      return scheduleAdd(flags, scheduler);
    case 'schedule_update':
      return scheduleUpdate(flags, scheduler);
    case 'schedule_remove':
      return scheduleRemove(flags, scheduler);
    case 'schedule_toggle':
      return scheduleToggle(flags, scheduler);
    default:
      throw new Error(`Unknown schedule command: ${command}`);
  }
}
