import { describe, expect, it } from 'vitest';
import {
  appendScheduleRunCompletion,
  createSchedulerRunId,
  formatScheduleRunDuration,
  isSchedulerRunId,
} from '../src/scheduler-run.js';

describe('scheduler run ids', () => {
  it('creates identifiable stateless run ids', () => {
    const id = createSchedulerRunId('discord', 1783929000000);
    expect(id).toMatch(/^scheduler-run-discord-1783929000000-[a-f0-9]{8}$/);
    expect(isSchedulerRunId(id)).toBe(true);
  });

  it('recognizes legacy scheduler transcript ids without hiding normal sessions', () => {
    expect(isSchedulerRunId('0mp9jvas3_b78f9618-1783929000000')).toBe(true);
    expect(isSchedulerRunId('0mp9jvas3_b78f9618')).toBe(false);
  });
});

describe('scheduled task duration', () => {
  it.each([
    [0, '1秒未満'],
    [999, '1秒未満'],
    [1_000, '1秒'],
    [61_000, '1分1秒'],
    [3_661_000, '1時間1分1秒'],
  ])('%dmsを%sとして表示する', (elapsedMs, expected) => {
    expect(formatScheduleRunDuration(elapsedMs)).toBe(expected);
  });

  it('結果本文の末尾へ所要時間を追加する', () => {
    expect(
      appendScheduleRunCompletion(
        '結果\n',
        83_000,
        { showElapsed: true }
      )
    ).toBe('結果\n\n✅ 完了（⏱ 1分23秒）');
  });
});
