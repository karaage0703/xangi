import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalLlmRunner } from '../src/local-llm/runner.js';
import { LLMClient } from '../src/local-llm/llm-client.js';
import { StreamingDriftBuffer } from '../src/local-llm/pseudo-toolcall.js';
import type { LLMMessage, LLMToolCall } from '../src/local-llm/types.js';

describe('loop guards through real tool execution', () => {
  let workdir: string;
  let paths: string[];
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'xangi-loop-regression-'));
    const root = 'notes/manual/procedures/equipment-loan-policy';
    paths = [`${root}.md`, `${root}/02_forms.md`, `${root}/06_fees.md`];
    paths.forEach((path, i) => {
      mkdirSync(dirname(join(workdir, path)), { recursive: true });
      writeFileSync(join(workdir, path), `section-content-${i}`);
    });
    vi.stubEnv('LOCAL_LLM_MODE', 'agent');
    vi.stubEnv('LOCAL_LLM_SKILLS', 'false');
    vi.stubEnv('LOCAL_LLM_XANGI_COMMANDS', 'false');
    vi.stubEnv('LOCAL_LLM_TOOL_SEARCH_ENABLED', 'false');
    vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR', 'on');
    vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', '0.85');
    vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT', '2');
    vi.stubEnv('LOCAL_LLM_LOOP_WINDOW', '8');
    vi.stubEnv('XANGI_HOOKS_ENABLED', 'false');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(workdir, { recursive: true, force: true });
  });
  const read = (path: string, i: number): LLMToolCall => ({
    id: `r${i}`,
    name: 'read',
    arguments: { path },
  });
  // Isolate the rescue safety layer from the earlier presentation filter, which drops
  // complete pseudo-calls before they can reach rescue. File tools remain real.
  const exposeRescue = () =>
    vi
      .spyOn(StreamingDriftBuffer.prototype, 'feed')
      .mockImplementation((chunk) => ({ release: chunk, dropped: false }));

  it.each([false, true])('reads all three sections (stream=%s)', async (stream) => {
    const outputs: string[] = [];
    let index = 0;
    vi.spyOn(LLMClient.prototype, 'chat').mockImplementation(async (messages) => {
      outputs.push(...messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
      return index < paths.length
        ? { content: '', finishReason: 'tool_calls', toolCalls: [read(paths[index], index++)] }
        : { content: 'done', finishReason: 'stop' };
    });
    vi.spyOn(LLMClient.prototype, 'chatStream').mockImplementation(async function* () {
      yield 'done';
    });
    const runner = new LocalLlmRunner({ workdir, model: 'test', skipPermissions: false });
    const result = stream
      ? await runner.runStream('read sections', {})
      : await runner.run('read sections');
    expect(result.failed).not.toBe(true);
    for (let i = 0; i < 3; i++) expect(outputs).toContain(`section-content-${i}`);
    expect(
      outputs.some(
        (output) => output.includes('This is a loop') || output.includes('similar (normalized)')
      )
    ).toBe(false);
  });

  it.each(['on', 'off'])(
    'applies the switch to pseudo-call rescue (similar=%s)',
    async (enabled) => {
      exposeRescue();
      vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR', enabled);
      vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT', '1');
      let calls = 0;
      vi.spyOn(LLMClient.prototype, 'chat').mockImplementation(async () =>
        calls++ === 0
          ? { content: '', finishReason: 'tool_calls', toolCalls: [read(paths[0], 0)] }
          : { content: '', finishReason: 'stop' }
      );
      const snapshots: string[] = [];
      let streams = 0;
      vi.spyOn(LLMClient.prototype, 'chatStream').mockImplementation(async function* (messages) {
        snapshots.push(messages.map((m) => String(m.content)).join('\n'));
        yield streams++ === 0 ? `call:read{path:${join(workdir, paths[0])}}` : 'done';
      });
      const runner = new LocalLlmRunner({ workdir, model: 'test' });
      const result = await runner.runStream('read', {});
      expect(result.failed).not.toBe(true);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].includes('[RESCUED TOOL RESULT]')).toBe(enabled === 'off');
      if (enabled === 'on') expect(snapshots[1]).toContain('Loop detected');
      else expect(snapshots[1]).toContain('section-content-0');
    }
  );

  it('rescues the third distinct read after two regular reads', async () => {
    exposeRescue();
    let calls = 0;
    vi.spyOn(LLMClient.prototype, 'chat').mockImplementation(async () =>
      calls++ === 0
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [read(paths[0], 0), read(paths[1], 1)],
          }
        : { content: '', finishReason: 'stop' }
    );
    const snapshots: string[] = [];
    let streams = 0;
    vi.spyOn(LLMClient.prototype, 'chatStream').mockImplementation(async function* (messages) {
      snapshots.push(messages.map((m) => String(m.content)).join('\n'));
      yield streams++ === 0 ? `call:read{path:${join(workdir, paths[2])}}` : 'done';
    });
    const result = await new LocalLlmRunner({ workdir, model: 'test' }).runStream('read', {});
    expect(result.failed).not.toBe(true);
    expect(snapshots[1]).toContain('[RESCUED TOOL RESULT]');
    expect(snapshots[1]).toContain('section-content-2');
  });

  it('still blocks exact repetition in pseudo-call rescue with similar off', async () => {
    exposeRescue();
    vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR', 'off');
    let calls = 0;
    vi.spyOn(LLMClient.prototype, 'chat').mockImplementation(async () =>
      calls++ === 0
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [read(paths[0], 0), read(paths[0], 1)],
          }
        : { content: '', finishReason: 'stop' }
    );
    const snapshots: string[] = [];
    let streams = 0;
    vi.spyOn(LLMClient.prototype, 'chatStream').mockImplementation(async function* (messages) {
      snapshots.push(messages.map((m) => String(m.content)).join('\n'));
      yield streams++ === 0 ? `call:read{path:${paths[0]}}` : 'done';
    });
    await new LocalLlmRunner({ workdir, model: 'test' }).runStream('read', {});
    expect(snapshots[1]).toContain('Loop detected');
    expect(snapshots[1]).not.toContain('[RESCUED TOOL RESULT]');
  });

  it.each([false, true])(
    'preserves exact blocking with similar off (stream=%s)',
    async (stream) => {
      vi.stubEnv('LOCAL_LLM_LOOP_SIMILAR', 'off');
      let messages: LLMMessage[] = [];
      let calls = 0;
      vi.spyOn(LLMClient.prototype, 'chat').mockImplementation(async (current) => {
        messages = [...current];
        return calls++ === 0
          ? {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [0, 1, 2].map((i) => read(paths[0], i)),
            }
          : { content: 'done', finishReason: 'stop' };
      });
      vi.spyOn(LLMClient.prototype, 'chatStream').mockImplementation(async function* () {
        yield 'done';
      });
      const runner = new LocalLlmRunner({ workdir, model: 'test' });
      await (stream ? runner.runStream('read', {}) : runner.run('read'));
      const outputs = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      expect(outputs.filter((output) => output === 'section-content-0')).toHaveLength(2);
      expect(outputs[2]).toContain('3 times consecutively');
    }
  );

  it.each([true, false])(
    'resets history only after a successful edit (success=%s)',
    async (success) => {
      let messages: LLMMessage[] = [];
      let calls = 0;
      vi.spyOn(LLMClient.prototype, 'chat').mockImplementation(async (current) => {
        messages = [...current];
        return calls++ === 0
          ? {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                read(paths[0], 0),
                read(paths[0], 1),
                {
                  id: 'edit',
                  name: 'edit',
                  arguments: {
                    path: paths[0],
                    old_string: success ? 'section-content-0' : 'not present',
                    new_string: 'changed',
                  },
                },
                read(paths[0], 3),
              ],
            }
          : { content: 'done', finishReason: 'stop' };
      });
      await new LocalLlmRunner({ workdir, model: 'test' }).run('edit and verify');
      const last = String(messages.filter((m) => m.role === 'tool').at(-1)?.content);
      if (success) expect(last).toBe('changed');
      else expect(last).toContain('similar (normalized)');
    }
  );
});
