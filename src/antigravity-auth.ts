export const ANTIGRAVITY_API_ARGS = ['--settings', '{"modelProvider":"gemini"}'] as const;
export const ANTIGRAVITY_UPGRADE_MESSAGE =
  'AntigravityのAPIキー認証には Agy 1.5.9 以降が必要です。agyを更新してください。';

export function reportsUnsupportedAntigravitySettings(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /-{1,2}settings\b/i.test(message) &&
    /unknown|unrecognized|not defined|unexpected|unsupported/i.test(message)
  );
}

export function withoutAntigravityApiKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  return env;
}

export function requireAntigravityApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'AntigravityにはGoogle AI StudioのGEMINI_API_KEYが必要です。個人ログインは使用しません。'
    );
  }
  return key;
}
