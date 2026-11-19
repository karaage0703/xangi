export const ANTIGRAVITY_API_KEY_ARGS = ['--settings', '{"modelProvider":"gemini"}'] as const;
export const ANTIGRAVITY_API_KEY_UPGRADE =
  'AntigravityのAPIキー認証には --settings と構造化出力に対応した Agy が必要です。agyを更新してください。';

export function antigravityApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GEMINI_API_KEY?.trim() || undefined;
}

export function antigravityAuthStartupMessage(
  defaultBackend: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (antigravityApiKey(env)) {
    return '[antigravity] 認証: Gemini APIキー（Agy利用時はGemini APIプロジェクトの利用枠・課金）';
  }
  if (defaultBackend === 'antigravity') return '[antigravity] 認証: Agyの既存設定';
}

export function withoutGeminiApiKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  return env;
}

export function redactGeminiApiKey(text: string, key: string | undefined): string {
  return key ? text.replaceAll(key, '[REDACTED]') : text;
}

export function reportsUnsupportedAntigravitySettings(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /(?:^|\s)-{1,2}settings(?:[\s=:'"]|$)/i.test(message) &&
    /unknown|unrecognized|not defined|unexpected|unsupported/i.test(message)
  );
}
