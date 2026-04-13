import type { ChatPlatform } from './xangi-commands.js';

const LABELS: Record<string, string> = {
  discord: 'チャットプラットフォーム（Discord）',
  slack: 'チャットプラットフォーム（Slack）',
  web: 'Webブラウザ',
};

export function getPlatformLabel(platform?: ChatPlatform): string {
  return platform
    ? LABELS[platform] || 'チャットプラットフォーム'
    : 'チャットプラットフォーム（Discord/Slack）';
}
