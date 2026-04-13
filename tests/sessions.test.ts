import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initSessions,
  getSession,
  getSessionEntry,
  setSession,
  deleteSession,
  clearSessions,
  getSessionCount,
  getBootId,
  ensureSession,
  getActiveSessionId,
  createSession,
  setProviderSessionId,
  listAllSessions,
} from '../src/sessions.js';

describe('sessions', () => {
  let testDir: string;

  beforeEach(() => {
    clearSessions();
    testDir = mkdtempSync(join(tmpdir(), 'sessions-test-'));
  });

  afterEach(() => {
    clearSessions();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('initSessions', () => {
    it('should initialize with empty sessions', () => {
      initSessions(testDir);
      expect(getSessionCount()).toBe(0);
    });

    it('should load existing sessions from file (legacy format)', () => {
      // 旧フォーマット: { channelId: "sessionId" }
      const sessionsPath = join(testDir, 'sessions.json');
      const data = { 'channel-1': 'session-abc', 'channel-2': 'session-def' };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      expect(getSessionCount()).toBe(2);
      // 旧フォーマットはproviderSessionIdとして移行される
      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBe('session-def');
    });

    it('should load new format sessions', () => {
      const sessionsPath = join(testDir, 'sessions.json');
      const appId = 'test_appid_001';
      const data = {
        activeByContext: { 'channel-1': appId },
        sessions: {
          [appId]: {
            id: appId,
            title: 'Test',
            platform: 'discord',
            contextKey: 'channel-1',
            scope: 'interactive',
            bootId: 'boot-xyz',
            createdAt: '2026-03-18T00:00:00Z',
            updatedAt: '2026-03-18T00:00:00Z',
            messageCount: 0,
            agent: { backend: 'claude-code', providerSessionId: 'session-abc' },
            archived: false,
          },
        },
      };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      const entry = getSessionEntry(appId);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(appId);
      expect(entry!.scope).toBe('interactive');
      expect(entry!.agent?.providerSessionId).toBe('session-abc');
      expect(getSession('channel-1')).toBe('session-abc');
    });

    it('should purge scheduler sessions on init', () => {
      const sessionsPath = join(testDir, 'sessions.json');
      const data = {
        activeByContext: { 'channel-1': 'app1', 'channel-2': 'app2' },
        sessions: {
          app1: {
            id: 'app1', title: '', platform: 'discord', contextKey: 'channel-1',
            scope: 'interactive', bootId: 'boot-old', createdAt: '2026-03-18T00:00:00Z',
            updatedAt: '2026-03-18T00:00:00Z', messageCount: 0, archived: false,
            agent: { backend: 'claude-code', providerSessionId: 'session-abc' },
          },
          app2: {
            id: 'app2', title: '', platform: 'discord', contextKey: 'channel-2',
            scope: 'scheduler', bootId: 'boot-old', createdAt: '2026-03-18T00:00:00Z',
            updatedAt: '2026-03-18T00:00:00Z', messageCount: 0, archived: false,
            agent: { backend: 'claude-code', providerSessionId: 'session-def' },
          },
        },
      };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBeUndefined();
      expect(getSessionCount()).toBe(1);
    });

    it('should generate a new bootId on each init', () => {
      initSessions(testDir);
      const bootId1 = getBootId();
      clearSessions();
      initSessions(testDir);
      const bootId2 = getBootId();
      expect(bootId1).not.toBe(bootId2);
    });
  });

  describe('getSession', () => {
    it('should return undefined for unknown channel', () => {
      initSessions(testDir);
      expect(getSession('unknown')).toBeUndefined();
    });

    it('should return providerSessionId for known channel', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123');
      expect(getSession('channel-1')).toBe('session-123');
    });
  });

  describe('setSession', () => {
    it('should save session and persist to file', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123');

      const sessionsPath = join(testDir, 'sessions.json');
      expect(existsSync(sessionsPath)).toBe(true);

      const saved = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      // 新フォーマット: activeByContext + sessions
      expect(saved.activeByContext['channel-1']).toBeDefined();
      const appId = saved.activeByContext['channel-1'];
      expect(saved.sessions[appId].agent.providerSessionId).toBe('session-123');
      expect(saved.sessions[appId].scope).toBe('interactive');
    });

    it('should update existing session', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-old');
      setSession('channel-1', 'session-new');

      expect(getSession('channel-1')).toBe('session-new');
    });

    it('should save with scheduler scope', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123', 'scheduler');

      const appId = getActiveSessionId('channel-1');
      expect(appId).toBeDefined();
      const entry = getSessionEntry(appId!);
      expect(entry!.scope).toBe('scheduler');
    });
  });

  describe('deleteSession', () => {
    it('should delete active pointer and persist', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123');
      expect(getSession('channel-1')).toBe('session-123');

      const deleted = deleteSession('channel-1');
      expect(deleted).toBe(true);
      expect(getSession('channel-1')).toBeUndefined();
    });

    it('should return false for unknown channel', () => {
      initSessions(testDir);
      const deleted = deleteSession('unknown');
      expect(deleted).toBe(false);
    });
  });

  describe('ensureSession', () => {
    it('should create new session if none exists', () => {
      initSessions(testDir);
      const appId = ensureSession('channel-1', { platform: 'discord' });
      expect(appId).toBeDefined();
      expect(getActiveSessionId('channel-1')).toBe(appId);
    });

    it('should return existing session if already active', () => {
      initSessions(testDir);
      const id1 = ensureSession('channel-1');
      const id2 = ensureSession('channel-1');
      expect(id1).toBe(id2);
    });
  });

  describe('createSession', () => {
    it('should create a new session with metadata', () => {
      initSessions(testDir);
      const appId = createSession('web-chat', { platform: 'web', title: 'Test Chat' });
      const entry = getSessionEntry(appId);
      expect(entry).toBeDefined();
      expect(entry!.platform).toBe('web');
      expect(entry!.title).toBe('Test Chat');
      expect(entry!.contextKey).toBe('web-chat');
    });
  });

  describe('setProviderSessionId', () => {
    it('should set providerSessionId on existing session', () => {
      initSessions(testDir);
      const appId = createSession('channel-1');
      setProviderSessionId(appId, 'provider-abc', 'claude-code');
      const entry = getSessionEntry(appId);
      expect(entry!.agent?.providerSessionId).toBe('provider-abc');
      expect(entry!.agent?.backend).toBe('claude-code');
    });
  });

  describe('listAllSessions', () => {
    it('should list non-archived sessions sorted by updatedAt', () => {
      initSessions(testDir);
      createSession('channel-1', { platform: 'discord' });
      createSession('channel-2', { platform: 'slack' });
      const sessions = listAllSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe('persistence across restarts', () => {
    it('should persist sessions across init calls', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-abc');
      setSession('channel-2', 'session-def');

      clearSessions();
      initSessions(testDir);

      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBe('session-def');
    });

    it('should purge scheduler sessions but keep interactive on restart', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-abc', 'interactive');
      setSession('channel-2', 'session-def', 'scheduler');

      clearSessions();
      initSessions(testDir);

      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBeUndefined();
    });
  });
});
