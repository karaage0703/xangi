export interface ComposableSession {
  lifecycle?: 'open' | 'closed';
  platform?: string;
}

export interface SessionBackendSummary {
  backend: string;
  model?: string;
  effort?: string;
  source: 'session' | 'project' | 'default';
}

export function canComposeInSession(
  detail: ComposableSession | null,
  discordComposeEnabled: boolean
): boolean {
  if (!detail) return false;
  if (detail.platform === 'discord') return discordComposeEnabled;
  return detail.platform === 'web' && detail.lifecycle !== 'closed';
}

export function shouldShowContinuationActions(detail: ComposableSession | null): boolean {
  return Boolean(detail && (detail.lifecycle === 'closed' || detail.platform !== 'web'));
}

export function resolveDisplayedSessionTitle(
  summaryTitle?: string,
  detailTitle?: string
): string | undefined {
  return summaryTitle || detailTitle;
}

export function formatContextUsage(usage?: {
  usedTokens: number;
  contextWindow: number;
}): string | undefined {
  if (!usage || usage.contextWindow <= 0 || usage.usedTokens < 0) return undefined;
  const percent = Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100));
  return `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${percent}%)`;
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function platformLabel(platform?: string): string {
  if (platform === 'web') return 'Web';
  if (platform === 'discord') return 'Discord';
  if (platform === 'slack') return 'Slack';
  return platform || 'Log';
}

export function backendLabel(backend?: SessionBackendSummary): string {
  if (!backend) return '';
  return [backend.backend, backend.model, backend.effort].filter(Boolean).join(' · ');
}

export function backendSourceLabel(source?: SessionBackendSummary['source']): string {
  if (source === 'session') return '会話個別設定';
  if (source === 'project') return 'Project設定';
  return 'xangiデフォルト';
}

export function relativeTime(value?: string): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return '今';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

export function dateGroup(value?: string): string {
  if (!value) return '以前';
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今日';
  if (date.toDateString() === yesterday.toDateString()) return '昨日';
  return date.toLocaleDateString('ja-JP');
}

export function displayTime(value?: string): string {
  if (!value) return '';
  return new Date(value).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRemaining(timeoutAt?: number): string {
  if (!timeoutAt) return '';
  const seconds = Math.max(0, Math.ceil((timeoutAt - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(
    2,
    '0'
  )}`;
}

export function isMobile(): boolean {
  return (
    window.matchMedia?.('(max-width: 768px), (max-height: 500px) and (hover: none)').matches ??
    false
  );
}
