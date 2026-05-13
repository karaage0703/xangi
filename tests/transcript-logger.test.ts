import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  logPrompt,
  logResponse,
  readSessionMessages,
  updateMessageContent,
  deleteMessage,
  attachPlatformMessageIdToLast,
  findEntryByPlatformMessageId,
} from '../src/transcript-logger.js';

describe('transcript-logger edit/delete', () => {
  let workdir: string;
  const sessionId = 'test-session';

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('updateMessageContent updates content and sets edited flag', () => {
    logPrompt(workdir, sessionId, 'original message');
    const before = readSessionMessages(workdir, sessionId);
    expect(before).toHaveLength(1);
    expect(before[0].content).toBe('original message');
    expect(before[0].edited).toBeUndefined();

    const updated = updateMessageContent(workdir, sessionId, before[0].id, 'edited message');
    expect(updated).not.toBeNull();
    expect(updated?.content).toBe('edited message');
    expect(updated?.edited).toBe(true);
    expect(updated?.editedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = readSessionMessages(workdir, sessionId);
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe('edited message');
    expect(after[0].edited).toBe(true);
  });

  it('updateMessageContent returns null for unknown id', () => {
    logPrompt(workdir, sessionId, 'foo');
    const result = updateMessageContent(workdir, sessionId, 'no-such-id', 'bar');
    expect(result).toBeNull();
    const after = readSessionMessages(workdir, sessionId);
    expect(after[0].content).toBe('foo'); // unchanged
  });

  it('deleteMessage removes the matching entry and keeps order of others', () => {
    logPrompt(workdir, sessionId, 'first');
    logResponse(workdir, sessionId, { result: 'second' });
    logPrompt(workdir, sessionId, 'third');

    const before = readSessionMessages(workdir, sessionId);
    expect(before).toHaveLength(3);
    const targetId = before[1].id;

    const ok = deleteMessage(workdir, sessionId, targetId);
    expect(ok).toBe(true);

    const after = readSessionMessages(workdir, sessionId);
    expect(after).toHaveLength(2);
    expect(after[0].content).toBe('first');
    expect(after[1].content).toBe('third');
  });

  it('deleteMessage returns false for unknown id', () => {
    logPrompt(workdir, sessionId, 'only');
    const ok = deleteMessage(workdir, sessionId, 'no-such-id');
    expect(ok).toBe(false);
    const after = readSessionMessages(workdir, sessionId);
    expect(after).toHaveLength(1);
  });

  it('rewriting jsonl preserves trailing newline', () => {
    logPrompt(workdir, sessionId, 'foo');
    const entries = readSessionMessages(workdir, sessionId);
    updateMessageContent(workdir, sessionId, entries[0].id, 'foo2');
    const filePath = join(workdir, 'logs', 'sessions', `${sessionId}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('attachPlatformMessageIdToLast attaches Discord message id to last user entry', () => {
    logPrompt(workdir, sessionId, 'hello');
    logResponse(workdir, sessionId, { result: 'hi' });
    logPrompt(workdir, sessionId, 'second user msg');

    const attached = attachPlatformMessageIdToLast(
      workdir,
      sessionId,
      'user',
      'discord-snowflake-123'
    );
    expect(attached).not.toBeNull();
    expect(attached?.platformMessageId).toBe('discord-snowflake-123');
    expect(attached?.content).toBe('second user msg'); // 最後の user

    const found = findEntryByPlatformMessageId(workdir, sessionId, 'discord-snowflake-123');
    expect(found?.id).toBe(attached?.id);
  });

  it('attachPlatformMessageIdToLast returns null when no matching role', () => {
    logPrompt(workdir, sessionId, 'only user');
    const result = attachPlatformMessageIdToLast(workdir, sessionId, 'assistant', 'mid-1');
    expect(result).toBeNull();
  });

  it('findEntryByPlatformMessageId returns null for unknown id', () => {
    logPrompt(workdir, sessionId, 'a');
    const found = findEntryByPlatformMessageId(workdir, sessionId, 'nope');
    expect(found).toBeNull();
  });

  it('Discord edit flow: attach → findByPlatformMessageId → updateMessageContent', () => {
    logPrompt(workdir, sessionId, 'original');
    attachPlatformMessageIdToLast(workdir, sessionId, 'user', 'dmid-99');

    const entry = findEntryByPlatformMessageId(workdir, sessionId, 'dmid-99');
    expect(entry).not.toBeNull();

    const updated = updateMessageContent(workdir, sessionId, entry!.id, 'edited via discord');
    expect(updated?.content).toBe('edited via discord');
    expect(updated?.edited).toBe(true);
    expect(updated?.platformMessageId).toBe('dmid-99'); // 属性は維持される

    const reFound = findEntryByPlatformMessageId(workdir, sessionId, 'dmid-99');
    expect(reFound?.id).toBe(entry!.id);
    expect(reFound?.content).toBe('edited via discord');
  });

  it('Discord delete flow: attach → findByPlatformMessageId → deleteMessage', () => {
    logPrompt(workdir, sessionId, 'will be deleted');
    attachPlatformMessageIdToLast(workdir, sessionId, 'user', 'dmid-del');

    const entry = findEntryByPlatformMessageId(workdir, sessionId, 'dmid-del');
    expect(entry).not.toBeNull();

    const ok = deleteMessage(workdir, sessionId, entry!.id);
    expect(ok).toBe(true);

    const reFound = findEntryByPlatformMessageId(workdir, sessionId, 'dmid-del');
    expect(reFound).toBeNull();

    const all = readSessionMessages(workdir, sessionId);
    expect(all).toHaveLength(0);
  });
});
