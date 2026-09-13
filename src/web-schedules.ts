import type { Platform, Schedule, ScheduleInput } from './scheduler.js';

export const WEB_SCHEDULE_NEW_SESSION_ID = '__new__';

export type WebScheduleProjectResolver = (projectId: unknown) => string | undefined;
export type ScheduleDestinationLabelResolver = (
  platform: Platform,
  channelId: string
) => string | undefined;

export function parseWebScheduleInput(
  body: Record<string, unknown>,
  resolveProjectId: WebScheduleProjectResolver
): ScheduleInput {
  const platform = String(body.platform || 'web').trim() as Platform;
  if (!['discord', 'slack', 'telegram', 'web'].includes(platform)) {
    throw new Error('platform must be discord, slack, telegram, or web');
  }
  const type = String(body.type || '');
  if (type !== 'cron' && type !== 'once' && type !== 'startup') {
    throw new Error('type must be cron, once, or startup');
  }
  const message = String(body.message || '').trim();
  if (!message) throw new Error('実行内容を入力してください');

  let channelId = String(body.channelId || body.sessionId || '').trim();
  let projectId: string | undefined;
  if (platform === 'web') {
    channelId = WEB_SCHEDULE_NEW_SESSION_ID;
    projectId = resolveProjectId(body.projectId);
  } else if (!channelId) {
    throw new Error('送信先IDを入力してください');
  }

  return {
    type,
    expression: type === 'cron' ? String(body.expression || '').trim() : undefined,
    runAt: type === 'once' ? String(body.runAt || '').trim() : undefined,
    message,
    channelId,
    platform,
    label: String(body.label || '').trim() || undefined,
    projectId,
  };
}

export function scheduleForWebResponse(
  schedule: Schedule,
  resolveDestinationLabel?: ScheduleDestinationLabelResolver
): Schedule & { destinationLabel?: string } {
  return {
    ...schedule,
    destinationLabel: resolveDestinationLabel?.(schedule.platform, schedule.channelId),
  };
}
