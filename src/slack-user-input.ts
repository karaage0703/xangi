import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  answerUserInput,
  listUserInputs,
  requestUserInput,
  userInputWaitLabel,
  userInputTimeoutHint,
  type UserInputCallback,
  type UserInputResult,
} from './user-input.js';
export function slackUserInput(
  client: WebClient,
  channel: string,
  thread: string | undefined,
  actor: string
): UserInputCallback {
  const scope = `slack:${channel}:${thread || ''}`;
  return async (request, signal) => {
    let ts: string | undefined;
    let answer: UserInputResult | undefined;
    try {
      answer = await requestUserInput(scope, actor, request, signal, async (pending) => {
        const result = await client.chat.postMessage({
          channel,
          thread_ts: thread,
          text: `回答を待っています（${userInputWaitLabel(pending.expiresAt)}以内）。${userInputTimeoutHint(pending.timeoutAction)}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'plain_text',
                text: `質問があります。回答フォームを開いてください（${userInputWaitLabel(pending.expiresAt)}以内）。${userInputTimeoutHint(pending.timeoutAction)}`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'xangi_question',
                  text: { type: 'plain_text', text: '回答する' },
                  value: JSON.stringify({ id: pending.id, scope }),
                },
              ],
            },
          ],
        });
        ts = result.ts;
      });
      return answer;
    } finally {
      const status =
        answer && 'answers' in answer
          ? '回答を受け付けました。'
          : answer && 'unavailable' in answer
            ? '回答期限を過ぎました。今は回答できない状況として、可能な作業を続けます。'
            : answer && 'timedOut' in answer
              ? '回答期限を過ぎたため、設定に従い作業を停止しました。'
              : '質問を取り消したか、受付時間が終了しました。';
      const summaries = request.questions.map((q) =>
        `${q.question}\n${answer && 'answers' in answer ? `回答: ${answer.answers[q.id].join('、')}` : '未回答'}`.slice(
          0,
          3000
        )
      );
      if (ts)
        await client.chat
          .update({
            channel,
            ts,
            text: `${status}\n${summaries.join('\n\n')}`,
            blocks: [status, ...summaries].map((text) => ({
              type: 'section',
              text: { type: 'plain_text', text },
            })),
          })
          .catch(() => undefined);
    }
  };
}
export function registerSlackUserInput(app: App): void {
  app.action('xangi_question', async ({ ack, body, action, client }) => {
    await ack();
    if (!('value' in action) || !action.value || !('trigger_id' in body)) return;
    const { id, scope } = JSON.parse(action.value) as { id: string; scope: string };
    const request = listUserInputs(scope, body.user.id).find((q) => q.id === id);
    if (!request) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'xangi_question_answer',
        private_metadata: JSON.stringify({ id, scope }),
        notify_on_close: true,
        title: { type: 'plain_text', text: '質問への回答' },
        submit: { type: 'plain_text', text: '回答を送信' },
        close: { type: 'plain_text', text: 'キャンセル' },
        blocks: request.questions.flatMap((q, i) => [
          {
            type: 'section' as const,
            text: {
              type: 'plain_text' as const,
              text: `${q.question}\n${q.options.map((o, n) => `${n + 1}. ${o.label} — ${o.description}`).join('\n')}`.slice(
                0,
                3000
              ),
            },
          },
          {
            type: 'input' as const,
            block_id: String(i),
            label: {
              type: 'plain_text' as const,
              text: q.multiSelect
                ? '番号をカンマ区切り、または自由入力'
                : '選択肢の番号、または自由入力',
            },
            element: {
              type: 'plain_text_input' as const,
              action_id: 'answer',
              multiline: true,
              max_length: 2000,
            },
          },
        ]),
      },
    });
  });
  app.view(
    { callback_id: 'xangi_question_answer', type: 'view_closed' },
    async ({ ack, body, view }) => {
      await ack();
      const { id, scope } = JSON.parse(view.private_metadata) as { id: string; scope: string };
      try {
        answerUserInput(id, scope, body.user.id, { cancelled: true });
      } catch {
        /* expired */
      }
    }
  );
  app.view('xangi_question_answer', async ({ ack, body, view }) => {
    const { id, scope } = JSON.parse(view.private_metadata) as { id: string; scope: string };
    const request = listUserInputs(scope, body.user.id).find((q) => q.id === id);
    if (!request) {
      await ack({
        response_action: 'errors',
        errors: { '0': '質問は終了済みか、回答権限がありません' },
      });
      return;
    }
    const answers = Object.fromEntries(
      request.questions.map((q, i) => {
        const raw = view.state.values[String(i)]?.answer?.value?.trim() || '';
        const parts = raw.split(',').map((s) => s.trim());
        return [
          q.id,
          parts.every((s) => /^\d+$/.test(s) && q.options[Number(s) - 1])
            ? parts.map((s) => q.options[Number(s) - 1].label)
            : [raw],
        ];
      })
    );
    try {
      answerUserInput(id, scope, body.user.id, { answers });
      await ack();
    } catch {
      await ack({ response_action: 'errors', errors: { '0': '各質問の回答を確認してください' } });
    }
  });
}
