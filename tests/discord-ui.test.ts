import { describe, expect, it } from 'vitest';
import {
  createCompletedButtons,
  createDiscordHistoryCustomId,
  parseDiscordHistoryCustomId,
  createReplySuggestionButtons,
} from '../src/discord/ui.js';
import { respondWithDiscordTurnHistory } from '../src/discord/slash-commands.js';

function customIds(options?: {
  showTools?: boolean;
  showLeave?: boolean;
  showReplySuggestions?: boolean;
}): string[] {
  return createCompletedButtons(options).components.map((button) => button.data.custom_id ?? '');
}

describe('createCompletedButtons', () => {
  it('shows Close only for thread responses', () => {
    expect(customIds()).toEqual(['xangi_new']);
    expect(customIds({ showTools: true })).toEqual(['xangi_new', 'xangi_tools']);
    expect(customIds({ showLeave: true })).toEqual(['xangi_thread_leave']);
  });

  it('puts Close first and omits New for thread responses', () => {
    const row = createCompletedButtons({
      showTools: true,
      showLeave: true,
      showReplySuggestions: true,
    });
    expect(row.components.map((button) => button.data.custom_id ?? '')).toEqual([
      'xangi_thread_leave',
      'xangi_tools',
      'xangi_reply_suggestions',
    ]);
    expect(row.components[0]?.data.label).toBe('Close');
    expect(row.components[1]?.data.label).toBe('History');
  });

  it('embeds the persisted turn reference in a History button', () => {
    const context = { threadId: 'discord:123', turnId: 'discord-msg-456' };
    const customId = createDiscordHistoryCustomId(context);
    expect(customId).toBe('xangi_tools|discord:123|discord-msg-456');
    expect(parseDiscordHistoryCustomId(customId)).toEqual(context);
  });

  it('acknowledges History before loading and formatting it', async () => {
    const calls: string[] = [];
    const interaction = {
      deferReply: async () => {
        calls.push('defer');
      },
      editReply: async () => {
        calls.push('edit');
      },
      followUp: async () => {
        calls.push('followUp');
      },
    };
    await respondWithDiscordTurnHistory(interaction as never, () => {
      calls.push('load');
      return [{ kind: 'text', at: 1, turnId: 'discord-msg-456', text: '途中コメント' }];
    });
    expect(calls).toEqual(['defer', 'load', 'edit']);
  });
});

describe('createReplySuggestionButtons', () => {
  it('uses numbered labels in a separate row', () => {
    const buttons = createReplySuggestionButtons('123', 3).components;
    expect(buttons.map((button) => button.data.label)).toEqual(['1', '2', '3']);
    expect(buttons.map((button) => button.data.custom_id)).toEqual([
      'xangi_reply_suggestion_123_0',
      'xangi_reply_suggestion_123_1',
      'xangi_reply_suggestion_123_2',
    ]);
  });
});
