import { describe, it, expect, vi } from 'vitest';

/**
 * 返信元メッセージのフォーマット関数（テスト用に再実装）
 */
function formatReplyContent(authorTag: string, content: string, attachmentNames: string[]): string {
  const attachmentInfo =
    attachmentNames.length > 0 ? `\n[添付: ${attachmentNames.join(', ')}]` : '';

  return `\n---\n💬 返信元 (${authorTag}):\n${content}${attachmentInfo}\n---\n`;
}

/**
 * 返信元があるかどうかを判定
 */
function hasReplyReference(reference: { messageId?: string } | null): boolean {
  return Boolean(reference?.messageId);
}

describe('Discord Reply Feature', () => {
  describe('hasReplyReference', () => {
    it('should return true when messageId exists', () => {
      const reference = { messageId: '1234567890' };
      expect(hasReplyReference(reference)).toBe(true);
    });

    it('should return false when reference is null', () => {
      expect(hasReplyReference(null)).toBe(false);
    });

    it('should return false when messageId is undefined', () => {
      const reference = {};
      expect(hasReplyReference(reference)).toBe(false);
    });

    it('should return false when messageId is empty string', () => {
      const reference = { messageId: '' };
      expect(hasReplyReference(reference)).toBe(false);
    });
  });

  describe('formatReplyContent', () => {
    it('should format reply content with author and text', () => {
      const result = formatReplyContent('user#1234', 'Hello world', []);
      expect(result).toBe('\n---\n💬 返信元 (user#1234):\nHello world\n---\n');
    });

    it('should include attachment info when present', () => {
      const result = formatReplyContent('user#1234', 'Check this', ['image.png', 'doc.pdf']);
      expect(result).toBe(
        '\n---\n💬 返信元 (user#1234):\nCheck this\n[添付: image.png, doc.pdf]\n---\n'
      );
    });

    it('should handle empty content', () => {
      const result = formatReplyContent('user#1234', '', ['file.txt']);
      expect(result).toBe('\n---\n💬 返信元 (user#1234):\n\n[添付: file.txt]\n---\n');
    });

    it('should handle attachment-only message placeholder', () => {
      const result = formatReplyContent('user#1234', '(添付ファイルのみ)', ['image.png']);
      expect(result).toBe(
        '\n---\n💬 返信元 (user#1234):\n(添付ファイルのみ)\n[添付: image.png]\n---\n'
      );
    });

    it('should handle multiline content', () => {
      const result = formatReplyContent('user#1234', 'Line 1\nLine 2\nLine 3', []);
      expect(result).toBe('\n---\n💬 返信元 (user#1234):\nLine 1\nLine 2\nLine 3\n---\n');
    });
  });

  describe('Reply content prepending', () => {
    it('should prepend reply content to prompt', () => {
      const replyContent = formatReplyContent('user#1234', 'Original message', []);
      const prompt = 'My response';
      const combined = replyContent + prompt;

      expect(combined).toContain('💬 返信元 (user#1234)');
      expect(combined).toContain('Original message');
      expect(combined).toContain('My response');
      expect(combined.indexOf('Original message')).toBeLessThan(combined.indexOf('My response'));
    });

    it('should work with empty prompt', () => {
      const replyContent = formatReplyContent('user#1234', 'Original', []);
      const prompt = '';
      const combined = replyContent + prompt;

      expect(combined).toContain('Original');
      expect(combined.endsWith('---\n')).toBe(true);
    });
  });
});
