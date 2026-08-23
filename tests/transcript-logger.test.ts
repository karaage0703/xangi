import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  logPrompt,
  logResponse,
  logError,
  readSessionMessages,
  readSessionMessagesTail,
  updateMessageContent,
  updateLatestMessageUsage,
  deleteMessage,
  attachPlatformMessageIdToLast,
  ensureVisibleAssistantResponse,
  findEntryByPlatformMessageId,
  initTranscriptStorage,
  resetTranscriptStorageForTests,
  deleteSessionTranscript,
  getSessionLogPathForRead,
} from '../src/transcript-logger.js';

describe('transcript-logger edit/delete', () => {
  let workdir: string;
  const sessionId = 'test-session';

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
  });

  afterEach(() => {
    resetTranscriptStorageForTests();
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

  it('updateLatestMessageUsage adds automatic metrics without marking the message edited', () => {
    logPrompt(workdir, sessionId, 'run scheduled task');
    logError(workdir, sessionId, 'failed');

    const updated = updateLatestMessageUsage(workdir, sessionId, ['assistant', 'error'], {
      duration_ms: 12_345,
    });

    expect(updated).toMatchObject({
      role: 'error',
      content: 'failed',
      usage: { duration_ms: 12_345 },
    });
    expect(updated?.edited).toBeUndefined();
    expect(readSessionMessages(workdir, sessionId).at(-1)).toMatchObject({
      usage: { duration_ms: 12_345 },
    });
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

  it('readSessionMessagesTail reads only the requested trailing entries', () => {
    for (let index = 0; index < 70; index++) {
      logPrompt(workdir, sessionId, `${index}:${'x'.repeat(2000)}`);
    }

    const tail = readSessionMessagesTail(workdir, sessionId, 50);
    expect(tail).toHaveLength(50);
    expect(String(tail[0]?.content).startsWith('20:')).toBe(true);
    expect(String(tail.at(-1)?.content).startsWith('69:')).toBe(true);
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

  it('stores a platform-visible assistant response when the last user turn is unfinished', () => {
    logPrompt(workdir, sessionId, 'restart now');

    const stored = ensureVisibleAssistantResponse(
      workdir,
      sessionId,
      'discord-reply-1',
      '⏸ プロセス再起動により中断されました',
      '2026-07-31T04:00:00.000Z'
    );

    expect(stored).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: { result: '⏸ プロセス再起動により中断されました' },
        createdAt: '2026-07-31T04:00:00.000Z',
        platformMessageId: 'discord-reply-1',
      })
    );
    expect(readSessionMessages(workdir, sessionId)).toHaveLength(2);
  });

  it('keeps an existing runner response and only attaches the platform message id', () => {
    logPrompt(workdir, sessionId, 'restart after finishing');
    logResponse(workdir, sessionId, { result: 'finished answer' });

    const stored = ensureVisibleAssistantResponse(
      workdir,
      sessionId,
      'discord-reply-2',
      '⏸ プロセス再起動により中断されました'
    );

    expect(stored?.content).toEqual({ result: 'finished answer' });
    expect(stored?.platformMessageId).toBe('discord-reply-2');
    expect(readSessionMessages(workdir, sessionId)).toHaveLength(2);
  });

  it('does not duplicate a platform-visible response on repeated finalization', () => {
    logPrompt(workdir, sessionId, 'restart once');
    ensureVisibleAssistantResponse(workdir, sessionId, 'discord-reply-3', 'interrupted');
    ensureVisibleAssistantResponse(workdir, sessionId, 'discord-reply-3', 'interrupted');

    expect(readSessionMessages(workdir, sessionId)).toHaveLength(2);
  });

  it('stores an interrupted Web response without a platform message id', () => {
    logPrompt(workdir, sessionId, 'restart from Web');

    const stored = ensureVisibleAssistantResponse(
      workdir,
      sessionId,
      undefined,
      '⏸ プロセス再起動により中断されました'
    );

    expect(stored).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: { result: '⏸ プロセス再起動により中断されました' },
      })
    );
    expect(stored?.platformMessageId).toBeUndefined();
    expect(readSessionMessages(workdir, sessionId)).toHaveLength(2);
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

  it('writes new transcripts under DATA_DIR instead of the selected workspace', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'transcript-data-'));
    const selectedWorkspace = mkdtempSync(join(tmpdir(), 'transcript-workspace-'));
    try {
      initTranscriptStorage(dataDir, workdir);
      logPrompt(selectedWorkspace, sessionId, 'central');

      expect(existsSync(join(dataDir, 'logs', 'sessions', `${sessionId}.jsonl`))).toBe(true);
      expect(existsSync(join(selectedWorkspace, 'logs', 'sessions', `${sessionId}.jsonl`))).toBe(
        false
      );
      expect(readSessionMessages(selectedWorkspace, sessionId)[0]?.content).toBe('central');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(selectedWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects path separators in transcript session IDs', () => {
    expect(() => getSessionLogPathForRead(workdir, '../../victim')).toThrow(
      /Invalid transcript session ID/
    );
    expect(() => getSessionLogPathForRead(workdir, '..\\..\\victim')).toThrow(
      /Invalid transcript session ID/
    );
  });

  it('falls back to a legacy startup-workdir transcript when DATA_DIR has no copy', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'transcript-data-'));
    const legacyDir = join(workdir, 'logs', 'sessions');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        id: 'legacy-message',
        role: 'user',
        content: 'legacy',
        createdAt: '2026-07-30T00:00:00.000Z',
      })}\n`
    );
    try {
      initTranscriptStorage(dataDir, workdir);
      expect(readSessionMessages('/another/workspace', sessionId)[0]?.content).toBe('legacy');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('copies legacy history before the first central append', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'transcript-data-'));
    const legacyDir = join(workdir, 'logs', 'sessions');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        id: 'legacy-message',
        role: 'user',
        content: 'legacy',
        createdAt: '2026-07-30T00:00:00.000Z',
      })}\n`
    );
    try {
      initTranscriptStorage(dataDir, workdir);
      logPrompt('/selected/workspace', sessionId, 'new message');

      const centralPath = join(dataDir, 'logs', 'sessions', `${sessionId}.jsonl`);
      expect(existsSync(centralPath)).toBe(true);
      expect(
        readSessionMessages('/selected/workspace', sessionId).map((entry) => entry.content)
      ).toEqual(['legacy', 'new message']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('deletes both central and legacy transcript copies', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'transcript-data-'));
    const legacyDir = join(workdir, 'logs', 'sessions');
    const centralDir = join(dataDir, 'logs', 'sessions');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(centralDir, { recursive: true });
    const legacyPath = join(legacyDir, `${sessionId}.jsonl`);
    const centralPath = join(centralDir, `${sessionId}.jsonl`);
    writeFileSync(legacyPath, 'legacy\n');
    writeFileSync(centralPath, 'central\n');
    try {
      initTranscriptStorage(dataDir, workdir);
      expect(deleteSessionTranscript('/selected/workspace', sessionId)).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(centralPath)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
