import { describe, it, expect } from 'vitest';
import {
  toolCallSignature,
  countTrailingRepeats,
  recordToolCallAndCheckLoop,
} from '../src/local-llm/runner.js';

describe('toolCallSignature', () => {
  it('同じ name + args は同じシグネチャ', () => {
    const a = toolCallSignature('tool_search', { query: 'arxiv' });
    const b = toolCallSignature('tool_search', { query: 'arxiv' });
    expect(a).toBe(b);
  });

  it('args のキー順が違っても同じシグネチャ', () => {
    const a = toolCallSignature('exec', { command: 'ls', cwd: '/tmp' });
    const b = toolCallSignature('exec', { cwd: '/tmp', command: 'ls' });
    expect(a).toBe(b);
  });

  it('name が違えば別シグネチャ', () => {
    const a = toolCallSignature('read', { path: 'x' });
    const b = toolCallSignature('write', { path: 'x' });
    expect(a).not.toBe(b);
  });

  it('args の値が違えば別シグネチャ', () => {
    const a = toolCallSignature('tool_search', { query: 'arxiv' });
    const b = toolCallSignature('tool_search', { query: 'github' });
    expect(a).not.toBe(b);
  });

  it('args が null / undefined でも安定', () => {
    expect(toolCallSignature('noop', null)).toBe(toolCallSignature('noop', undefined));
  });

  it('args が配列でも JSON 化される', () => {
    const a = toolCallSignature('multi', [1, 2, 3]);
    const b = toolCallSignature('multi', [1, 2, 3]);
    expect(a).toBe(b);
    expect(a).not.toBe(toolCallSignature('multi', [3, 2, 1]));
  });
});

describe('countTrailingRepeats', () => {
  it('末尾の連続回数を数える', () => {
    expect(countTrailingRepeats(['a', 'b', 'b', 'b'], 'b')).toBe(3);
  });

  it('末尾と target が違うなら 0', () => {
    expect(countTrailingRepeats(['a', 'b', 'b', 'b'], 'a')).toBe(0);
  });

  it('空配列なら 0', () => {
    expect(countTrailingRepeats([], 'x')).toBe(0);
  });

  it('全部 target なら length', () => {
    expect(countTrailingRepeats(['x', 'x', 'x'], 'x')).toBe(3);
  });

  it('間に違う要素があれば後ろ側だけ数える', () => {
    expect(countTrailingRepeats(['b', 'a', 'b', 'b'], 'b')).toBe(2);
  });
});

describe('recordToolCallAndCheckLoop', () => {
  type S = Parameters<typeof recordToolCallAndCheckLoop>[0];
  const newSession = (): S => ({
    messages: [],
    updatedAt: 0,
    activeToolNames: new Set(),
    recentToolCallSigs: [],
  });

  it('1 回目はループ判定にならない', () => {
    const s = newSession();
    expect(recordToolCallAndCheckLoop(s, 'X')).toBe(false);
    expect(s.recentToolCallSigs).toEqual(['X']);
  });

  it('2 回目連続もループにならない (THRESHOLD=3)', () => {
    const s = newSession();
    recordToolCallAndCheckLoop(s, 'X');
    expect(recordToolCallAndCheckLoop(s, 'X')).toBe(false);
  });

  it('3 回目連続でループ判定 true', () => {
    const s = newSession();
    recordToolCallAndCheckLoop(s, 'X');
    recordToolCallAndCheckLoop(s, 'X');
    expect(recordToolCallAndCheckLoop(s, 'X')).toBe(true);
  });

  it('間に別シグネチャが挟まればカウントリセット', () => {
    const s = newSession();
    recordToolCallAndCheckLoop(s, 'X');
    recordToolCallAndCheckLoop(s, 'X');
    recordToolCallAndCheckLoop(s, 'Y'); // リセット
    expect(recordToolCallAndCheckLoop(s, 'X')).toBe(false); // X 連続は 1 回
  });

  it('バッファは 8 件で push 押し出し', () => {
    const s = newSession();
    for (let i = 0; i < 10; i++) recordToolCallAndCheckLoop(s, `sig_${i}`);
    expect(s.recentToolCallSigs.length).toBe(8);
    expect(s.recentToolCallSigs[0]).toBe('sig_2');
    expect(s.recentToolCallSigs[7]).toBe('sig_9');
  });
});
