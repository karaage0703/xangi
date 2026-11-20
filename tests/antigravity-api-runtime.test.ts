import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applySetupRuntimeEnvFromProcess } from '../src/installer/runtime-config.js';
import { antigravityApiKeyArgs, antigravityApiModel } from '../src/antigravity-auth.js';

it('keeps the API model usable when setup clears the executable override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-api-runtime-'));
  try {
    const config = join(root, 'setup.json');
    const envPath = join(root, '.env');
    await writeFile(
      config,
      JSON.stringify({ backend: 'codex', workspacePath: root, webChatEnabled: true })
    );
    await writeFile(envPath, 'XANGI_GLOBAL_BACKEND_OVERRIDE=true\nAGENT_BACKEND=codex\n');
    const env: NodeJS.ProcessEnv = {
      XANGI_SETUP_CONFIG_PATH: config,
      XANGI_SETUP_STATE_DIR: join(root, 'state'),
      XANGI_ENV_PATH: envPath,
      XANGI_BACKEND_EXECUTABLE: join(root, 'adapter', 'agy'),
      GEMINI_API_KEY: 'fake-test-key',
      ANTIGRAVITY_API_MODEL: 'gemini-test-free',
    };
    expect(await applySetupRuntimeEnvFromProcess(env)).toBe(true);
    expect(env.XANGI_BACKEND_EXECUTABLE).toBe('');
    expect(antigravityApiModel(env)).toBe('gemini-test-free');
    const settings = JSON.parse(antigravityApiKeyArgs(env)[1]);
    expect(settings.customModelsConfig.customModels['gemini-test-free'].modelName).toBe(
      'gemini-api://gemini-test-free'
    );
    expect(JSON.stringify(settings)).not.toContain('fake-test-key');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
