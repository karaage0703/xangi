import { describe, expect, it } from 'vitest';

import {
  sessionListStatus,
  sessionListStatusLabel,
  sessionSource,
  parseSessionSources,
  restoreSessionSources,
  SESSION_SOURCES_KEY,
} from '../web-ui/src/sessionList.js';

describe('sessionListStatus', () => {
  it('distinguishes running, waiting, and completed without relying on color', () => {
    expect(sessionListStatus({ isActive: true, lifecycle: 'open' })).toBe('running');
    expect(sessionListStatus({ isActive: false, lifecycle: 'open' })).toBe('waiting');
    expect(sessionListStatus({ isActive: true, lifecycle: 'closed' })).toBe('completed');
    expect(sessionListStatusLabel('running')).toBe('実行中');
    expect(sessionListStatusLabel('waiting')).toBe('待機中');
    expect(sessionListStatusLabel('completed')).toBe('完了');
  });
});

describe('session source visibility', () => {
  it('classifies scheduled runs before their delivery platform', () => {
    for (const platform of ['web', 'discord', 'slack', 'line', 'telegram']) {
      expect(sessionSource({ platform, scope: 'scheduler' })).toBe('scheduler');
      expect(sessionSource({ platform, scope: 'interactive' })).toBe(
        platform === 'web' ? 'web' : 'chat'
      );
    }
    expect(sessionSource({ platform: 'web' })).toBe('web');
  });
  it('restores saved choices including hiding everything and safely defaults corrupt data', () => {
    expect(parseSessionSources('["web","scheduler"]')).toEqual(['web', 'scheduler']);
    expect(parseSessionSources('[]')).toEqual([]);
    for (const stored of [null, '{bad', '{}', '["unknown"]', '[1]']) {
      expect(parseSessionSources(stored)).toEqual(['chat', 'web']);
    }
    expect(parseSessionSources('["web","web"]')).toEqual(['web']);
  });
});

describe('source preference migration', () => {
  const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
  it('starts with Schedule off, preserves older Chat/Web choices, and retains later opt-ins', () => {
    expect(restoreSessionSources(storage({}))).toEqual(['chat', 'web']);
    expect(restoreSessionSources(storage({'xangi.chat.visible-sources.v1': '["chat","web","scheduler"]'}))).toEqual(['chat', 'web']);
    expect(restoreSessionSources(storage({'xangi.chat.visible-sources.v1': '["web"]'}))).toEqual(['web']);
    expect(restoreSessionSources(storage({[SESSION_SOURCES_KEY]: '["web","scheduler"]'}))).toEqual(['web', 'scheduler']);
    expect(restoreSessionSources(storage({[SESSION_SOURCES_KEY]: '[]'}))).toEqual([]);
  });
});

it('uses the same source classification as Monitor for manual and automated transports', async () => {
  const {matchesFilter, isMonitorVisible} = await import('../web-ui/src/Monitor.js');
  for (const platform of ['web', 'discord', 'slack', 'telegram', 'line']) {
    for (const executionOrigin of ['manual', 'automation'] as const) {
      const input = {platform, executionOrigin, id: 'fixture', isActive: false, lifecycle: 'closed' as const, sessionMode: 'stateful' as const};
      for (const value of ['chat', 'web', 'scheduler'] as const) {
        expect(matchesFilter(input, [value])).toBe(sessionSource(input) === value);
      }
      if (executionOrigin === 'automation') {
        expect(isMonitorVisible({...input, sessionMode: 'stateless'})).toBe(true);
      }
    }
  }
});
