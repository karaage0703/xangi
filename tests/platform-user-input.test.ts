import { describe, expect, it, vi } from 'vitest';
import { discordUserInput, handleQuestionInteraction } from '../src/discord/user-input.js';
import { registerSlackUserInput, slackUserInput } from '../src/slack-user-input.js';
import { listUserInputs, normalizeQuestions } from '../src/user-input.js';
const request = normalizeQuestions(
  [
    {
      id: '0',
      isOther: true,
      question: 'Choose?',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: true,
    },
  ],
  'codex'
);
// The shared UI supports multiple selections independently of provider adapters.
request.questions[0].multiSelect = true;
describe('platform question adapters', () => {
  it('Discord rejects another actor and returns selected labels from the owner modal', async () => {
    const edit = vi.fn(async () => {});
    const send = vi.fn(async () => ({ edit }));
    const controller = new AbortController();
    const pending = discordUserInput('channel', 'alice', send as never)(request, controller.signal);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[0]).toEqual([
        expect.objectContaining({
          content: '質問 1: Choose?\n\n(1) A\n(2) B',
        }),
      ]);
      const [q] = listUserInputs('discord:channel', 'alice');
      const interaction = (actor: string) => ({
        isButton: () => false,
        isModalSubmit: () => true,
        customId: `question:${q.id}:0`,
        channelId: 'channel',
        user: { id: actor },
        fields: { getTextInputValue: () => '1,2' },
        reply: vi.fn(async () => {}),
      });
      const other = interaction('bob');
      await handleQuestionInteraction(other as never);
      expect(other.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('回答権限') })
      );
      await handleQuestionInteraction(interaction('alice') as never);
      expect(await pending).toEqual({ answers: { '0': ['A', 'B'] } });
      expect(edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    } finally {
      controller.abort();
      await pending;
    }
  });
  it('Slack opens only for the initiating actor and settles via the modal', async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const app = {
      action: (id: string, handler: any) => handlers.set(id, handler),
      view: (id: any, handler: any) => handlers.set(typeof id === 'string' ? id : id.type, handler),
    };
    registerSlackUserInput(app as never);
    const client = {
      chat: { postMessage: vi.fn(async () => ({ ts: '1' })), update: vi.fn(async () => {}) },
      views: { open: vi.fn(async () => {}) },
    };
    const controller = new AbortController();
    const pending = slackUserInput(
      client as never,
      'channel',
      'thread',
      'alice'
    )(request, controller.signal);
    try {
      const scope = 'slack:channel:thread';
      const [q] = listUserInputs(scope, 'alice');
      const action = { value: JSON.stringify({ id: q.id, scope }) };
      await handlers.get('xangi_question')!({
        ack: vi.fn(),
        body: { user: { id: 'bob' }, trigger_id: 'trigger' },
        action,
        client,
      });
      expect(client.views.open).not.toHaveBeenCalled();
      await handlers.get('xangi_question')!({
        ack: vi.fn(),
        body: { user: { id: 'alice' }, trigger_id: 'trigger' },
        action,
        client,
      });
      expect(client.views.open).toHaveBeenCalledOnce();
      await handlers.get('xangi_question_answer')!({
        ack: vi.fn(),
        body: { user: { id: 'alice' } },
        view: {
          private_metadata: action.value,
          state: { values: { '0': { answer: { value: '2' } } } },
        },
      });
      expect(await pending).toEqual({ answers: { '0': ['B'] } });
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '回答を受け付けました。\nChoose?\n回答: B',
          blocks: expect.arrayContaining([
            expect.objectContaining({ text: { type: 'plain_text', text: 'Choose?\n回答: B' } }),
          ]),
        })
      );
    } finally {
      controller.abort();
      await pending;
    }
  });
});

it('Slack keeps the question and marks cancellation without claiming an answer', async () => {
  const client = {
    chat: {
      postMessage: vi.fn(async () => ({ ts: 'cancelled' })),
      update: vi.fn(async () => {}),
    },
  };
  const controller = new AbortController();
  const pending = slackUserInput(
    client as never,
    'cancel-channel',
    'thread',
    'alice'
  )(request, controller.signal);
  await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledOnce());
  controller.abort();
  expect(await pending).toEqual({ cancelled: true });
  expect(client.chat.update).toHaveBeenCalledWith(
    expect.objectContaining({
      text: '質問を取り消したか、受付時間が終了しました。\nChoose?\n未回答',
    })
  );
});

it.each(
  ['discord', 'slack'].flatMap((platform) =>
    ['reply', 'stop'].map((action) => ({ platform, action }))
  )
)(
  '$platform displays the configured deadline and $action outcome',
  async ({ platform, action }) => {
    vi.useFakeTimers();
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MS', '120000');
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_ACTION', action);
    const controller = new AbortController();
    const edit = vi.fn(async () => {});
    const send = vi.fn(async () => ({ edit }));
    const client = {
      chat: { postMessage: vi.fn(async () => ({ ts: 'expired' })), update: vi.fn(async () => {}) },
    };
    const pending =
      platform === 'discord'
        ? discordUserInput('expired', 'alice', send as never)(request, controller.signal)
        : slackUserInput(
            client as never,
            'expired',
            undefined,
            'alice'
          )(request, controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const text =
        platform === 'discord'
          ? (send.mock.calls[1] as any)[0].content
          : (client.chat.postMessage.mock.calls[0] as any)[0].text;
      expect(text).toContain('2分以内');
      expect(text).toContain(
        action === 'stop' ? '期限後は作業を停止します' : '期限後は未回答として作業を続けます'
      );
      await vi.advanceTimersByTimeAsync(120000);
      expect(await pending).toMatchObject(
        action === 'stop' ? { cancelled: true, timedOut: true } : { unavailable: true }
      );
      const updated =
        platform === 'discord'
          ? (edit.mock.calls[0] as any)[0]
          : (client.chat.update.mock.calls[0] as any)[0];
      expect(platform === 'discord' ? updated.content : updated.text).toContain(
        action === 'stop' ? '設定に従い作業を停止' : '今は回答できない状況'
      );
      expect(platform === 'discord' ? updated.components : updated.blocks).not.toBeUndefined();
      expect(
        listUserInputs(platform === 'discord' ? 'discord:expired' : 'slack:expired:', 'alice')
      ).toEqual([]);
    } finally {
      controller.abort();
      await pending;
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  }
);
