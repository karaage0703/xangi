import type {
  Definition,
  FootnoteDefinition,
  Root,
  RootContent,
  PhrasingContent,
  TableCell,
} from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitMessage, splitTelegramMarkdown } from './message-split.js';

const parser = unified().use(remarkParse).use(remarkGfm);

interface RenderContext {
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
  usedFootnotes: Set<string>;
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function createRenderContext(root: Root): RenderContext {
  const context: RenderContext = {
    definitions: new Map(),
    footnotes: new Map(),
    usedFootnotes: new Set(),
  };
  for (const node of root.children) {
    if (node.type === 'definition')
      context.definitions.set(normalizeIdentifier(node.identifier), node);
    if (node.type === 'footnoteDefinition')
      context.footnotes.set(normalizeIdentifier(node.identifier), node);
  }
  return context;
}

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

function renderInline(nodes: readonly PhrasingContent[], context: RenderContext): string {
  return nodes.map((node) => renderNode(node, context)).join('');
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

function renderNode(node: RootContent | PhrasingContent, context: RenderContext): string {
  switch (node.type) {
    case 'text':
      return escapeTelegramHtml(node.value);
    case 'strong':
      return `<b>${renderInline(node.children, context)}</b>`;
    case 'emphasis':
      return `<i>${renderInline(node.children, context)}</i>`;
    case 'delete':
      return `<s>${renderInline(node.children, context)}</s>`;
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
      const label = renderInline(node.children, context);
      const url = safeHttpUrl(node.url);
      return url ? `<a href="${escapeTelegramHtml(url)}">${label}</a>` : label;
    }
    case 'linkReference': {
      const label = renderInline(node.children, context);
      const definition = context.definitions.get(normalizeIdentifier(node.identifier));
      const url = definition && safeHttpUrl(definition.url);
      return url ? `<a href="${escapeTelegramHtml(url)}">${label}</a>` : label;
    }
    case 'footnoteReference': {
      context.usedFootnotes.add(normalizeIdentifier(node.identifier));
      return `[${escapeTelegramHtml(node.label ?? node.identifier)}]`;
    }
    case 'definition':
    case 'footnoteDefinition':
      return '';
    case 'image':
      return escapeTelegramHtml(node.alt ?? '');
    case 'imageReference':
      return escapeTelegramHtml(node.alt ?? '');
    case 'heading':
      return `<b>${renderInline(node.children, context)}</b>`;
    case 'paragraph':
      return renderInline(node.children, context);
    case 'break':
      return '\n';
    case 'blockquote':
      return `<blockquote>${node.children.map((child) => renderNode(child, context)).join('\n\n')}</blockquote>`;
    case 'list':
      return node.children
        .map((item, index) => {
          const bullet = node.ordered ? `${(node.start ?? 1) + index}. ` : '• ';
          const checkbox = item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
          const prefix = bullet + checkbox;
          const body = item.children.map((child) => renderNode(child, context)).join('\n');
          return prefix + body.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
        })
        .join('\n');
    case 'table':
      return `<pre>${escapeTelegramHtml(renderTable(node.children))}</pre>`;
    case 'thematicBreak':
      return '──────────';
    case 'html':
      return escapeTelegramHtml(node.value);
    default:
      if ('value' in node && typeof node.value === 'string') return escapeTelegramHtml(node.value);
      if ('children' in node && Array.isArray(node.children))
        return node.children.map((child) => renderNode(child, context)).join('');
      return '';
  }
}

function renderFootnotes(context: RenderContext): string[] {
  const rendered: string[] = [];
  for (const identifier of context.usedFootnotes) {
    const definition = context.footnotes.get(identifier);
    if (!definition) continue;
    const label = escapeTelegramHtml(definition.label ?? definition.identifier);
    rendered.push(
      `[${label}] ${definition.children.map((child) => renderNode(child, context)).join('\n\n')}`
    );
  }
  return rendered;
}

function renderRoot(root: Root, context: RenderContext, includeFootnotes: boolean): string {
  const body = root.children
    .map((node) => renderNode(node, context))
    .filter(Boolean)
    .join('\n\n');
  const footnotes = includeFootnotes ? renderFootnotes(context).join('\n\n') : '';
  return [body, footnotes].filter(Boolean).join('\n\n');
}

export function telegramHtmlVisibleLength(html: string): number {
  return html.replace(/<[^>]*>/gu, '').replace(/&(?:amp|lt|gt|quot);/gu, 'x').length;
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';
  const root = parser.parse(markdown) as Root;
  return renderRoot(root, createRenderContext(root), true);
}

export function telegramTextChunks(
  markdown: string,
  format: 'html' | 'plain' = 'html'
): TelegramTextChunk[] {
  if (format === 'plain')
    return splitMessage(markdown, 4096).map((plainText) => ({ text: plainText, plainText }));
  try {
    const chunks = splitTelegramMarkdown(markdown);
    if (chunks.length <= 1) return chunks.map((chunk) => formatTelegramChunk(chunk));
    const root = parser.parse(markdown) as Root;
    const context = createRenderContext(root);
    const definitionsSource = root.children
      .filter((node) => node.type === 'definition' || node.type === 'footnoteDefinition')
      .map((node) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        return start === undefined || end === undefined ? '' : markdown.slice(start, end);
      })
      .filter(Boolean)
      .join('\n\n');
    const formatted = chunks
      .map((plainText) => {
        const source = definitionsSource ? `${plainText}\n\n${definitionsSource}` : plainText;
        const html = renderRoot(parser.parse(source) as Root, context, false);
        if (!html) return undefined;
        return telegramHtmlVisibleLength(html) <= 4096
          ? { text: html, plainText, parseMode: 'HTML' as const }
          : { text: plainText, plainText };
      })
      .filter((chunk): chunk is TelegramTextChunk => chunk !== undefined);
    for (const footnote of renderFootnotes(context)) {
      const plainText = footnote
        .replace(/<[^>]*>/gu, '')
        .replace(/&quot;/gu, '"')
        .replace(/&gt;/gu, '>')
        .replace(/&lt;/gu, '<')
        .replace(/&amp;/gu, '&');
      if (telegramHtmlVisibleLength(footnote) <= 4096) {
        const previous = formatted.at(-1);
        const combined = previous?.parseMode === 'HTML' ? `${previous.text}\n\n${footnote}` : '';
        if (previous && combined && telegramHtmlVisibleLength(combined) <= 4096) {
          previous.text = combined;
          previous.plainText += `\n\n${plainText}`;
        } else {
          formatted.push({ text: footnote, plainText, parseMode: 'HTML' });
        }
      } else {
        formatted.push(...splitMessage(plainText, 4096).map((text) => ({ text, plainText: text })));
      }
    }
    return formatted;
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
    return telegramHtmlVisibleLength(html) <= 4096
      ? { text: html || escapeTelegramHtml(plainText), plainText, parseMode: 'HTML' }
      : { text: plainText, plainText };
  } catch {
    return { text: plainText, plainText };
  }
}
