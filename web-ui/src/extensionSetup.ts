export const EXTENSION_SETUP_STORAGE_PREFIX = 'xangi-extension-setup:';

export interface PendingExtensionSetup {
  prompt: string;
  displayMessage: string;
}

export function extensionSetupStorageKey(sessionId: string): string {
  return `${EXTENSION_SETUP_STORAGE_PREFIX}${sessionId}`;
}

export function parsePendingExtensionSetup(value: string | null): PendingExtensionSetup | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PendingExtensionSetup>;
    if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return null;
    if (typeof parsed.displayMessage !== 'string' || !parsed.displayMessage.trim()) return null;
    return { prompt: parsed.prompt, displayMessage: parsed.displayMessage };
  } catch {
    return null;
  }
}
