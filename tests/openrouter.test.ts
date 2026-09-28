import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMClient } from '../src/local-llm/llm-client.js';
import { createAgentRunner } from '../src/agent-runner.js';
import { discoverBackendModels } from '../src/backend-models.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import {
  OPENROUTER_PROVIDER_POLICY,
  openRouterRunnerEnv,
  openRouterProviderPolicy,
} from '../src/openrouter.js';

const message = [{ role: 'user' as const, content: 'hello' }];
const client = (key = 'test-key') =>
  new LLMClient(
    'https://openrouter.ai/api',
    'vendor/model',
    key,
    false,
    256,
    undefined,
    undefined,
    undefined,
    'openrouter'
  );
const reply = (model: string, content = 'ok') =>
  Response.json({ model, choices: [{ message: { content }, finish_reason: 'stop' }] });
async function drain(stream: AsyncGenerator<string>) {
  let s = '';
  for await (const chunk of stream) s += chunk;
  return s;
}

describe('OpenRouter privacy and multi-agent routing', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xangi-openrouter-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_NO_TRAINING', undefined);
    vi.stubEnv('OPENROUTER_ZDR', undefined);
    vi.stubEnv('OPENROUTER_PRIVACY_CONFIRMED', undefined);
    vi.stubEnv('OPENROUTER_SKILLS', 'false');
    vi.stubEnv('OPENROUTER_XANGI_COMMANDS', 'false');
    vi.stubEnv('XANGI_TOOL_TRAJECTORY_LOG', 'false');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([undefined, '', 'oops', '0', 'true'])(
    'keeps both restrictions ON for unset or non-false values (%s)',
    (value) => {
      expect(
        openRouterProviderPolicy({ OPENROUTER_NO_TRAINING: value, OPENROUTER_ZDR: value })
      ).toEqual(OPENROUTER_PROVIDER_POLICY);
    }
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'sends independent no-training=%s and ZDR=%s options for chat and stream',
    async (noTraining, zdr) => {
      vi.stubEnv('OPENROUTER_NO_TRAINING', String(noTraining));
      vi.stubEnv('OPENROUTER_ZDR', String(zdr));
      vi.stubEnv('OPENROUTER_PRIVACY_CONFIRMED', 'false');
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('vendor/model'));
      await client().chat(message);
      const expected = {
        data_collection: noTraining ? 'deny' : 'allow',
        zdr,
        require_parameters: true,
      };
      expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).provider).toEqual(expected);
      spy.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      expect(await drain(client().chatStream(message))).toBe('ok');
      expect(JSON.parse(String(spy.mock.calls[1][1]?.body)).provider).toEqual(expected);
      spy.mockResolvedValue(new Response('No matching endpoints', { status: 404 }));
      await expect(client().chat(message)).rejects.toThrow('404');
      expect(spy).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(spy.mock.calls[2][1]?.body)).provider).toEqual(expected);
    }
  );

  it('blocks before network without a key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(client('').chat(message)).rejects.toThrow('APIキー');
    await expect(drain(client('').chatStream(message))).rejects.toThrow('APIキー');
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps strict policy in both chat and stream and never relaxes it on failure', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('No endpoints match privacy settings', { status: 404 }));
    await expect(client().chat(message)).rejects.toThrow('404');
    expect(spy).toHaveBeenCalledTimes(1);
    let init = spy.mock.calls[0][1]!;
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body)).provider).toEqual(OPENROUTER_PROVIDER_POLICY);
    spy.mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    );
    expect(await drain(client().chatStream(message, { reasoningEffort: 'low' }))).toBe('ok');
    init = spy.mock.calls[1][1]!;
    const body = JSON.parse(String(init.body));
    expect(body.provider).toEqual(OPENROUTER_PROVIDER_POLICY);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('surfaces SSE errors without retrying as an unrestricted or successful answer', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('data: {"error":{"code":503,"message":"No ZDR endpoints"}}\n\n')
      );
    await expect(drain(client().chatStream(message))).rejects.toThrow('No ZDR endpoints');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lists tools-capable models without requiring a key or sending conversation content', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          { id: 'vendor/a', name: 'A', supported_parameters: ['tools'] },
          { id: 'vendor/chat', supported_parameters: [] },
          { id: 'vendor/a:batch', supported_parameters: ['tools'] },
          { id: 'openrouter/auto', supported_parameters: ['tools'] },
        ],
      })
    );
    const result = await discoverBackendModels('openrouter', { fetchFn });
    expect(result.models).toEqual([{ id: 'vendor/a', displayName: 'A', supportedEfforts: [] }]);
    expect(fetchFn.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
    expect(fetchFn.mock.calls[0][1].body).toBeUndefined();
  });

  it('discovers model-specific efforts, defaults, mandatory reasoning and missing metadata', async () => {
    const models = [
      {
        id: 'vendor/list',
        reasoning: {
          supported_efforts: ['max', 'high', 'low'],
          default_effort: 'high',
          default_enabled: true,
          mandatory: false,
        },
      },
      {
        id: 'vendor/mandatory',
        reasoning: { supported_efforts: ['none', 'low', 'high'], mandatory: true },
      },
      { id: 'vendor/all', reasoning: { supported_efforts: null } },
      { id: 'vendor/all-required', reasoning: { supported_efforts: null, mandatory: true } },
      { id: 'vendor/missing' },
      { id: 'vendor/unknown', reasoning: { supported_efforts: ['future-value'] } },
    ];
    const result = await discoverBackendModels('openrouter', {
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: models.map((m) => ({ ...m, supported_parameters: ['tools'] })) })
        ),
    });
    expect(result.models[0]).toMatchObject({
      supportedEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      reasoningDefaultEnabled: true,
      reasoningMandatory: false,
    });
    expect(result.models[1].supportedEfforts).toEqual(['low', 'high']);
    expect(result.models[2].supportedEfforts).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(result.models[3].supportedEfforts).not.toContain('none');
    expect(result.models[4].supportedEfforts).toEqual([]);
    expect(result.models[5].supportedEfforts).toEqual([]);
  });

  it.each([false, true])(
    'saves two model agents alongside Qwen and runs tool roundtrips independently (stream=%s)',
    async (stream) => {
      vi.stubEnv('LOCAL_LLM_BASE_URL', 'http://127.0.0.1:8001');
      vi.stubEnv('LOCAL_LLM_API_KEY', 'local-key');
      vi.stubEnv('LOCAL_LLM_MODEL', 'qwen-local');
      vi.stubEnv('LOCAL_LLM_MODE', 'chat');
      vi.stubEnv('LOCAL_LLM_TEMPERATURE', '0.9');
      vi.stubEnv('LOCAL_LLM_SKILLS', 'false');
      vi.stubEnv('LOCAL_LLM_XANGI_COMMANDS', 'false');
      const catalog = new ProjectCatalog(root);
      const agents = ['vendor/a', 'vendor/b'].map((model) =>
        catalog.saveAgent({ name: model, backend: 'openrouter', model, localLlmMode: 'agent' })
      );
      const qwen = catalog.saveAgent({
        name: 'Qwen',
        backend: 'local-llm',
        model: 'qwen-local',
        localLlmMode: 'chat',
      });
      const reloaded = new ProjectCatalog(root);
      expect(reloaded.agents()).toHaveLength(3);
      expect(() => catalog.saveAgent({ name: 'invalid', backend: 'openrouter' })).toThrow(
        'モデルID'
      );
      writeFileSync(join(root, 'sample.txt'), 'sample-evidence');
      const calls: Array<{ url: string; body: any; key: string }> = [];
      const signature = [{ type: 'reasoning.encrypted', data: 'opaque-signature', index: 0 }];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({
          url: String(url),
          body,
          key: (init?.headers as Record<string, string>).Authorization,
        });
        if (body.model === 'qwen-local')
          return body.stream
            ? new Response('data: {"choices":[{"delta":{"content":"local-ok"}}]}\n\n')
            : reply(body.model, 'local-ok');
        const toolResult = body.messages.find((m: any) => m.role === 'tool');
        if (!toolResult)
          return Response.json({
            model: body.model,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  reasoning_details: signature,
                  tool_calls: [
                    {
                      id: 'read-1',
                      type: 'function',
                      function: {
                        name: 'read',
                        arguments: JSON.stringify({ path: join(root, 'sample.txt') }),
                      },
                    },
                  ],
                },
              },
            ],
          });
        expect(toolResult.content).toContain('sample-evidence');
        expect(body.messages.find((m: any) => m.tool_calls)?.reasoning_details).toEqual(signature);
        return reply(body.model, `done-${body.model}`);
      });
      const run = async (agent: (typeof agents)[number]) => {
        const settings = reloaded.execution(undefined, agent.id)!;
        const runner = createAgentRunner(settings.backend!, {
          model: settings.model,
          workdir: root,
        });
        const opts = { channelId: agent.id, localLlmMode: settings.localLlmMode };
        return stream
          ? runner.runStream('read sample.txt', {}, opts)
          : runner.run('read sample.txt', opts);
      };
      const results = await Promise.all([...agents, qwen].map(run));
      expect(results.map((r) => r.result)).toEqual(['done-vendor/a', 'done-vendor/b', 'local-ok']);
      const cloudCalls = calls.filter((c) => c.body.model !== 'qwen-local');
      expect(cloudCalls).toHaveLength(4);
      for (const c of cloudCalls) {
        expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(c.key).toBe('Bearer test-key');
        expect(c.body.provider).toEqual(OPENROUTER_PROVIDER_POLICY);
        expect(c.body.temperature).toBeUndefined();
      }
      const local = calls.find((c) => c.body.model === 'qwen-local')!;
      expect(local.url).toBe('http://127.0.0.1:8001/v1/chat/completions');
      expect(local.key).toBe('Bearer local-key');
      expect(local.body.provider).toBeUndefined();
      expect(process.env.LOCAL_LLM_BASE_URL).toBe('http://127.0.0.1:8001');
    }
  );

  it('does not inherit Qwen generation and context defaults', () => {
    const env = openRouterRunnerEnv({
      LOCAL_LLM_API_KEY: 'private',
      LOCAL_LLM_NUM_CTX: '4096',
      LOCAL_LLM_MODE: 'chat',
      OPENROUTER_API_KEY: 'cloud',
    });
    expect(env.LOCAL_LLM_API_KEY).toBe('cloud');
    expect(env.LOCAL_LLM_NUM_CTX).toBeUndefined();
    expect(env.LOCAL_LLM_MODE).toBeUndefined();
  });
});
