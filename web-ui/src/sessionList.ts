export function shouldShowAutoTalk(interChatEnabled: boolean, platform: string): boolean {
  return interChatEnabled && platform === 'web';
}
