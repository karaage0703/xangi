/**
 * Discord 等の文字数上限に合わせてテキストを分割するユーティリティ。
 *
 * separator (既定 '\n') 単位で結合しながら maxLength 以内のチャンクに分ける。
 * 1 ブロックが maxLength を超える場合は行単位 → さらに改行の無い超長行は
 * 文字数単位で強制スライスする。これにより「改行の無い長い 1 行」(長い URL /
 * 連結された長文 / 改行なしコード等) でも全チャンクが必ず maxLength 以内になる。
 *
 * この最後の文字数フォールバックが無いと、超長行が maxLength を超えたまま
 * Discord に送られ DiscordAPIError[50035] (content BASE_TYPE_MAX_LENGTH) で
 * 送信に失敗し、メッセージが更新されず「無反応」に見える事象が起きる。
 */
interface CodeFence {
  marker: string;
  openingLine: string;
}

function findLongestFenceOverhead(text: string): number {
  let longest = 0;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(`{3,})([^`]*)$/);
    if (match) longest = Math.max(longest, line.length + 1, match[1].length + 1);
  }
  return longest;
}

function updateOpenFence(text: string, initial: CodeFence | null): CodeFence | null {
  let openFence = initial;
  for (const line of text.split('\n')) {
    if (openFence) {
      const closing = line.match(/^\s*(`{3,})\s*$/);
      if (closing && closing[1].length >= openFence.marker.length) openFence = null;
      continue;
    }

    const opening = line.match(/^\s*(`{3,})([^`]*)$/);
    if (opening) {
      openFence = { marker: opening[1], openingLine: line };
    }
  }
  return openFence;
}

function balanceCodeFences(chunks: string[]): string[] {
  let openFence: CodeFence | null = null;
  return chunks.map((chunk) => {
    const prefix = openFence ? `${openFence.openingLine}\n` : '';
    openFence = updateOpenFence(chunk, openFence);
    const suffix = openFence ? `\n${openFence.marker}` : '';
    return `${prefix}${chunk}${suffix}`;
  });
}

function splitMessageInternal(
  text: string,
  maxLength: number,
  separator: string,
  preserveCodeFences: boolean
): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 2) {
    throw new RangeError('maxLength must be an integer greater than or equal to 2');
  }

  const fenceOverhead = preserveCodeFences ? findLongestFenceOverhead(text) : 0;
  if (fenceOverhead > 0 && maxLength <= fenceOverhead * 2) {
    throw new RangeError('maxLength is too small to preserve Markdown code fences');
  }
  const contentMaxLength = fenceOverhead > 0 ? maxLength - fenceOverhead * 2 : maxLength;

  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > contentMaxLength) {
      if (current) chunks.push(current.trim());
      // 単一ブロックがmaxLengthを超える場合は行単位でフォールバック
      if (block.length > contentMaxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (line.length > contentMaxLength) {
            // 改行の無い超長行を UTF-16 上限内で安全に分割する。
            // high surrogate (0xD800-0xDBFF) の直後で切ると文字化けするため、
            // 末尾が high surrogate のときは1つ前の境界を使う。
            if (current) {
              chunks.push(current.trim());
              current = '';
            }
            let offset = 0;
            while (offset < line.length) {
              let end = offset + contentMaxLength;
              if (end >= line.length) {
                // 末尾の半端は current に残し、後続ブロックと結合可能にする
                current = line.slice(offset);
                break;
              }
              // 境界が high surrogate の直後でサロゲートペアを分断しないよう調整
              if ((line.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
                if (end - 1 > offset) {
                  end--; // 安全に1つ前で切れる
                }
              }
              chunks.push(line.slice(offset, end));
              offset = end;
            }
          } else if (current.length + line.length + 1 > contentMaxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return fenceOverhead > 0 ? balanceCodeFences(chunks) : chunks;
}

export function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  return splitMessageInternal(text, maxLength, separator, false);
}

/** Discord Markdown のコードフェンスを各分割メッセージ内で閉じて再開する。 */
export function splitDiscordMessage(
  text: string,
  maxLength: number,
  separator: string = '\n'
): string[] {
  return splitMessageInternal(text, maxLength, separator, true);
}
