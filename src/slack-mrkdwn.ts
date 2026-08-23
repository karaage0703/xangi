import { slackifyMarkdown } from 'slackify-markdown';

// Markdown（エージェントの出力）を Slack の mrkdwn 記法へ変換する。
// Slack のメッセージ text は既定で mrkdwn として描画されるため、記法の差分を吸収すれば
// 太字・斜体・リンク・箇条書き・見出し・表がそのまま整形表示される。
//
// 標準Markdown → Slack mrkdwn の主な差分:
//   **bold** / __bold__ → *bold*
//   *italic*            → _italic_
//   ~~strike~~          → ~strike~
//   # 見出し            → *見出し*（Slackに見出し記法がないため太字で代替）
//   [text](url)         → <url|text>
//   - / * / + 箇条書き  → • 箇条書き
//   表                  → 等幅整形してコードブロックで囲む（Slackは表未対応）
//   `code` / ```block```→ そのまま（Slackが対応）

const PLACEHOLDER_OPEN = '\uE000';
const PLACEHOLDER_CLOSE = '\uE001';

// 保護したいコード片（フェンス/インライン/整形済み表）を退避し、プレースホルダに置換する。
class CodeVault {
  private tokens: string[] = [];

  stash(content: string): string {
    const index = this.tokens.push(content) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  }

  restore(text: string): string {
    return text.replace(
      new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'),
      (_, i: string) => this.tokens[Number(i)] ?? ''
    );
  }
}

// CommonMark で有効な [text](<url>) 形式を、slackify-markdown が扱える
// [text](url) 形式へ正規化する。コード内は protectCode で先に退避済み。
function normalizeAngleBracketLinkDestinations(text: string): string {
  return text.replace(/(!?\[[^\]\n]*\])\(<((?:https?:\/\/|ftp:\/\/|mailto:)[^>\n]+)>\)/g, '$1($2)');
}

// フェンス付きコードブロックとインラインコードを退避する。
function protectCode(text: string, vault: CodeVault): string {
  // Slackはコードフェンスの言語指定に対応せず、言語名を本文として表示する。
  // 情報文字列だけ外し、コード本文は一切変換せず退避する。
  let out = text.replace(/```[\s\S]*?```/g, (m) => vault.stash(m.replace(/^```[^\n]*\n/, '```\n')));
  // `inline code`
  out = out.replace(/`[^`\n]+`/g, (m) => vault.stash(m));
  return out;
}

function addSlackBoldBoundaries(text: string): string {
  const codeParts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);

  for (let index = 0; index < codeParts.length; index += 2) {
    // slackify-markdownが補うU+200Bでは日本語隣接時に装飾されない場合があるため、
    // Slack実機で安定するWORD JOINERへ置き換える。
    const part = codeParts[index].replace(/\u200B(?=\*[^*\n]+?\*)|(\*[^*\n]+?\*)\u200B/g, '$1');
    codeParts[index] = part.replace(/(?<!\*)\*[^*\n]+?\*(?!\*)/g, (match, offset) => {
      const before = offset > 0 ? part[offset - 1] : '';
      const after = offset + match.length < part.length ? part[offset + match.length] : '';
      const prefix =
        before && !/\s/.test(before) && !'([{（［｛「『【〈《'.includes(before) ? '\u2060' : '';
      const suffix =
        after && !/\s/.test(after) && !'.,!?;:、。！？)]}）］｝」』】〉》'.includes(after)
          ? '\u2060'
          : '';
      return `${prefix}${match}${suffix}`;
    });
  }

  return codeParts.join('');
}

// エージェントがすでに出力した Slack 固有リンク・mention・日付記法を退避する。
// slackify-markdown は Markdown の autolink として再解釈するため、変換前の保護が必要。
function protectSlackMrkdwn(text: string, vault: CodeVault): string {
  return text.replace(/<(?:https?:\/\/|ftp:\/\/|mailto:|[@#!])[^>\n]+>/g, (match) =>
    vault.stash(match)
  );
}

// Markdownの表を等幅整形し、コードブロックとして退避する。
function protectTables(text: string, vault: CodeVault): string {
  const lines = text.split('\n');
  const result: string[] = [];
  const isSeparator = (line: string): boolean =>
    /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
  const looksLikeRow = (line: string): boolean => line.includes('|');

  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && looksLikeRow(lines[i]) && isSeparator(lines[i + 1])) {
      const block: string[] = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && looksLikeRow(lines[j]) && lines[j].trim() !== '') {
        block.push(lines[j]);
        j++;
      }
      result.push(vault.stash('```\n' + renderTable(block) + '\n```'));
      i = j - 1;
      continue;
    }
    result.push(lines[i]);
  }
  return result.join('\n');
}

// 表の行配列を、列幅を揃えた等幅テキストへ整形する（区切り行は罫線に置換）。
function renderTable(block: string[]): string {
  const splitRow = (line: string): string[] =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());

  const header = splitRow(block[0]);
  const bodyRows = block.slice(2).map(splitRow);
  const colCount = Math.max(header.length, ...bodyRows.map((r) => r.length));
  const widths = new Array<number>(colCount).fill(0);

  const allRows = [header, ...bodyRows];
  for (const row of allRows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], displayWidth(row[c] ?? ''));
    }
  }

  const pad = (cell: string, width: number): string =>
    cell + ' '.repeat(Math.max(0, width - displayWidth(cell)));
  const formatRow = (row: string[]): string =>
    row.map((cell, c) => pad(cell ?? '', widths[c])).join('  ');

  const divider = widths.map((w) => '─'.repeat(w)).join('──');
  return [formatRow(header), divider, ...bodyRows.map(formatRow)].join('\n');
}

// 全角文字を2幅として数える簡易表示幅。
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Latin-1範囲(<=0xFF)は1幅、半角カナ(0xFF61-0xFF9F)も1幅、それ以外の全角は2幅
    const halfKana = cp >= 0xff61 && cp <= 0xff9f;
    width += cp > 0xff && !halfKana ? 2 : 1;
  }
  return width;
}

// slackify-markdown が表現を変える水平線とネスト箇条書きだけ先に整える。
function convertBlocks(text: string, vault: CodeVault): string {
  return text
    .split('\n')
    .map((line) => {
      // 水平線: ---, ***, ___ のみの行
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        return '──────────';
      }
      // 箇条書き: -, *, + → •（インデント維持）
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet) {
        const indent = bullet[1] ? vault.stash(bullet[1]) : '';
        return `${indent}• ${bullet[2]}`;
      }
      return line;
    })
    .join('\n');
}

// Markdown文字列を Slack mrkdwn へ変換する。
export function markdownToSlackMrkdwn(markdown: string): string {
  if (!markdown) return markdown;
  const vault = new CodeVault();
  let text = protectCode(markdown, vault);
  text = normalizeAngleBracketLinkDestinations(text);
  text = protectTables(text, vault);
  text = protectSlackMrkdwn(text, vault);
  text = convertBlocks(text, vault);
  text = slackifyMarkdown(text);
  // slackify-markdown は非空入力の末尾へ改行を1つ追加する。
  if (text.endsWith('\n')) text = text.slice(0, -1);
  text = vault.restore(text);
  return addSlackBoldBoundaries(text);
}
