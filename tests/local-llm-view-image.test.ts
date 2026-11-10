import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeTool, loadAlwaysLoadedToolNames } from '../src/local-llm/tools.js';
import { LocalLlmRunner, type Session } from '../src/local-llm/runner.js';
import { LLMClient } from '../src/local-llm/llm-client.js';
import type { LLMToolCall } from '../src/local-llm/types.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';
let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'xangi-view-image-'));
  writeFileSync(join(workspace, 'photo.png'), Buffer.from(png, 'base64'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

describe('view_image', () => {
  it('is discoverable by default and returns image data separately from log text', async () => {
    expect(loadAlwaysLoadedToolNames({}).has('view_image')).toBe(true);
    const result = await executeTool('view_image', { path: 'photo.png' }, { workspace });
    expect(result.success).toBe(true);
    expect(result.images).toEqual([{ mimeType: 'image/png', base64: png }]);
    expect(result.output).not.toContain(png);
  });
  it.each(['missing.png', '/etc/passwd', '.', 'bad.png', 'empty.png', 'large.png', 'escape.png'])(
    'reports failure without images for %s',
    async (path) => {
      writeFileSync(join(workspace, 'bad.png'), 'text is not an image');
      writeFileSync(join(workspace, 'empty.png'), '');
      writeFileSync(join(workspace, 'large.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
      symlinkSync('/etc/passwd', join(workspace, 'escape.png'));
      const result = await executeTool('view_image', { path }, { workspace });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.images).toBeUndefined();
    }
  );
  it.each(['ollama', 'openai'])(
    'carries tool images through the shared runner into the next %s request',
    async (provider) => {
      const session: Session = {
        messages: [],
        updatedAt: Date.now(),
        activeToolNames: new Set(),
        recentToolCallSigs: [],
        recentToolLoopEntries: [],
        idempotentResultCache: new Map(),
      };
      const runner = new LocalLlmRunner({ workdir: workspace, model: 'test' });
      const calls: LLMToolCall[] = [
        { id: 'image', name: 'view_image', arguments: { path: 'photo.png' } },
        { id: 'missing', name: 'view_image', arguments: { path: 'missing.png' } },
      ];
      session.messages.push({ role: 'assistant', content: '', toolCalls: calls });
      const internal = runner as unknown as {
        executeToolCalls: (...args: unknown[]) => Promise<void>;
      };
      await internal.executeToolCalls(
        session,
        calls,
        'c',
        's',
        0,
        undefined,
        [],
        new AbortController().signal
      );
      expect(session.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'runtime']);
      expect(session.messages[2].content).toContain('Error:');
      expect(session.messages[3].images?.[0].base64).toBe(png);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify(
              provider === 'ollama'
                ? { message: { content: 'seen' }, done: true }
                : { choices: [{ message: { content: 'seen' }, finish_reason: 'stop' }] }
            ),
            { status: 200 }
          )
        );
      const client = new LLMClient(
        provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8000',
        'test'
      );
      await client.chat(session.messages);
      const payload = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      const imageMessage = payload.messages.at(-1);
      expect(imageMessage.role).toBe('user');
      if (provider === 'ollama') expect(imageMessage.images).toEqual([png]);
      else
        expect(imageMessage.content).toContainEqual({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${png}` },
        });
      expect(
        payload.messages
          .filter((m: { role: string }) => m.role === 'tool')
          .every((m: { content: unknown }) => typeof m.content === 'string')
      ).toBe(true);
    }
  );
});
