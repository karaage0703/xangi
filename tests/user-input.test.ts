import { describe, expect, it, vi } from 'vitest';
import {
  userInputEnabled,
  answerUserInput,
  listUserInputs,
  normalizeQuestions,
  requestUserInput,
  validateAnswer,
} from '../src/user-input.js';
const request = normalizeQuestions(
  [
    {
      id: '0',
      isOther: true,
      question: 'Choose?',
      header: 'Choice',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
    },
  ],
  'codex'
);
describe('user input lifecycle', () => {
  it('requires every question and validates cardinality and free text capability', () => {
    expect(() => validateAnswer(request, { answers: {} })).toThrow();
    expect(() => validateAnswer(request, { unavailable: true })).toThrow();
    expect(() => validateAnswer(request, { answers: { '0': ['A', 'B'] } })).toThrow();
    expect(validateAnswer(request, { answers: { '0': ['custom'] } })).toEqual({
      answers: { '0': ['custom'] },
    });
    const fixed = normalizeQuestions(
      [{ id: 'q', question: '?', options: [{ label: 'A' }], isOther: false }],
      'codex'
    );
    expect(() => validateAnswer(fixed, { answers: { q: ['custom'] } })).toThrow();
  });
  it('binds actor and conversation and consumes exactly once', async () => {
    const promise = requestUserInput(
      'discord:a',
      'alice',
      request,
      new AbortController().signal,
      async () => {}
    );
    const [q] = listUserInputs('discord:a', 'alice');
    expect(listUserInputs('discord:a', 'bob')).toEqual([]);
    expect(() => answerUserInput(q.id, 'discord:b', 'alice', { cancelled: true })).toThrow();
    expect(() => answerUserInput(q.id, 'discord:a', 'bob', { cancelled: true })).toThrow();
    answerUserInput(q.id, 'discord:a', 'alice', { answers: { '0': ['A'] } });
    expect(() => answerUserInput(q.id, 'discord:a', 'alice', { cancelled: true })).toThrow();
    expect(await promise).toEqual({ answers: { '0': ['A'] } });
  });
  it('cleans up on backend cancellation and presentation failure', async () => {
    const abort = new AbortController();
    const promise = requestUserInput('web:a', 'web', request, abort.signal, async () => {});
    abort.abort();
    expect(await promise).toEqual({ cancelled: true });
    expect(listUserInputs('web:a', 'web')).toEqual([]);
    await expect(
      requestUserInput('web:a', 'web', request, new AbortController().signal, async () => {
        throw new Error('offline');
      })
    ).rejects.toThrow('offline');
    expect(listUserInputs('web:a', 'web')).toEqual([]);
  });
  it('expires without accepting any default selection', async () => {
    vi.useFakeTimers();
    try {
      const promise = requestUserInput(
        'web:a',
        'web',
        request,
        new AbortController().signal,
        async () => {}
      );
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await promise).toMatchObject({ unavailable: true });
      expect(listUserInputs('web:a', 'web')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects duplicate IDs and oversized or malformed provider data', () => {
    expect(() => normalizeQuestions([], 'codex')).toThrow();
    expect(() =>
      normalizeQuestions(
        [
          { id: 'x', question: '?' },
          { id: 'x', question: '?' },
        ],
        'codex'
      )
    ).toThrow();
    expect(() => normalizeQuestions([{ question: 'x'.repeat(2001) }], 'codex')).toThrow();
  });
});

it('enables question delivery without configuration and supports explicit opt-out', () => {
  const previous = process.env.AGENT_USER_INPUT;
  try {
    delete process.env.AGENT_USER_INPUT;
    expect(userInputEnabled()).toBe(true);
    process.env.AGENT_USER_INPUT = 'false';
    expect(userInputEnabled()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_USER_INPUT;
    else process.env.AGENT_USER_INPUT = previous;
  }
});

it('uses the configured deadline and rejects late answers', async () => {
  vi.useFakeTimers();
  vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MS', '120000');
  try {
    const promise = requestUserInput(
      'web:deadline',
      'web',
      request,
      new AbortController().signal,
      async () => {}
    );
    const [q] = listUserInputs('web:deadline', 'web');
    expect(q.expiresAt - Date.now()).toBe(120000);
    await vi.advanceTimersByTimeAsync(119999);
    expect(listUserInputs('web:deadline', 'web')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ unavailable: true });
    expect(() =>
      answerUserInput(q.id, 'web:deadline', 'web', { answers: { '0': ['A'] } })
    ).toThrow();
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

it.each(['0', '-1', 'NaN', '1000junk', '1.5', '86400001'])(
  'ignores invalid deadline %s',
  async (value) => {
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MS', value);
    const controller = new AbortController();
    try {
      const promise = requestUserInput(
        'web:invalid',
        'web',
        request,
        controller.signal,
        async () => {}
      );
      const [q] = listUserInputs('web:invalid', 'web');
      expect(q.expiresAt - Date.now()).toBeGreaterThan(599900);
      controller.abort();
      expect(await promise).toEqual({ cancelled: true });
    } finally {
      controller.abort();
      vi.unstubAllEnvs();
    }
  }
);

it.each(['stop', 'reply', 'invalid'])(
  'applies timeout action %s with the selected reply',
  async (action) => {
    vi.useFakeTimers();
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MS', '1000');
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_ACTION', action);
    const message = '今は回答できません。\n既存の調査結果を報告してください。';
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MESSAGE', message);
    try {
      const result = requestUserInput(
        'web:policy',
        'web',
        request,
        new AbortController().signal,
        async () => {}
      );
      expect(listUserInputs('web:policy', 'web')[0]).toMatchObject({
        timeoutAction: action === 'stop' ? 'stop' : 'reply',
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toEqual(
        action === 'stop' ? { cancelled: true, timedOut: true } : { unavailable: true, message }
      );
      expect(listUserInputs('web:policy', 'web')).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  }
);

it('keeps the default reply for blank or oversized messages', async () => {
  const { userInputTimeoutMessage, USER_UNAVAILABLE_NOTICE } = await import('../src/user-input.js');
  for (const value of ['', '   ', 'a'.repeat(4001), 'json:not-valid']) {
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MESSAGE', value);
    expect(userInputTimeoutMessage()).toBe(USER_UNAVAILABLE_NOTICE);
  }
  vi.unstubAllEnvs();
});
