import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initSettings,
  loadSettings,
  saveSettings,
  formatSettings,
  clearSettingsCache,
  getChannelAutoReply,
  getChannelCompletionNotifyMode,
  getChannelThreadMode,
} from '../src/settings.js';

describe('settings', () => {
  let tempDir: string;

  beforeEach(() => {
    clearSettingsCache();
    tempDir = mkdtempSync(join(tmpdir(), 'xangi-settings-test-'));
    initSettings(tempDir);
  });

  afterEach(() => {
    clearSettingsCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    it('should return default settings when no file exists', () => {
      const settings = loadSettings();
      expect(settings).toEqual({ autoRestart: true });
    });

    it('should load settings from file', () => {
      const filePath = join(tempDir, 'settings.json');
      const { writeFileSync } = require('fs');
      writeFileSync(filePath, JSON.stringify({ autoRestart: false }));

      const settings = loadSettings();
      expect(settings.autoRestart).toBe(false);
    });

    it('should load valid Discord completion notification channel settings', () => {
      const filePath = join(tempDir, 'settings.json');
      const { writeFileSync } = require('fs');
      writeFileSync(
        filePath,
        JSON.stringify({
          autoRestart: true,
          discordCompletionNotifyChannels: {
            '123': 'mention',
            '456': 'message',
            not_a_channel: 'off',
            '789': 'invalid',
          },
        })
      );

      const settings = loadSettings();
      expect(settings.discordCompletionNotifyChannels).toEqual({
        '123': 'mention',
        '456': 'message',
      });
    });

    it('should load valid Discord auto-reply channel settings', () => {
      const filePath = join(tempDir, 'settings.json');
      const { writeFileSync } = require('fs');
      writeFileSync(
        filePath,
        JSON.stringify({
          autoRestart: true,
          discordAutoReplyChannels: {
            '123': true,
            '456': false,
            not_a_channel: true,
            '789': 'true',
          },
        })
      );

      const settings = loadSettings();
      expect(settings.discordAutoReplyChannels).toEqual({
        '123': true,
        '456': false,
      });
    });

    it('should load valid Discord thread mode channel settings', () => {
      const filePath = join(tempDir, 'settings.json');
      const { writeFileSync } = require('fs');
      writeFileSync(
        filePath,
        JSON.stringify({
          autoRestart: true,
          discordThreadModeChannels: {
            '123': true,
            '456': false,
            not_a_channel: true,
            '789': 'true',
          },
        })
      );

      const settings = loadSettings();
      expect(settings.discordThreadModeChannels).toEqual({
        '123': true,
        '456': false,
      });
    });

    it('should return default on invalid JSON', () => {
      const filePath = join(tempDir, 'settings.json');
      const { writeFileSync } = require('fs');
      writeFileSync(filePath, 'not json');

      const settings = loadSettings();
      expect(settings).toEqual({ autoRestart: true });
    });

    it('should use cached value on second call', () => {
      const s1 = loadSettings();
      const s2 = loadSettings();
      expect(s1).toEqual(s2);
    });
  });

  describe('saveSettings', () => {
    it('should save and return merged settings', () => {
      const result = saveSettings({ autoRestart: false });
      expect(result.autoRestart).toBe(false);

      // ファイルに書き込まれたか確認
      const filePath = join(tempDir, 'settings.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.autoRestart).toBe(false);
    });

    it('should save Discord completion notification channel settings', () => {
      const result = saveSettings({
        discordCompletionNotifyChannels: {
          '123': 'mention',
        },
      });
      expect(result.discordCompletionNotifyChannels).toEqual({ '123': 'mention' });

      const filePath = join(tempDir, 'settings.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.discordCompletionNotifyChannels).toEqual({ '123': 'mention' });
    });

    it('should save Discord auto-reply channel settings', () => {
      const result = saveSettings({
        discordAutoReplyChannels: {
          '123': true,
        },
      });
      expect(result.discordAutoReplyChannels).toEqual({ '123': true });

      const filePath = join(tempDir, 'settings.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.discordAutoReplyChannels).toEqual({ '123': true });
    });

    it('should save Discord thread mode channel settings', () => {
      const result = saveSettings({
        discordThreadModeChannels: {
          '123': true,
          '456': false,
        },
      });
      expect(result.discordThreadModeChannels).toEqual({ '123': true, '456': false });

      const filePath = join(tempDir, 'settings.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.discordThreadModeChannels).toEqual({ '123': true, '456': false });
    });

    it('should merge with existing settings', () => {
      saveSettings({ autoRestart: false });

      clearSettingsCache();
      initSettings(tempDir);

      // autoRestart以外のフィールドが将来追加されてもマージされる
      const loaded = loadSettings();
      expect(loaded.autoRestart).toBe(false);
    });

    it('should update cache after save', () => {
      saveSettings({ autoRestart: false });
      const loaded = loadSettings();
      expect(loaded.autoRestart).toBe(false);
    });
  });

  describe('formatSettings', () => {
    it('should format settings with ON status', () => {
      const result = formatSettings({ autoRestart: true });
      expect(result).toContain('✅ ON');
      expect(result).toContain('自動再起動');
      expect(result).toContain('Discordメンションなし応答チャンネル設定: 0件');
      expect(result).toContain('Discord完了通知チャンネル設定: 0件');
      expect(result).toContain('Discordスレッドモードチャンネル設定: 0件');
    });

    it('should format settings with OFF status', () => {
      const result = formatSettings({ autoRestart: false });
      expect(result).toContain('❌ OFF');
    });

    it('should include Discord completion notification channel count', () => {
      const result = formatSettings({
        autoRestart: true,
        discordCompletionNotifyChannels: { '123': 'mention', '456': 'off' },
      });
      expect(result).toContain('Discord完了通知チャンネル設定: 2件');
    });

    it('should include Discord auto-reply channel count', () => {
      const result = formatSettings({
        autoRestart: true,
        discordAutoReplyChannels: { '123': true, '456': true },
      });
      expect(result).toContain('Discordメンションなし応答チャンネル設定: 2件');
    });

    it('should include Discord thread mode channel count', () => {
      const result = formatSettings({
        autoRestart: true,
        discordThreadModeChannels: { '123': true, '456': false },
      });
      expect(result).toContain('Discordスレッドモードチャンネル設定: 2件');
    });
  });

  describe('getChannelAutoReply', () => {
    it('should prefer channel setting', () => {
      const enabled = getChannelAutoReply(
        { autoRestart: true, discordAutoReplyChannels: { '123': true } },
        '123',
        false
      );
      expect(enabled).toBe(true);
    });

    it('should fall back to default setting', () => {
      const enabled = getChannelAutoReply({ autoRestart: true }, '123', false);
      expect(enabled).toBe(false);
    });
  });

  describe('getChannelCompletionNotifyMode', () => {
    it('should prefer channel override', () => {
      const mode = getChannelCompletionNotifyMode(
        { autoRestart: true, discordCompletionNotifyChannels: { '123': 'mention' } },
        '123',
        'off'
      );
      expect(mode).toBe('mention');
    });

    it('should fall back to default mode', () => {
      const mode = getChannelCompletionNotifyMode({ autoRestart: true }, '123', 'message');
      expect(mode).toBe('message');
    });
  });

  describe('getChannelThreadMode', () => {
    it('should prefer channel override', () => {
      const mode = getChannelThreadMode(
        { autoRestart: true, discordThreadModeChannels: { '123': true } },
        '123',
        false
      );
      expect(mode).toBe(true);
    });

    it('should fall back to default mode', () => {
      const mode = getChannelThreadMode({ autoRestart: true }, '123', true);
      expect(mode).toBe(true);
    });
  });
});
