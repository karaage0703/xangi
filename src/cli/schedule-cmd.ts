/**
 * スケジュール操作CLIモジュール
 *
 * .xangi/schedules.json を直接操作する。
 * Schedulerクラスがファイル変更を監視しているため、
 * ファイルを更新すれば実行中のxangiプロセスが自動リロードする。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseScheduleInput, formatScheduleList } from '../scheduler.js';

interface Schedule {
  id: string;
  type: 'cron' | 'once' | 'startup';
  expression?: string;
  runAt?: string;
  message: string;
  channelId: string;
  platform: 'discord' | 'slack';
  createdAt: string;
  enabled: boolean;
  label?: string;
}

function getScheduleFilePath(): string {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = join(workdir, '.xangi');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'schedules.json');
}

function loadSchedules(): Schedule[] {
  const filePath = getScheduleFilePath();
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Schedule[];
  } catch {
    return [];
  }
}

function saveSchedules(schedules: Schedule[]): void {
  const filePath = getScheduleFilePath();
  writeFileSync(filePath, JSON.stringify(schedules, null, 2));
}

function generateId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function scheduleList(): Promise<string> {
  const schedules = loadSchedules();
  if (schedules.length === 0) {
    return '📋 スケジュールはありません';
  }
  return formatScheduleList(schedules);
}

async function scheduleAdd(flags: Record<string, string>): Promise<string> {
  const input = flags['input'];
  const channelId = flags['channel'];
  const platform = (flags['platform'] || 'discord') as 'discord' | 'slack';

  if (!input) throw new Error('--input is required');
  if (!channelId) throw new Error('--channel is required');

  const parsed = parseScheduleInput(input);
  if (!parsed) {
    throw new Error(`スケジュール形式を解析できません: ${input}`);
  }

  const schedules = loadSchedules();
  // targetChannelId が指定されていればそちらを優先
  const targetChannel = parsed.targetChannelId || channelId;

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

async function scheduleRemove(flags: Record<string, string>): Promise<string> {
  const id = flags['id'];
  if (!id) throw new Error('--id is required');

  const schedules = loadSchedules();
  const index = schedules.findIndex((s) => s.id === id);
  if (index === -1) {
    return `❌ スケジュールが見つかりません: ${id}`;
  }

  schedules.splice(index, 1);
  saveSchedules(schedules);

  return `🗑️ スケジュールを削除しました: ${id}`;
}

async function scheduleToggle(flags: Record<string, string>): Promise<string> {
  const id = flags['id'];
  if (!id) throw new Error('--id is required');

  const schedules = loadSchedules();
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) {
    return `❌ スケジュールが見つかりません: ${id}`;
  }

  schedule.enabled = !schedule.enabled;
  saveSchedules(schedules);

  return `🔄 スケジュール ${id}: ${schedule.enabled ? '有効' : '無効'} に切り替えました`;
}

// ─── Router ─────────────────────────────────────────────────────────

export async function scheduleCmd(command: string, flags: Record<string, string>): Promise<string> {
  switch (command) {
    case 'schedule_list':
      return scheduleList();
    case 'schedule_add':
      return scheduleAdd(flags);
    case 'schedule_remove':
      return scheduleRemove(flags);
    case 'schedule_toggle':
      return scheduleToggle(flags);
    default:
      throw new Error(`Unknown schedule command: ${command}`);
  }
}
