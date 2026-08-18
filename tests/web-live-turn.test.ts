import { describe, expect, it } from 'vitest';

import {
  applyPublishedLiveEvent,
  decideStreamRecovery,
  isPaneProcessing,
  liveThreadId,
  selectLiveTurn,
  syncObservedLiveTurn,
} from '../web-ui/src/liveTurn.js';

describe('Web Chat live turn', () => {
  it('keeps a reopened pane in processing state while the server session is active', () => {
    expect(isPaneProcessing(false, true)).toBe(true);
    expect(isPaneProcessing(false, false)).toBe(false);
    expect(isPaneProcessing(true, false)).toBe(true);
  });

  it('maps Web and external sessions to their event thread IDs', () => {
    expect(liveThreadId({ id: 'web-1', platform: 'web', contextKey: 'ctx-web' })).toBe(
      'web:web-1'
    );
    expect(liveThreadId({ id: 'discord-session', platform: 'discord', contextKey: '123' })).toBe(
      'discord:123'
    );
  });

  it('uses activity previews until a full message delta arrives', () => {
    const activity = {
      state: 'streaming',
      summary: '応答中',
      active: true,
      turnId: 'turn-1',
      textPreview: '途中',
      toolLines: ['Bash: npm test'],
      startedAt: 1000,
    };
    const preview = syncObservedLiveTurn(undefined, activity);
    expect(
      selectLiveTurn({
        localBusy: false,
        localText: '',
        localToolLines: [],
        activity,
        observed: preview,
      })
    ).toMatchObject({
      visible: true,
      text: '途中',
      toolLines: ['Bash: npm test'],
      statusLabel: '応答中',
    });

    const streamed = applyPublishedLiveEvent(preview, {
      type: 'message.delta',
      turn_id: 'turn-1',
      full_text: '途中の応答全文',
    });
    expect(
      selectLiveTurn({
        localBusy: false,
        localText: '',
        localToolLines: [],
        activity,
        observed: streamed,
      }).text
    ).toBe('途中の応答全文');
  });

  it('keeps the direct Web request stream authoritative to avoid duplicate output', () => {
    expect(
      selectLiveTurn({
        localBusy: true,
        localText: 'Webから送った応答',
        localToolLines: ['Read'],
        activity: {
          state: 'streaming',
          summary: '応答中',
          active: true,
          turnId: 'turn-1',
          textPreview: 'observer側の応答',
          toolLines: ['Bash'],
        },
        observed: { turnId: 'turn-1', text: 'observer全文', fromEvent: true },
      })
    ).toEqual({
      visible: true,
      text: 'Webから送った応答',
      toolLines: ['Read'],
      statusLabel: '処理中',
    });
  });

  it('hides reply suggestion markup from observed full-text events', () => {
    expect(
      applyPublishedLiveEvent(undefined, {
        type: 'message.delta',
        turn_id: 'turn-1',
        full_text: '回答です。\n<xangi_reply_suggestions>["次へ"]',
      })?.text
    ).toBe('回答です。');
  });

  it('drops observer output after the activity becomes inactive', () => {
    expect(
      syncObservedLiveTurn(
        { turnId: 'turn-1', text: '完了前', fromEvent: true },
        { state: 'complete', summary: '完了', active: false, turnId: 'turn-1' }
      )
    ).toBeUndefined();
  });

  it('recovers a disconnected request from a newly persisted assistant response', () => {
    expect(
      decideStreamRecovery(
        { errorMessage: 'Load failed', previousAssistantId: 'assistant-old' },
        {
          isActive: false,
          messages: [
            { id: 'assistant-old', role: 'assistant' },
            { id: 'user-new', role: 'user' },
            { id: 'assistant-new', role: 'assistant' },
          ],
        }
      )
    ).toBe('recovered');
  });

  it('observes the server turn after the direct response stream disconnects', () => {
    expect(
      decideStreamRecovery(
        { errorMessage: 'Load failed', previousAssistantId: 'assistant-old' },
        {
          isActive: true,
          messages: [
            { id: 'assistant-old', role: 'assistant' },
            { id: 'user-new', role: 'user' },
          ],
        }
      )
    ).toBe('observing');
  });

  it('keeps a real transport error when the server has neither activity nor a result', () => {
    expect(
      decideStreamRecovery(
        { errorMessage: 'Load failed', previousAssistantId: 'assistant-old' },
        {
          isActive: false,
          messages: [
            { id: 'assistant-old', role: 'assistant' },
            { id: 'user-new', role: 'user' },
          ],
        }
      )
    ).toBe('failed');
  });
});
