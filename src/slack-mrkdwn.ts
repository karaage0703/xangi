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
const BOLD_MARK = '\uE002';

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

// フェンス付きコードブロックとインラインコードを退避する。
function protectCode(text: string, vault: CodeVault): string {
  // ```lang\n ... ``` （Slackはフェンス対応。中身は一切変換しない）
  let out = text.replace(/```[\s\S]*?```/g, (m) => vault.stash(m));
  // `inline code`
  out = out.replace(/`[^`\n]+`/g, (m) => vault.stash(m));
  return out;
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

// 行単位の変換（見出し・水平線・箇条書き）。
function convertBlocks(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // 水平線: ---, ***, ___ のみの行
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        return '──────────';
      }
      // 見出し: # 〜 ###### → 太字
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (heading) {
        // 太字マーカー経由にして後段の斜体変換に巻き込まれないようにする
        return `${BOLD_MARK}${heading[2]}${BOLD_MARK}`;
      }
      // 箇条書き: -, *, + → •（インデント維持）
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet) {
        return `${bullet[1]}• ${bullet[2]}`;
      }
      return line;
    })
    .join('\n');
}

// インライン装飾の変換（太字・斜体・打ち消し・リンク）。
function convertInline(text: string): string {
  let out = text;
  // 画像 ![alt](url) → <url|alt>
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_, alt, url) => `<${url}|${alt || url}>`
  );
  // リンク [text](url) → <url|text>
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_, label, url) => `<${url}|${label}>`
  );
  // 太字斜体 ***x*** → *_x_*
  out = out.replace(/\*\*\*([^\n]+?)\*\*\*/g, `${BOLD_MARK}_$1_${BOLD_MARK}`);
  // 太字 **x** / __x__ → 一時マーク
  out = out.replace(/\*\*([^\n]+?)\*\*/g, `${BOLD_MARK}$1${BOLD_MARK}`);
  out = out.replace(/__([^\n_]+?)__/g, `${BOLD_MARK}$1${BOLD_MARK}`);
  // 打ち消し ~~x~~ → ~x~
  out = out.replace(/~~([^\n]+?)~~/g, '~$1~');
  // 斜体 *x* → _x_（前後が空白/記号のときのみ。箇条書きの残骸を巻き込まない）
  out = out.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1_$2_');
  // 太字マークを復元
  out = out.split(BOLD_MARK).join('*');
  return out;
}

// Markdown文字列を Slack mrkdwn へ変換する。
export function markdownToSlackMrkdwn(markdown: string): string {
  if (!markdown) return markdown;
  const vault = new CodeVault();
  let text = protectCode(markdown, vault);
  text = protectTables(text, vault);
  text = convertBlocks(text);
  text = convertInline(text);
  text = vault.restore(text);
  return text;
}
