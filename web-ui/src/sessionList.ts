export function shouldShowAutoTalk(interChatEnabled: boolean, platform: string): boolean {
  return interChatEnabled && platform === 'web';
}

export type SessionListStatus = 'running' | 'waiting' | 'completed';

export function sessionListStatus(session: {
  isActive: boolean;
  lifecycle?: 'open' | 'closed';
}): SessionListStatus {
  if (session.lifecycle === 'closed') return 'completed';
  return session.isActive ? 'running' : 'waiting';
}

export function sessionListStatusLabel(status: SessionListStatus): string {
  if (status === 'running') return '実行中';
  if (status === 'completed') return '完了';
  return '待機中';
}
