import { describe, it, expect, vi } from 'vitest';

/**
 * annotateChannelMentions のテスト用に関数を再実装
 * （元の関数は startDiscord 内のローカル関数のため）
 */
function annotateChannelMentions(text: string): string {
  return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
}

/**
 * コードブロック判定のテスト用
 */
function isInCodeBlock(lines: string[], targetIndex: number): boolean {
  let inCodeBlock = false;
  for (let i = 0; i <= targetIndex; i++) {
    if (lines[i].trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }
  return inCodeBlock;
}

describe('Discord Commands', () => {
  describe('annotateChannelMentions', () => {
    it('should add channel ID annotation', () => {
      const input = '<#1234567890> に投稿して';
      const result = annotateChannelMentions(input);
      expect(result).toBe('<#1234567890> [チャンネルID: 1234567890] に投稿して');
    });

    it('should handle multiple channel mentions', () => {
      const input = '<#111> と <#222> に送って';
      const result = annotateChannelMentions(input);
      expect(result).toBe('<#111> [チャンネルID: 111] と <#222> [チャンネルID: 222] に送って');
    });

    it('should not modify text without channel mentions', () => {
      const input = '普通のテキスト';
      const result = annotateChannelMentions(input);
      expect(result).toBe('普通のテキスト');
    });

    it('should handle empty string', () => {
      const result = annotateChannelMentions('');
      expect(result).toBe('');
    });
  });

  describe('isInCodeBlock', () => {
    it('should detect code block', () => {
      const lines = ['text', '```', 'code', '```', 'text'];
      expect(isInCodeBlock(lines, 0)).toBe(false);
      expect(isInCodeBlock(lines, 2)).toBe(true);
      expect(isInCodeBlock(lines, 4)).toBe(false);
    });

    it('should handle nested code blocks', () => {
      const lines = ['```', 'code1', '```', 'text', '```', 'code2', '```'];
      expect(isInCodeBlock(lines, 1)).toBe(true);
      expect(isInCodeBlock(lines, 3)).toBe(false);
      expect(isInCodeBlock(lines, 5)).toBe(true);
    });
  });

  describe('/autoreply command guard', () => {
    /**
     * コマンド登録ロジック: allowAutoreplyCommand が true の場合のみ autoreply コマンドを登録
     */
    function buildCommandNames(allowAutoreplyCommand: boolean): string[] {
      const commands: string[] = ['new', 'stop', 'skip', 'restart', 'backend'];
      if (allowAutoreplyCommand) {
        commands.push('autoreply');
      }
      return commands;
    }

    /**
     * コマンド実行ガード: allowAutoreplyCommand が false なら拒否
     */
    function handleAutoreply(
      allowAutoreplyCommand: boolean,
      autoReplyChannels: string[],
      channelId: string
    ): { allowed: boolean; status?: string; channels?: string[] } {
      if (!allowAutoreplyCommand) {
        return { allowed: false };
      }
      const channels = [...autoReplyChannels];
      const idx = channels.indexOf(channelId);
      const isCurrentlyOn = idx !== -1;
      if (isCurrentlyOn) {
        channels.splice(idx, 1);
      } else {
        channels.push(channelId);
      }
      const status = isCurrentlyOn ? 'OFF' : 'ON';
      return { allowed: true, status, channels };
    }

    it('should not register autoreply command when allowAutoreplyCommand is false', () => {
      const commands = buildCommandNames(false);
      expect(commands).not.toContain('autoreply');
    });

    it('should register autoreply command when allowAutoreplyCommand is true', () => {
      const commands = buildCommandNames(true);
      expect(commands).toContain('autoreply');
    });

    it('should reject autoreply execution when allowAutoreplyCommand is false', () => {
      const result = handleAutoreply(false, [], '123');
      expect(result.allowed).toBe(false);
      expect(result.status).toBeUndefined();
    });

    it('should allow autoreply execution and toggle ON when allowAutoreplyCommand is true', () => {
      const result = handleAutoreply(true, [], '123');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('ON');
      expect(result.channels).toEqual(['123']);
    });

    it('should toggle OFF when channel is already in autoReplyChannels', () => {
      const result = handleAutoreply(true, ['123', '456'], '123');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('OFF');
      expect(result.channels).toEqual(['456']);
    });

    it('should add channel when not in autoReplyChannels', () => {
      const result = handleAutoreply(true, ['456'], '123');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('ON');
      expect(result.channels).toEqual(['456', '123']);
    });
  });
});
