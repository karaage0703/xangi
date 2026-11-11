import { splitDiscordMessage } from '../message-split.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type Message,
} from 'discord.js';
import {
  answerUserInput,
  listUserInputs,
  requestUserInput,
  userInputWaitLabel,
  userInputTimeoutHint,
  type UserInputCallback,
  type UserInputResult,
} from '../user-input.js';

/** A modal per question keeps Discord's five-input limit independent of batch size. */
const drafts = new Map<string, Record<string, string[]>>();
export function discordUserInput(
  channelId: string,
  actor: string,
  send: (payload: unknown) => Promise<Message>
): UserInputCallback {
  return async (request, signal) => {
    let message: Message | undefined;
    let answer: UserInputResult | undefined;
    let id = '';
    try {
      answer = await requestUserInput(
        `discord:${channelId}`,
        actor,
        request,
        signal,
        async (pending) => {
          id = pending.id;
          drafts.set(id, Object.create(null));
          for (const [i, q] of request.questions.entries()) {
            // Parenthesized labels stay literal: Discord otherwise continues the
            // question's ordered list and displays choices with shifted numbers.
            const choices = q.options.map(
              (o, n) => `(${n + 1}) ${o.label}${o.description.trim() ? ` — ${o.description}` : ''}`
            );
            const text = `質問 ${i + 1}: ${q.question}${choices.length ? `\n\n${choices.join('\n')}` : ''}`;
            for (const content of splitDiscordMessage(text, 1900))
              await send({ content, allowedMentions: { parse: [] } });
          }
          const rows = request.questions.map((q, i) =>
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`question:${id}:${i}`)
                .setLabel(`${i + 1}. ${q.header || '回答する'}`.slice(0, 80))
                .setStyle(ButtonStyle.Primary)
            )
          );
          rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`question:${id}:cancel`)
                .setLabel('キャンセル')
                .setStyle(ButtonStyle.Secondary)
            )
          );
          message = await send({
            content: `回答を待っています。各ボタンから回答してください（${userInputWaitLabel(pending.expiresAt)}以内）。${userInputTimeoutHint(pending.timeoutAction)}`,
            components: rows,
            allowedMentions: { parse: [] },
          });
        }
      );
      return answer;
    } finally {
      drafts.delete(id);
      if (message)
        await message
          .edit({
            content:
              answer && 'unavailable' in answer
                ? '回答期限を過ぎました。今は回答できない状況として、可能な作業を続けます。'
                : answer && 'timedOut' in answer
                  ? '回答期限を過ぎたため、設定に従い作業を停止しました。'
                  : '質問の受付を終了しました。',
            components: [],
          })
          .catch(() => undefined);
    }
  };
}
export async function handleQuestionInteraction(interaction: Interaction): Promise<boolean> {
  if (!('customId' in interaction) || !interaction.customId.startsWith('question:')) return false;
  if (
    (!interaction.isButton() && !interaction.isModalSubmit()) ||
    !interaction.customId.startsWith('question:')
  )
    return false;
  const [, id, index] = interaction.customId.split(':');
  const scope = `discord:${interaction.channelId}`;
  const request = listUserInputs(scope, interaction.user.id).find((q) => q.id === id);
  if (!request) {
    await interaction.reply({
      content: '質問は終了済みか、回答権限がありません。',
      ephemeral: true,
    });
    return true;
  }
  if (index === 'cancel') {
    answerUserInput(id, scope, interaction.user.id, { cancelled: true });
    await interaction.reply({ content: '質問をキャンセルしました。', ephemeral: true });
    return true;
  }
  const q = request.questions[Number(index)];
  if (!q) return true;
  if (interaction.isButton()) {
    // Full text and choices are sent ephemerally; modal labels have a 45-character limit.
    const modal = new ModalBuilder()
      .setCustomId(`question:${id}:${index}`)
      .setTitle((q.header || '質問への回答').slice(0, 45));
    const input = new TextInputBuilder()
      .setCustomId('answer')
      .setLabel(
        q.multiSelect ? '番号をカンマ区切り、または自由入力' : '選択肢の番号、または自由入力'
      )
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(2000)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  } else {
    const raw = interaction.fields.getTextInputValue('answer').trim();
    const indices = raw.split(',').map((s) => s.trim());
    const answer = indices.every((s) => /^\d+$/.test(s) && q.options[Number(s) - 1])
      ? indices.map((s) => q.options[Number(s) - 1].label)
      : [raw];
    const draft = drafts.get(id);
    if (!draft) return true;
    const { validateAnswer } = await import('../user-input.js');
    try {
      validateAnswer({ questions: [q] }, { answers: { [q.id]: answer } });
      draft[q.id] = answer;
      if (request.questions.every((question) => draft[question.id]))
        answerUserInput(id, scope, interaction.user.id, { answers: draft });
      await interaction.reply({
        content: '回答を受け付けました。残りの質問があれば回答してください。',
        ephemeral: true,
      });
    } catch (e) {
      await interaction.reply({ content: String(e), ephemeral: true });
    }
  }
  return true;
}
