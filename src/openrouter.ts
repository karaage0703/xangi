/** OpenRouter transport settings. Never mutate the Local LLM environment. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const OPENROUTER_PROVIDER_POLICY = Object.freeze({
  data_collection: 'deny',
  zdr: true,
  require_parameters: true,
});

/** Only an explicit false relaxes a restriction; unset/invalid values stay safe. */
export function openRouterProviderPolicy(env: NodeJS.ProcessEnv = process.env) {
  return {
    data_collection:
      env.OPENROUTER_NO_TRAINING?.trim().toLowerCase() === 'false' ? 'allow' : 'deny',
    zdr: env.OPENROUTER_ZDR?.trim().toLowerCase() !== 'false',
    require_parameters: true,
  };
}

/** Validate connection prerequisites; account privacy settings remain user-managed. */
export function assertOpenRouterReady(apiKey: string, model: string): void {
  if (!apiKey.trim()) throw new Error('OpenRouter APIキーを接続設定に保存してください');
  if (!model.includes('/') || /\s/.test(model) || model.startsWith('openrouter/')) {
    throw new Error(
      'OpenRouterの具体的なモデルID（provider/model）をエージェントに指定してください'
    );
  }
}

/** Reuse the agent loop with its own settings, without inheriting Qwen tuning. */
export function openRouterRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const key of Object.keys(isolated)) {
    if (key.startsWith('LOCAL_LLM_')) delete isolated[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('OPENROUTER_')) isolated[key.replace('OPENROUTER_', 'LOCAL_LLM_')] = value;
  }
  isolated.LOCAL_LLM_BASE_URL = OPENROUTER_BASE_URL;
  isolated.LOCAL_LLM_THINKING = 'false';
  return isolated;
}
