import type { ChatPlatform } from './xangi-commands.js';

const LABELS: Record<string, string> = {
  discord: 'chat platform (Discord)',
  slack: 'chat platform (Slack)',
  web: 'a web browser',
  line: 'chat platform (LINE)',
  telegram: 'chat platform (Telegram)',
};

export function getPlatformLabel(platform?: ChatPlatform): string {
  return platform ? LABELS[platform] || 'chat platform' : 'chat platform (Discord/Slack/Telegram)';
}
