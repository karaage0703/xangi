import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendMessage,
  readAll,
  readFile,
  compactSelf,
  deleteMessageById,
  clearSelf,
  listInstanceFiles,
  instanceIdFromFile,
  selfPath,
  ensureDir,
} from '../src/inter-instance-chat/jsonl-store.js';
import { startWatcher } from '../src/inter-instance-chat/watcher.js';
import {
  _resetInterChatConfigForTest,
  extractMentions,
  isMentioned,
} from '../src/inter-instance-chat/index.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'xangi-chat-test-'));
}

describe('jsonl-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appendMessage が自分の jsonl にだけ追記する', () => {
    const m1 = appendMessage(dir, 'borot', 'hello');
    const m2 = appendMessage(dir, 'borot', 'world');
    const files = listInstanceFiles(dir);
    expect(files.length).toBe(1);
    expect(instanceIdFromFile(files[0])).toBe('borot');
    const lines = readFileSync(selfPath(dir, 'borot'), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).text).toBe('hello');
    expect(JSON.parse(lines[1]).text).toBe('world');
    expect(m1.from).toBe('borot');
    expect(m2.msg_id).not.toBe(m1.msg_id);
  });

  it('別インスタンスは別ファイルに書き込む', () => {
    appendMessage(dir, 'borot', 'a');
    appendMessage(dir, 'petbot', 'b');
    const files = listInstanceFiles(dir).map(instanceIdFromFile).sort();
    expect(files).toEqual(['borot', 'petbot']);
  });

  it('readAll は ts 昇順でメッセージを返す', () => {
    appendMessage(dir, 'borot', 'first', { ts: 100 });
    appendMessage(dir, 'petbot', 'second', { ts: 200 });
    appendMessage(dir, 'borot', 'third', { ts: 150 });
    const all = readAll(dir, 0, 1000);
    expect(all.map((m) => m.text)).toEqual(['first', 'third', 'second']);
  });

  it('readAll は TTL 外を弾く', () => {
    appendMessage(dir, 'borot', 'old', { ts: 100 });
    appendMessage(dir, 'borot', 'recent', { ts: 990 });
    const all = readAll(dir, 60, 1000); // now=1000, ttl=60 → ts >= 940 のみ
    expect(all.map((m) => m.text)).toEqual(['recent']);
  });

  it('compactSelf は TTL 外を物理削除する', () => {
    appendMessage(dir, 'borot', 'old', { ts: 100 });
    appendMessage(dir, 'borot', 'recent', { ts: 990 });
    const result = compactSelf(dir, 'borot', 60, 1000);
    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
    const remaining = readFile(selfPath(dir, 'borot'));
    expect(remaining.map((m) => m.text)).toEqual(['recent']);
  });

  it('readFile は壊れた行をスキップする', () => {
    const path = selfPath(dir, 'borot');
    ensureDir(dir);
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: 1, from: 'borot', text: 'ok', origin_chain: [], msg_id: 'a' }),
        '{ broken json',
        '',
        JSON.stringify({ ts: 2, from: 'borot', text: 'ok2', origin_chain: [], msg_id: 'b' }),
      ].join('\n')
    );
    const messages = readFile(path);
    expect(messages.length).toBe(2);
    expect(messages[0].text).toBe('ok');
    expect(messages[1].text).toBe('ok2');
  });

  it('appendMessage は msg_id を上書きできる（テスト用）', () => {
    const m = appendMessage(dir, 'borot', 'x', { msg_id: 'fixed-id' });
    expect(m.msg_id).toBe('fixed-id');
  });

  it('appendMessage の origin_chain がデフォで [user]', () => {
    const m = appendMessage(dir, 'borot', 'x');
    expect(m.origin_chain).toEqual(['user']);
  });

  it('deleteMessageById で自分の特定行を削除できる', () => {
    appendMessage(dir, 'borot', 'a', { msg_id: 'id-a' });
    appendMessage(dir, 'borot', 'b', { msg_id: 'id-b' });
    appendMessage(dir, 'borot', 'c', { msg_id: 'id-c' });
    const removed = deleteMessageById(dir, 'borot', 'id-b');
    expect(removed).toBe(1);
    const remaining = readFile(selfPath(dir, 'borot'));
    expect(remaining.map((m) => m.text)).toEqual(['a', 'c']);
  });

  it('deleteMessageById は存在しない msg_id で 0 を返す', () => {
    appendMessage(dir, 'borot', 'a');
    const removed = deleteMessageById(dir, 'borot', 'nonexistent');
    expect(removed).toBe(0);
  });

  it('deleteMessageById は他インスタンスのファイルに触れない', () => {
    appendMessage(dir, 'borot', 'mine', { msg_id: 'mine-1' });
    appendMessage(dir, 'petbot', 'theirs', { msg_id: 'theirs-1' });
    // borot から theirs-1 を消そうとしても 0 件削除（borot 自身のファイルにはないので）
    const removed = deleteMessageById(dir, 'borot', 'theirs-1');
    expect(removed).toBe(0);
    // petbot のファイルは無傷
    const petbotMsgs = readFile(selfPath(dir, 'petbot'));
    expect(petbotMsgs.map((m) => m.text)).toEqual(['theirs']);
  });

  it('deleteMessageById はファイルが存在しなくても落ちない', () => {
    const removed = deleteMessageById(dir, 'never-existed', 'any-id');
    expect(removed).toBe(0);
  });

  it('clearSelf で自分の jsonl を空にする', () => {
    appendMessage(dir, 'borot', 'a');
    appendMessage(dir, 'borot', 'b');
    appendMessage(dir, 'borot', 'c');
    const removed = clearSelf(dir, 'borot');
    expect(removed).toBe(3);
    const remaining = readFile(selfPath(dir, 'borot'));
    expect(remaining).toEqual([]);
  });

  it('clearSelf は他インスタンスのファイルに触れない', () => {
    appendMessage(dir, 'borot', 'mine');
    appendMessage(dir, 'petbot', 'theirs');
    clearSelf(dir, 'borot');
    const petbotMsgs = readFile(selfPath(dir, 'petbot'));
    expect(petbotMsgs.map((m) => m.text)).toEqual(['theirs']);
  });

  it('clearSelf はファイルが存在しなくても 0 を返す', () => {
    const removed = clearSelf(dir, 'never-existed');
    expect(removed).toBe(0);
  });

  it('clearSelf は空ファイルで 0 を返す', () => {
    appendMessage(dir, 'borot', 'a');
    clearSelf(dir, 'borot');
    // 2回目（既に空）
    const removed = clearSelf(dir, 'borot');
    expect(removed).toBe(0);
  });
});

describe('watcher', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('他インスタンスからの新規追記を検出する (polling mode)', async () => {
    const received: Array<{ from: string; text: string }> = [];
    const watcher = startWatcher({
      dir,
      selfInstanceId: 'borot',
      ttlSec: 0,
      usePolling: true,
      pollIntervalMs: 50,
      seedInitial: false,
      onMessage: (msg, fromInstanceId) => {
        received.push({ from: fromInstanceId, text: msg.text });
      },
    });
    try {
      // 最初は空
      expect(received.length).toBe(0);
      // 別インスタンスから2件追記
      appendMessage(dir, 'petbot', 'hello', { ts: Math.floor(Date.now() / 1000) });
      appendMessage(dir, 'petbot', 'world', { ts: Math.floor(Date.now() / 1000) });
      // polling timer が回るまで少し待つ
      await new Promise((r) => setTimeout(r, 200));
      expect(received.length).toBe(2);
      expect(received[0]).toEqual({ from: 'petbot', text: 'hello' });
      expect(received[1]).toEqual({ from: 'petbot', text: 'world' });
    } finally {
      watcher.stop();
    }
  });

  it('自分のメッセージは emit しない', async () => {
    const received: Array<{ from: string; text: string }> = [];
    const watcher = startWatcher({
      dir,
      selfInstanceId: 'borot',
      ttlSec: 0,
      usePolling: true,
      pollIntervalMs: 50,
      seedInitial: false,
      onMessage: (msg, fromInstanceId) => {
        received.push({ from: fromInstanceId, text: msg.text });
      },
    });
    try {
      appendMessage(dir, 'borot', 'self message', { ts: Math.floor(Date.now() / 1000) });
      await new Promise((r) => setTimeout(r, 200));
      expect(received.length).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  it('seedInitial=true で起動時の既存メッセージを emit する', async () => {
    appendMessage(dir, 'petbot', 'before-watch', { ts: Math.floor(Date.now() / 1000) });
    const received: string[] = [];
    const watcher = startWatcher({
      dir,
      selfInstanceId: 'borot',
      ttlSec: 0,
      usePolling: true,
      pollIntervalMs: 50,
      seedInitial: true,
      onMessage: (msg) => received.push(msg.text),
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toContain('before-watch');
    } finally {
      watcher.stop();
    }
  });

  it('TTL 外のメッセージは emit しない', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200; // 2時間前
    appendMessage(dir, 'petbot', 'old', { ts: past });
    const received: string[] = [];
    const watcher = startWatcher({
      dir,
      selfInstanceId: 'borot',
      ttlSec: 60,
      usePolling: true,
      pollIntervalMs: 50,
      seedInitial: true,
      onMessage: (msg) => received.push(msg.text),
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(received.length).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  it('msg_id 重複は1度しか emit しない', async () => {
    const received: string[] = [];
    const watcher = startWatcher({
      dir,
      selfInstanceId: 'borot',
      ttlSec: 0,
      usePolling: true,
      pollIntervalMs: 50,
      seedInitial: false,
      onMessage: (msg) => received.push(msg.msg_id),
    });
    try {
      appendMessage(dir, 'petbot', 'x', { msg_id: 'dup-1', ts: Math.floor(Date.now() / 1000) });
      await new Promise((r) => setTimeout(r, 100));
      // 同じ msg_id でもう1回追記（実運用では起きないがテストとして）
      appendMessage(dir, 'petbot', 'x', { msg_id: 'dup-1', ts: Math.floor(Date.now() / 1000) });
      await new Promise((r) => setTimeout(r, 200));
      const dupCount = received.filter((id) => id === 'dup-1').length;
      expect(dupCount).toBe(1);
    } finally {
      watcher.stop();
    }
  });
});

describe('flowFromHostPlatform', () => {
  let dir: string;
  let originalEnabled: string | undefined;

  beforeEach(() => {
    dir = createTmpDir();
    originalEnabled = process.env.INTER_INSTANCE_CHAT_ENABLED;
    process.env.INTER_INSTANCE_CHAT_ENABLED = 'true';
    process.env.INTER_INSTANCE_CHAT_DIR = dir;
    process.env.XANGI_INSTANCE_ID = 'borot';
    process.env.XANGI_INSTANCE_LABEL = 'borot';
    _resetInterChatConfigForTest();
  });

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.INTER_INSTANCE_CHAT_ENABLED;
    } else {
      process.env.INTER_INSTANCE_CHAT_ENABLED = originalEnabled;
    }
    delete process.env.INTER_INSTANCE_CHAT_DIR;
    delete process.env.XANGI_INSTANCE_ID;
    delete process.env.XANGI_INSTANCE_LABEL;
    _resetInterChatConfigForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('user 発言は origin_chain=[user] で append される', async () => {
    const { flowFromHostPlatform } = await import('../src/inter-instance-chat/index.js');
    const m = flowFromHostPlatform('hello', 'user');
    expect(m).not.toBeNull();
    expect(m?.from).toBe('borot');
    expect(m?.from_label).toBe('borot (user)');
    expect(m?.origin_chain).toEqual(['user']);
  });

  it('agent 発言は origin_chain=[user, self] で append される', async () => {
    const { flowFromHostPlatform } = await import('../src/inter-instance-chat/index.js');
    const m = flowFromHostPlatform('I will help', 'agent');
    expect(m).not.toBeNull();
    expect(m?.from_label).toBe('borot (agent)');
    expect(m?.origin_chain).toEqual(['user', 'borot']);
  });

  it('enabled=false なら何もしない', async () => {
    process.env.INTER_INSTANCE_CHAT_ENABLED = 'false';
    _resetInterChatConfigForTest();
    const { flowFromHostPlatform } = await import('../src/inter-instance-chat/index.js');
    const m = flowFromHostPlatform('ignored', 'user');
    expect(m).toBeNull();
  });

  it('空テキストは無視', async () => {
    const { flowFromHostPlatform } = await import('../src/inter-instance-chat/index.js');
    expect(flowFromHostPlatform('', 'user')).toBeNull();
    expect(flowFromHostPlatform('   ', 'agent')).toBeNull();
  });
});

describe('sessions autoTalk', () => {
  it('setAutoTalk と listAutoTalkSessions が連動', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xangi-sessions-test-'));
    try {
      const { initSessions, createWebSession, setAutoTalk, listAutoTalkSessions, clearSessions } =
        await import('../src/sessions.js');
      clearSessions();
      initSessions(tmpDir);
      const a = createWebSession({ title: 'A' });
      const b = createWebSession({ title: 'B' });
      const c = createWebSession({ title: 'C' });
      expect(setAutoTalk(a, true)).toBe(true);
      expect(setAutoTalk(c, true)).toBe(true);
      const list = listAutoTalkSessions()
        .map((s) => s.id)
        .sort();
      expect(list).toEqual([a, c].sort());
      // toggle off
      setAutoTalk(a, false);
      expect(listAutoTalkSessions().map((s) => s.id)).toEqual([c]);
      // 存在しないIDは false
      expect(setAutoTalk('non-existent', true)).toBe(false);
      clearSessions();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('mentions', () => {
  it('extractMentions は @id を抽出する', () => {
    expect(extractMentions('@borot おはよう')).toEqual(['borot']);
    expect(extractMentions('hi @borot and @petbot, how are you')).toEqual(['borot', 'petbot']);
    expect(extractMentions('no mentions here')).toEqual([]);
    expect(extractMentions('email@example.com is not a mention')).toEqual([]);
  });

  it('isMentioned は selfId / selfLabel どちらでもヒットする', () => {
    expect(isMentioned('@borot hello', 'borot')).toBe(true);
    expect(isMentioned('@petbot hello', 'borot')).toBe(false);
    expect(isMentioned('@borot-label hello', 'borot-id', 'borot-label')).toBe(true);
  });
});

describe('config resolution', () => {
  beforeEach(() => {
    _resetInterChatConfigForTest();
  });

  afterEach(() => {
    delete process.env.INTER_INSTANCE_CHAT_ENABLED;
    delete process.env.INTER_INSTANCE_CHAT_DIR;
    delete process.env.INTER_INSTANCE_CHAT_TTL_SEC;
    delete process.env.XANGI_INSTANCE_ID;
    delete process.env.XANGI_INSTANCE_LABEL;
    _resetInterChatConfigForTest();
  });

  it('デフォルト値が設計通り', async () => {
    const { getInterChatConfig } = await import('../src/inter-instance-chat/index.js');
    const cfg = getInterChatConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.dir).toBe('/tmp/xangi-chat');
    expect(cfg.ttlSec).toBe(3600);
    expect(cfg.usePolling).toBe(false);
  });

  it('環境変数で上書きできる', async () => {
    process.env.INTER_INSTANCE_CHAT_ENABLED = 'true';
    process.env.INTER_INSTANCE_CHAT_DIR = '/custom/dir';
    process.env.INTER_INSTANCE_CHAT_TTL_SEC = '120';
    process.env.XANGI_INSTANCE_ID = 'borot-test';
    process.env.XANGI_INSTANCE_LABEL = 'borot';
    _resetInterChatConfigForTest();
    const { getInterChatConfig } = await import('../src/inter-instance-chat/index.js');
    const cfg = getInterChatConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.dir).toBe('/custom/dir');
    expect(cfg.ttlSec).toBe(120);
    expect(cfg.selfInstanceId).toBe('borot-test');
    expect(cfg.selfLabel).toBe('borot');
  });
});
