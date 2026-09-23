import type { Root, RootContent, PhrasingContent, TableCell } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitMessage, splitTelegramMarkdown } from './message-split.js';

const parser = unified().use(remarkParse).use(remarkGfm);

export interface TelegramTextChunk {
  text: string;
  plainText: string;
  parseMode?: 'HTML';
}

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(nodes: readonly PhrasingContent[]): string {
  return nodes.map(renderNode).join('');
}

function plainInline(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if ('value' in node && typeof node.value === 'string') return node.value;
      if ('children' in node) return plainInline(node.children as PhrasingContent[]);
      return '';
    })
    .join('');
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    width += code > 0xff && !(code >= 0xff61 && code <= 0xff9f) ? 2 : 1;
  }
  return width;
}

function renderTable(rows: readonly { children: TableCell[] }[]): string {
  const cells = rows.map((row) => row.children.map((cell) => plainInline(cell.children)));
  const columnCount = Math.max(0, ...cells.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(0, ...cells.map((row) => displayWidth(row[column] ?? '')))
  );
  const formatRow = (row: string[]) =>
    widths
      .map((width, column) => {
        const cell = row[column] ?? '';
        return cell + ' '.repeat(Math.max(0, width - displayWidth(cell)));
      })
      .join('  ')
      .trimEnd();
  const divider = widths.map((width) => '─'.repeat(width)).join('──');
  return [formatRow(cells[0] ?? []), divider, ...cells.slice(1).map(formatRow)].join('\n');
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function renderNode(node: RootContent | PhrasingContent): string {
  switch (node.type) {
    case 'text':
      return escapeTelegramHtml(node.value);
    case 'strong':
      return `<b>${renderInline(node.children)}</b>`;
    case 'emphasis':
      return `<i>${renderInline(node.children)}</i>`;
    case 'delete':
      return `<s>${renderInline(node.children)}</s>`;
    case 'inlineCode':
      return `<code>${escapeTelegramHtml(node.value)}</code>`;
    case 'code': {
      const language = node.lang?.match(/^[a-z0-9_+.-]{1,32}$/i)?.[0];
      const code = escapeTelegramHtml(node.value);
      return language
        ? `<pre><code class="language-${language}">${code}</code></pre>`
        : `<pre>${code}</pre>`;
    }
    case 'link': {
      const label = renderInline(node.children);
      const url = safeHttpUrl(node.url);
      return url ? `<a href="${escapeTelegramHtml(url)}">${label}</a>` : label;
    }
    case 'image':
      return escapeTelegramHtml(node.alt ?? '');
    case 'heading':
      return `<b>${renderInline(node.children)}</b>`;
    case 'paragraph':
      return renderInline(node.children);
    case 'break':
      return '\n';
    case 'blockquote':
      return `<blockquote>${node.children.map(renderNode).join('\n\n')}</blockquote>`;
    case 'list':
      return node.children
        .map((item, index) => {
          const prefix = node.ordered ? `${(node.start ?? 1) + index}. ` : '• ';
          return prefix + item.children.map(renderNode).join('\n');
        })
        .join('\n');
    case 'table':
      return `<pre>${escapeTelegramHtml(renderTable(node.children))}</pre>`;
    case 'thematicBreak':
      return '──────────';
    case 'html':
      return escapeTelegramHtml(node.value);
    default:
      return 'value' in node && typeof node.value === 'string'
        ? escapeTelegramHtml(node.value)
        : '';
  }
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';
  const root = parser.parse(markdown) as Root;
  return root.children.map(renderNode).join('\n\n');
}

export function telegramTextChunks(
  markdown: string,
  format: 'html' | 'plain' = 'html'
): TelegramTextChunk[] {
  if (format === 'plain')
    return splitMessage(markdown, 4096).map((plainText) => ({ text: plainText, plainText }));
  try {
    return splitTelegramMarkdown(markdown).map((plainText) => formatTelegramChunk(plainText));
  } catch {
    return splitMessage(markdown, 4096).map((plainText) => ({ text: plainText, plainText }));
  }
}

export function formatTelegramChunk(
  plainText: string,
  format: 'html' | 'plain' = 'html'
): TelegramTextChunk {
  if (format === 'plain') return { text: plainText, plainText };
  try {
    const html = markdownToTelegramHtml(plainText);
    return html.length <= 4096
      ? { text: html || escapeTelegramHtml(plainText), plainText, parseMode: 'HTML' }
      : { text: plainText, plainText };
  } catch {
    return { text: plainText, plainText };
  }
}
