import { describe, expect, it, vi } from 'vitest';
import {
  configuredAllowedModels,
  discoverBackendModels,
  formatBackendModels,
  parseAntigravityModels,
  parseCodexModels,
  parseCursorModels,
  parseGrokModels,
  type ModelDiscoveryCommandRunner,
} from '../src/backend-models.js';

describe('backend model parsers', () => {
  it('parses Codex app-server model/list response', () => {
    const output = [
      JSON.stringify({ id: 1, result: { userAgent: 'xangi' } }),
      JSON.stringify({ method: 'configWarning', params: {} }),
      JSON.stringify({
        id: 2,
        result: {
          data: [
            {
              id: 'gpt-5.6-sol',
              displayName: 'GPT-5.6-Sol',
              description: 'Latest frontier agentic coding model.',
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'ultra' },
              ],
            },
          ],
        },
      }),
    ].join('\n');

    expect(parseCodexModels(output)).toEqual([
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model.',
        isDefault: true,
        supportedEfforts: ['low', 'ultra'],
      },
    ]);
  });

  it('parses Cursor account model output', () => {
    expect(
      parseCursorModels('Available models\n\nauto - Auto (current, default)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\n')
    ).toEqual([
      { id: 'auto', displayName: 'Auto', isDefault: true },
      { id: 'gpt-5.6-sol-high', displayName: 'GPT-5.6 Sol 1M High', isDefault: false },
    ]);
  });

  it('parses Grok and legacy Antigravity output', () => {
    expect(parseGrokModels('Available models:\n  * grok-4.5 (default)\n')).toEqual([
      { id: 'grok-4.5', isDefault: true },
    ]);
    expect(
      parseAntigravityModels(
        'Available models:\ngemini-3.6-flash-high\nGemini 3.5 Flash (Medium)\n'
      )
    ).toEqual([
      { id: 'gemini-3.6-flash-high' },
      { id: 'Gemini 3.5 Flash (Medium)' },
    ]);
  });

  it('parses Antigravity 1.1.12 JSON and tab-delimited model output', () => {
    expect(
      parseAntigravityModels(
        JSON.stringify({
          conversation_id: '',
          status: 'SUCCESS',
          command: {
            name: 'models',
            data: {
              models: [
                { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
                { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
              ],
            },
          },
        })
      )
    ).toEqual([
      { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)' },
      { id: 'gemini-3.6-flash-medium', displayName: 'Gemini 3.6 Flash (Medium)' },
    ]);

    expect(
      parseAntigravityModels(
        'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\ngemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n'
      )
    ).toEqual([
      { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)' },
      { id: 'gemini-3.6-flash-medium', displayName: 'Gemini 3.6 Flash (Medium)' },
    ]);
  });
});

describe('discoverBackendModels', () => {
  it('does not hard-code Claude Code models when listing is unsupported', async () => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>();
    const result = await discoverBackendModels('claude-code', { runner });

    expect(result.status).toBe('unsupported');
    expect(result.models).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('uses each backend official CLI command', async () => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>(async (command) => {
      if (command === 'codex') {
        return {
          stdout: JSON.stringify({
            id: 2,
            result: { data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] },
          }),
          stderr: '',
        };
      }
      if (command === 'cursor-agent') {
        return { stdout: 'auto - Auto (current, default)\n', stderr: '' };
      }
      if (command === 'grok') {
        return { stdout: '  * grok-4.5 (default)\n', stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          status: 'SUCCESS',
          command: {
            name: 'models',
            data: {
              models: [
                { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
              ],
            },
          },
        }),
        stderr: 'Fetching available models...\n',
      };
    });

    await expect(discoverBackendModels('codex', { runner })).resolves.toMatchObject({
      status: 'available',
      source: 'codex app-server model/list',
    });
    await expect(discoverBackendModels('cursor', { runner })).resolves.toMatchObject({
      status: 'available',
      source: 'cursor-agent models',
    });
    await expect(discoverBackendModels('grok', { runner })).resolves.toMatchObject({
      status: 'available',
      source: 'grok models',
    });
    await expect(discoverBackendModels('antigravity', { runner })).resolves.toMatchObject({
      status: 'available',
      source: 'agy --output-format json models',
    });

    expect(runner.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['codex', ['app-server', '--stdio']],
      ['cursor-agent', ['models']],
      ['grok', ['models']],
      ['agy', ['--output-format', 'json', 'models']],
    ]);
  });

  it('falls back to legacy agy models only when output-format is unsupported', async () => {
    const runner = vi
      .fn<ModelDiscoveryCommandRunner>()
      .mockRejectedValueOnce(new Error('flags provided but not defined: -output-format'))
      .mockResolvedValueOnce({
        stdout: 'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n',
        stderr: '',
      });

    await expect(discoverBackendModels('antigravity', { runner })).resolves.toMatchObject({
      status: 'available',
      source: 'agy models (legacy fallback)',
      models: [
        { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)' },
      ],
    });
    expect(runner.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['agy', ['--output-format', 'json', 'models']],
      ['agy', ['models']],
    ]);
  });

  it('preserves an Antigravity JSON error message', async () => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockResolvedValue({
      stdout: JSON.stringify({
        status: 'ERROR',
        error: { code: 'quota_exceeded', message: 'Daily quota exceeded' },
      }),
      stderr: '',
    });

    await expect(discoverBackendModels('antigravity', { runner })).resolves.toMatchObject({
      status: 'unavailable',
      source: 'agy --output-format json models',
      models: [],
      message: 'Daily quota exceeded',
    });
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['an empty string', ''],
  ])('does not treat error: %s in a success response as an Antigravity error', async (_, error) => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockResolvedValue({
      stdout: JSON.stringify({
        status: 'SUCCESS',
        error,
        message: 'Models fetched successfully',
        response: 'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n',
        command: {
          name: 'models',
          data: {
            models: [{ id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' }],
          },
        },
      }),
      stderr: '',
    });

    await expect(discoverBackendModels('antigravity', { runner })).resolves.toMatchObject({
      status: 'available',
      models: [{ id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)' }],
    });
  });

  it('preserves structured Antigravity JSON error details without a message', async () => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockResolvedValue({
      stdout: JSON.stringify({
        status: 'ERROR',
        error: { code: 'internal_error', request_id: 'request-123' },
      }),
      stderr: '',
    });

    await expect(discoverBackendModels('antigravity', { runner })).resolves.toMatchObject({
      status: 'unavailable',
      models: [],
      message: '{"code":"internal_error","request_id":"request-123"}',
    });
  });

  it('does not retry agy model discovery after an ordinary failure', async () => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockRejectedValue(new Error('network down'));

    await expect(discoverBackendModels('antigravity', { runner })).resolves.toMatchObject({
      status: 'unavailable',
      models: [],
      message: 'network down',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('reports unauthenticated Grok as unavailable instead of showing a guessed model', async () => {
    const runner: ModelDiscoveryCommandRunner = async () => ({
      stdout: 'You are not authenticated.\nDefault model: grok-4.5\n  * grok-4.5 (default)\n',
      stderr: '',
    });

    const result = await discoverBackendModels('grok', { runner });
    expect(result.status).toBe('unavailable');
    expect(result.models).toEqual([]);
  });

  it('uses Ollama then OpenAI-compatible local endpoints', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
      );

    const result = await discoverBackendModels('local-llm', { fetchFn });
    expect(result).toMatchObject({
      status: 'available',
      source: 'OpenAI-compatible /v1/models',
      models: [{ id: 'local-model' }],
    });
  });
});

describe('backend model formatting', () => {
  it('filters provider output with ALLOWED_MODELS', () => {
    const output = formatBackendModels(
      {
        backend: 'codex',
        source: 'codex app-server model/list',
        status: 'available',
        models: [
          { id: 'gpt-5.6-sol', isDefault: true },
          { id: 'gpt-5.6-terra' },
        ],
      },
      ['gpt-5.6-terra']
    );

    expect(output).toContain('gpt-5.6-terra');
    expect(output).not.toContain('gpt-5.6-sol');
    expect(output).toContain('ALLOWED_MODELS');
  });

  it('parses configured allowed models without inventing defaults', () => {
    expect(configuredAllowedModels({ ALLOWED_MODELS: ' model-a,model-b ' })).toEqual([
      'model-a',
      'model-b',
    ]);
    expect(configuredAllowedModels({})).toBeUndefined();
  });
});
