import { describe, it, expect } from 'vitest';

/**
 * annotateChannelMentions のテスト用に関数を再実装
 * （元の関数は startDiscord 内のローカル関数のため）
 */
function annotateChannelMentions(text: string): string {
  return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
}

/**
 * 表示用テキストからコマンド行を除去する（コードブロック内は残す）
 * SYSTEM_COMMAND: で始まる行を除去
 */
function stripCommandsFromDisplay(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // SYSTEM_COMMAND: 行を除去
    if (line.trim().startsWith('SYSTEM_COMMAND:')) {
      continue;
    }

    result.push(line);
  }

  return result.join('\n').trim();
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

  describe('stripCommandsFromDisplay', () => {
    it('should remove SYSTEM_COMMAND lines', () => {
      const text = `テキスト\nSYSTEM_COMMAND:setting=value\n続き`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('テキスト\n続き');
    });

    it('should keep SYSTEM_COMMAND inside code blocks', () => {
      const text = `例:\n\`\`\`\nSYSTEM_COMMAND:setting=value\n\`\`\`\n以上`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('例:\n```\nSYSTEM_COMMAND:setting=value\n```\n以上');
    });

    it('should handle empty text', () => {
      const result = stripCommandsFromDisplay('');
      expect(result).toBe('');
    });

    it('should not strip regular text', () => {
      const text = 'テキスト前\n普通のテキスト\nテキスト後';
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('テキスト前\n普通のテキスト\nテキスト後');
    });
  });
});
