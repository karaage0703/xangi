import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events, type Client, type Message } from 'discord.js';
import { processPrompt, registerDiscordMessageHandlers } from '../src/discord/message-handler.js';
import { clearSessions, initSessions, setSession } from '../src/sessions.js';
import { clearSettingsCache, initSettings } from '../src/settings.js';
import type { Config } from '../src/config.js';
import { finalizeActiveStreams } from '../src/stream-finalizer.js';
import type { AgentRunner } from '../src/agent-runner.js';

const directories: string[] = [];
afterEach(() => {
  clearSessions();
  clearSettingsCache();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Discord response critical path', () => {
  it.each(['first-history', 'resumed-quotes'] as const)(
    '%s preserves context while reducing waits',
    async (scenario) => {
      const rtt = Number(process.env.XANGI_RESPONSE_BENCH_RTT_MS ?? 20);
      const repeats = Number(process.env.XANGI_RESPONSE_BENCH_REPEATS ?? 1);
      const samples: Array<Record<string, number>> = [];
      let lastPrompt = '';
      for (let i = 0; i < repeats; i++) {
        clearSessions();
        clearSettingsCache();
        const directory = mkdtempSync(join(tmpdir(), 'discord-response-'));
        directories.push(directory);
        initSessions(directory);
        initSettings(directory);
        if (scenario === 'resumed-quotes') setSession('thread', 'provider');
        const started = performance.now();
        const timing: Record<string, number> = {};
        const delay = async (key: string, value: unknown, duration = rtt) => {
          await new Promise((resolve) => setTimeout(resolve, duration));
          timing[key] = performance.now() - started;
          return value;
        };
        const quoted = (content: string) => ({
          content,
          author: { tag: 'person', username: 'person' },
          attachments: new Map(),
        });
        const response = { id: 'response', edit: vi.fn().mockResolvedValue(undefined) };
        const handlers = new Map<string, (message: Message) => Promise<void>>();
        const client = {
          user: { id: 'bot' },
          on: (event: string, handler: (message: Message) => Promise<void>) => {
            handlers.set(event, handler);
            return client;
          },
          channels: {
            fetch: vi
              .fn()
              .mockResolvedValue({
                messages: { fetch: () => delay('link', quoted('linked body')) },
              }),
          },
        };
        const message = {
          id: 'source',
          content:
            scenario === 'resumed-quotes' ? 'https://discord.com/channels/1/2/3' : 'question',
          createdTimestamp: Date.now(),
          author: { id: 'user', username: 'user' },
          client,
          mentions: { has: () => true },
          guild: {},
          attachments: new Map(),
          reference: scenario === 'resumed-quotes' ? { messageId: 'reply' } : undefined,
          channel: {
            id: 'thread',
            name: 'topic',
            parentId: 'parent',
            isThread: () => scenario === 'resumed-quotes',
            fetchStarterMessage: () => delay('starter', quoted('starter body')),
            messages: {
              fetch: (query: unknown) =>
                typeof query === 'string'
                  ? delay('reference', quoted('reply body'))
                  : delay('history', new Map()),
            },
            send: vi.fn().mockResolvedValue(response),
          },
          react: () => delay('reaction', undefined),
          reactions: { cache: { find: () => undefined } },
          reply: () => delay('initial', response),
        };
        const runStream = vi.fn().mockImplementation(async (prompt, callbacks) => {
          lastPrompt = prompt;
          timing.runner = performance.now() - started;
          await delay('model', undefined, rtt / 2);
          callbacks.onText?.('answer', 'answer');
          return { result: 'answer', sessionId: 'provider' };
        });
        registerDiscordMessageHandlers({
          client: client as unknown as Client,
          agentRunner: { runStream } as unknown as AgentRunner,
          config: {
            agent: { backend: 'claude-code', config: { workdir: directory } },
            discord: {
              allowedUsers: ['*'],
              showButtons: false,
              replySuggestions: false,
              completionNotifyMode: 'off',
            },
            historyPrefetch: { enabled: true, count: 10 },
          } as unknown as Config,
          workdir: directory,
        });
        await handlers.get(Events.MessageCreate)!(message as unknown as Message);
        timing.complete = performance.now() - started;
        // Let any optional reaction finish before removing the fixture.
        await new Promise((resolve) => setTimeout(resolve, rtt));
        expect(runStream).toHaveBeenCalledTimes(1);
        samples.push(timing);
      }
      if (process.env.XANGI_RESPONSE_BENCH_OUT) {
        appendFileSync(
          process.env.XANGI_RESPONSE_BENCH_OUT,
          JSON.stringify({ scenario, rtt, repeats, samples }) + '\n'
        );
      }
      if (scenario === 'first-history') {
        expect(lastPrompt).toContain('<prefetched-history');
        if (process.env.XANGI_RESPONSE_BENCH_RTT_MS) {
          expect(samples.every((sample) => sample.initial < rtt * 2.5)).toBe(true);
          expect(samples.every((sample) => sample.runner < rtt * 2.5)).toBe(true);
        }
      } else {
        expect(lastPrompt.indexOf('reply body')).toBeLessThan(lastPrompt.indexOf('starter body'));
        expect(lastPrompt.indexOf('starter body')).toBeLessThan(lastPrompt.indexOf('linked body'));
        if (process.env.XANGI_RESPONSE_BENCH_RTT_MS) {
          expect(samples.every((sample) => sample.runner < rtt * 3.5)).toBe(true);
        }
      }
    },
    60_000
  );
});

// Deferred promises test ordering without depending on wall-clock performance.
describe('Discord optional I/O ordering', () => {
  it.each(['complete', 'shutdown', 'history-error', 'initial-error'] as const)(
    '%s handles pending history and late reactions',
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), 'discord-response-order-'));
      directories.push(directory);
      initSessions(directory);
      initSettings(directory);
      let finishReaction!: () => void;
      let finishHistory!: () => void;
      let failHistory!: (error: Error) => void;
      let added = false;
      const history = new Promise<Map<string, never>>((resolve, reject) => {
        finishHistory = () => resolve(new Map());
        failHistory = reject;
      });
      const reaction = new Promise<void>((resolve) => {
        finishReaction = () => {
          added = true;
          resolve();
        };
      });
      const remove = vi.fn().mockResolvedValue(undefined);
      const edit = vi.fn().mockResolvedValue(undefined);
      const sendInitial =
        outcome === 'initial-error'
          ? vi.fn().mockRejectedValue(new Error('initial failed'))
          : vi.fn().mockResolvedValue({ id: 'reply', edit });
      const runStream = vi.fn().mockResolvedValue({ result: 'answer', sessionId: 'provider' });
      const message = {
        id: 'source',
        content: 'question',
        createdTimestamp: Date.now(),
        author: { id: 'user', username: 'user' },
        client: { user: { id: 'bot' } },
        react: () => reaction,
        reply: vi.fn().mockResolvedValue(undefined),
        reactions: { cache: { find: () => (added ? { users: { remove } } : undefined) } },
        channel: { name: 'test', messages: { fetch: () => history } },
      };
      const processing = processPrompt(
        message as never,
        { runStream } as never,
        'question',
        false,
        'thread',
        {
          agent: { backend: 'claude-code', config: { workdir: directory } },
          discord: { showButtons: false, replySuggestions: false, completionNotifyMode: 'off' },
          historyPrefetch: { enabled: true, count: 10 },
        } as never,
        {
          conversationChannelId: 'thread',
          settingsChannelId: 'thread',
          createdThreadName: null,
          isThread: false,
          sendInitial,
          outputChannel: { send: vi.fn() },
        } as never
      );
      await vi.waitFor(() => expect(sendInitial).toHaveBeenCalledTimes(1));
      expect(runStream).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      if (outcome === 'shutdown') await finalizeActiveStreams();
      if (outcome === 'history-error') failHistory(new Error('history unavailable'));
      else finishHistory();
      const result = await processing;
      expect(result).toBe(outcome === 'shutdown' || outcome === 'initial-error' ? null : 'answer');
      expect(runStream).toHaveBeenCalledTimes(
        outcome === 'shutdown' || outcome === 'initial-error' ? 0 : 1
      );
      expect(remove).not.toHaveBeenCalled();
      finishReaction();
      await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
      if (outcome === 'shutdown')
        expect(edit).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('中断') })
        );
    }
  );
});
