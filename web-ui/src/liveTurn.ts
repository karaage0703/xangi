import { stripReplySuggestionMarkup } from '../../src/reply-suggestions';

export interface LiveActivity {
  state: string;
  summary: string;
  active: boolean;
  textPreview?: string;
  toolLines?: string[];
  turnId?: string;
  startedAt?: number;
}

export interface LiveSessionIdentity {
  id: string;
  platform: string;
  contextKey: string;
}

export interface ObservedLiveTurn {
  turnId: string;
  text: string;
  fromEvent: boolean;
}

export interface PublishedLiveEvent {
  type: string;
  turn_id?: string;
  full_text?: string;
  text?: string;
}

export function liveThreadId(session?: LiveSessionIdentity): string | undefined {
  if (!session) return undefined;
  if (session.platform === 'web') return `web:${session.id}`;
  if (!session.contextKey) return undefined;
  return `${session.platform}:${session.contextKey}`;
}

export function syncObservedLiveTurn(
  current: ObservedLiveTurn | undefined,
  activity?: LiveActivity
): ObservedLiveTurn | undefined {
  if (!activity?.active || !activity.turnId) return undefined;
  if (current?.turnId === activity.turnId && current.fromEvent) return current;
  return {
    turnId: activity.turnId,
    text: activity.textPreview || '',
    fromEvent: false,
  };
}

export function applyPublishedLiveEvent(
  current: ObservedLiveTurn | undefined,
  event: PublishedLiveEvent
): ObservedLiveTurn | undefined {
  if (!event.turn_id) return current;
  if (event.type === 'turn.started') {
    return { turnId: event.turn_id, text: '', fromEvent: false };
  }
  if (event.type === 'message.delta') {
    return {
      turnId: event.turn_id,
      text: stripReplySuggestionMarkup(event.full_text || event.text || ''),
      fromEvent: true,
    };
  }
  if (event.type === 'turn.complete') {
    return {
      turnId: event.turn_id,
      text: stripReplySuggestionMarkup(
        event.text || (current?.turnId === event.turn_id ? current.text : '')
      ),
      fromEvent: true,
    };
  }
  return current;
}

export function selectLiveTurn({
  localBusy,
  localText,
  localToolLines,
  activity,
  observed,
}: {
  localBusy: boolean;
  localText: string;
  localToolLines: string[];
  activity?: LiveActivity;
  observed?: ObservedLiveTurn;
}): {
  visible: boolean;
  text: string;
  toolLines: string[];
  startedAt?: number;
  statusLabel: string;
} {
  if (localBusy) {
    return {
      visible: true,
      text: localText,
      toolLines: localToolLines,
      statusLabel: '処理中',
    };
  }
  if (!activity?.active) {
    return { visible: false, text: '', toolLines: [], statusLabel: '' };
  }
  const observedText = observed && observed.turnId === activity.turnId ? observed.text : '';
  return {
    visible: true,
    text: observedText || activity.textPreview || '',
    toolLines: activity.toolLines || [],
    startedAt: activity.startedAt,
    statusLabel:
      activity.state === 'tool'
        ? 'tool実行中'
        : activity.state === 'streaming'
          ? '応答中'
          : activity.state === 'thinking'
            ? '考え中'
            : '処理中',
  };
}
