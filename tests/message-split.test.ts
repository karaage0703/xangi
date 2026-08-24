import { describe, it, expect } from 'vitest';
import { splitDiscordMessage, splitMessage } from '../src/message-split.js';

describe('splitMessage', () => {
  const MAX = 1900; // DISCORD_SAFE_LENGTH 相当

  it('短文はそのまま 1 チャンク', () => {
    const chunks = splitMessage('hello world', MAX);
    expect(chunks).toEqual(['hello world']);
  });

  it('改行ありの長文は行単位で分割し、各チャンクが maxLength 以内', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ` + 'x'.repeat(20)).join('\n');
    const chunks = splitMessage(text, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('改行の無い超長行(長いURL/連結長文)も maxLength 以内に強制分割される', () => {
    // 回帰テスト: これが splitMessage の文字数フォールバック欠落で
    // 1 チャンクのまま返り、Discord 50035 (BASE_TYPE_MAX_LENGTH) を起こしていた
    const longLine = 'a'.repeat(5000); // 改行なし 5000 字
    const chunks = splitMessage(longLine, MAX);
    expect(chunks.length).toBe(Math.ceil(5000 / MAX));
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
    // 文字が欠落していないこと（trim の影響を受けない 'a' のみ）
    expect(chunks.join('')).toBe(longLine);
  });

  it('超長行 + その後に通常ブロックが続いても全チャンク maxLength 以内', () => {
    const text = 'b'.repeat(4500) + '\n' + 'tail line';
    const chunks = splitMessage(text, MAX);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
    expect(chunks[chunks.length - 1]).toContain('tail line');
  });

  it('カスタムセパレータでも超長ブロックを maxLength 以内に分割', () => {
    const sep = '\n---\n';
    const text = 'c'.repeat(6000); // セパレータ無し・改行無しの超長ブロック
    const chunks = splitMessage(text, MAX, sep);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('ちょうど maxLength の行はそのまま 1 チャンク', () => {
    const exact = 'd'.repeat(MAX);
    const chunks = splitMessage(exact, MAX);
    expect(chunks).toEqual([exact]);
  });

  it('絵文字をサロゲートペアの途中で分断せず、UTF-16上限内に収める', () => {
    const text = '😀'.repeat(2000);
    const chunks = splitMessage(text, MAX);

    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
      expect(chunk.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  });

  it('サロゲートペアを保持できない maxLength は拒否する', () => {
    expect(() => splitMessage('😀', 1)).toThrow(RangeError);
    expect(() => splitMessage('abc', 0)).toThrow(RangeError);
  });

  it('言語指定付きコードブロックを跨いで分割しても各チャンクで閉じる', () => {
    const text = [
      '導入',
      '```text',
      ...Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(20)}`),
      '```',
      '結論',
    ].join('\n');
    const chunks = splitDiscordMessage(text, 300);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunks[0]).toContain('```text');
    expect(chunks[0]).toMatch(/\n```$/);
    expect(chunks[1]).toMatch(/^```text\n/);
    expect(chunks.at(-1)).toContain('結論');
  });

  it('コードブロック外のインラインコードはフェンスとして扱わない', () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}: \`value\``).join('\n');
    const chunks = splitDiscordMessage(text, 160);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 160)).toBe(true);
    expect(chunks.every((chunk) => !chunk.startsWith('```'))).toBe(true);
  });

  it('複数のコードブロックをそれぞれ独立して補正する', () => {
    const block = (language: string, fill: string) =>
      [`\`\`\`${language}`, ...Array.from({ length: 20 }, () => fill.repeat(15)), '```'].join('\n');
    const chunks = splitDiscordMessage(`${block('js', 'a')}\n間\n${block('json', 'b')}`, 140);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 140)).toBe(true);
    expect(chunks.some((chunk) => chunk.startsWith('```js\n'))).toBe(true);
    expect(chunks.some((chunk) => chunk.startsWith('```json\n'))).toBe(true);
  });
});
