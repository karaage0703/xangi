import { describe, expect, it, vi, afterEach } from 'vitest';
import { ProviderModels, observeClaudeModel } from '../src/provider-model.js';
import { ClaudeCodeRunner } from '../src/claude-code.js';
import { CursorRunner } from '../src/cursor-cli.js';
import { GrokRunner } from '../src/grok-cli.js';
import { GitHubCopilotRunner } from '../src/github-copilot-cli.js';
import { OpenCodeRunner } from '../src/opencode-cli.js';
import { AntigravityRunner } from '../src/antigravity-cli.js';
import { LLMClient } from '../src/local-llm/llm-client.js';
import type { CliStreamParser } from '../src/cli-runner-core.js';
import type { StreamCallbacks } from '../src/agent-runner.js';

function parser(runner: unknown, onModel = vi.fn()): CliStreamParser {
  return (runner as { createStreamParser(c: StreamCallbacks): CliStreamParser }).createStreamParser({ onModel });
}

describe('provider-reported model evidence', () => {
  afterEach(() => vi.restoreAllMocks());
  it('rejects placeholders and malformed identities, preserves changes and isolates snapshots', () => {
    const onModel = vi.fn();
    const models = new ProviderModels(onModel);
    for (const value of ['auto', 'default', '<synthetic>', {}, 'x\ny', '']) models.add(value);
    expect(models.result()).toEqual({});
    models.add('model-a');
    const snapshot = models.result();
    models.add('model-b');
    models.add('model-a');
    expect(snapshot.models).toEqual(['model-a']);
    expect(models.result()).toEqual({ model: 'model-a', models: ['model-a', 'model-b'] });
    expect(onModel.mock.calls.flat()).toEqual(['model-a', 'model-b', 'model-a']);
  });
  it('Claude excludes child agents and ambiguous aggregate usage', () => {
    const models = new ProviderModels();
    observeClaudeModel(models, { type: 'assistant', parent_tool_use_id: 'tool', message: { model: 'child' } });
    observeClaudeModel(models, { type: 'result', modelUsage: { child: {}, main: {} } });
    expect(models.result()).toEqual({});
    observeClaudeModel(models, { type: 'assistant', message: { model: 'main' } });
    observeClaudeModel(models, { type: 'result', modelUsage: { child: {}, main: {} } });
    expect(models.result().models).toEqual(['main']);
  });
  it('Claude emits identity before text and does not inherit a previous parser request', () => {
    const runner = new ClaudeCodeRunner();
    const onModel = vi.fn();
    const first = parser(runner, onModel);
    first.handleEvent({ type: 'assistant', message: { model: 'claude-main', content: [] } }, 'stream');
    expect(onModel).toHaveBeenCalledWith('claude-main');
    expect(first.finalize().model).toBe('claude-main');
    expect(parser(runner).finalize().model).toBeUndefined();
  });
  it.each([['cursor', new CursorRunner()], ['grok', new GrokRunner()]])('%s only trusts native model metadata, never body or tool fields', (_name, runner) => {
    const p = parser(runner);
    p.handleEvent({ type: 'assistant', model: 'observed', message: { content: [] } }, 'stream');
    p.handleEvent({ type: 'tool_call', model: 'tool-input' }, 'stream');
    expect(p.finalize().models).toEqual(['observed']);
  });
  it('Copilot excludes subagent, compaction, and sampling usage', () => {
    const p = parser(new GitHubCopilotRunner());
    for (const data of [{ model: 'child', initiator: 'sub-agent' }, { model: 'summary', interactionType: 'conversation-compaction' }, { model: 'child', parentToolCallId: 'tool' }, { model: 'main', interactionType: 'conversation-agent' }]) {
      p.handleEvent({ type: 'assistant.usage', data }, 'stream');
    }
    p.handleEvent({ type: 'result', sessionId: 'session' }, 'stream');
    expect(p.finalize().models).toEqual(['main']);
  });
  it('OpenCode missing model evidence remains unknown even with an explicit configured model', () => {
    const p = parser(new OpenCodeRunner({ model: 'configured' }));
    p.handleEvent({ type: 'step_start', sessionID: 'session', part: {} }, 'stream');
    expect(p.finalize().models).toBeUndefined();
  });
  it('Antigravity accepts native envelopes and ignores ordinary JSON answers', () => {
    const p = parser(new AntigravityRunner());
    p.handleEvent({ event: 'init', init: { conversation_id: 'session', model: 'native' } }, 'stream');
    p.handleEvent({ model: 'made-up', response: 'user json' }, 'stream');
    p.handleEvent({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }, 'stream');
    expect(p.finalize().models).toEqual(['native']);
  });
  it('local API captures response model instead of requested alias for both JSON and SSE', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const onModel = vi.fn();
    const client = new LLMClient('http://localhost:12345', 'requested');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ model: 'actual-json', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })));
    await client.chat([{ role: 'user', content: 'hello' }], { onModel });
    fetch.mockResolvedValueOnce(new Response('data: {"model":"actual-sse","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    for await (const _chunk of client.chatStream([{ role: 'user', content: 'hello' }], { onModel })) { /* drain */ }
    expect(onModel.mock.calls.flat()).toEqual(['actual-json', 'actual-sse']);
  });
});
