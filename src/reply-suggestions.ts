const START = '<xangi_reply_suggestions>';
const END = '</xangi_reply_suggestions>';

interface ReplySuggestionBlock {
  start: number;
  end: number;
  raw: string | null;
}

interface ReplySuggestionCloser {
  closeIndex: number;
  blockEnd: number;
}

function lineStartAt(output: string, index: number): number {
  return output.lastIndexOf('\n', index - 1) + 1;
}

function isStandaloneMarker(output: string, index: number): boolean {
  return output.slice(lineStartAt(output, index), index).trim() === '';
}

function skipWhitespace(output: string, index: number): number {
  let next = index;
  while (next < output.length && /\s/.test(output[next])) next++;
  return next;
}

/** JSON文字列内の `]` を無視して、ルート配列の終端直後を返す。 */
function findJsonArrayEnd(output: string, start: number): number | null {
  if (output[start] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index++) {
    const char = output[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

/** 終了タグから行末までが空白だけなら、次の行の先頭位置を返す。 */
function standaloneBlockEnd(output: string, index: number): number | null {
  const newlineIndex = output.indexOf('\n', index);
  const lineEnd = newlineIndex < 0 ? output.length : newlineIndex;
  if (output.slice(index, lineEnd).trim() !== '') return null;
  return newlineIndex < 0 ? output.length : newlineIndex + 1;
}

function findStandaloneClosers(output: string): ReplySuggestionCloser[] {
  const closers: ReplySuggestionCloser[] = [];
  let searchFrom = 0;
  for (;;) {
    const closeIndex = output.indexOf(END, searchFrom);
    if (closeIndex < 0) return closers;
    const blockEnd = standaloneBlockEnd(output, closeIndex + END.length);
    if (blockEnd !== null) closers.push({ closeIndex, blockEnd });
    searchFrom = closeIndex + END.length;
  }
}

function findStandaloneMarkers(output: string): number[] {
  const markers: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const markerIndex = output.indexOf(START, searchFrom);
    if (markerIndex < 0) return markers;
    if (isStandaloneMarker(output, markerIndex)) markers.push(markerIndex);
    searchFrom = markerIndex + START.length;
  }
}

/** 独立行を占める完全ブロックと、ストリーミング中の未完ブロックを抽出する。 */
function findInternalBlocks(output: string): ReplySuggestionBlock[] {
  const blocks: ReplySuggestionBlock[] = [];
  const markers = findStandaloneMarkers(output);
  const closers = findStandaloneClosers(output);
  let markerNumber = 0;
  let closerNumber = 0;
  while (markerNumber < markers.length) {
    const markerIndex = markers[markerNumber];
    const nextMarkerIndex = markers[markerNumber + 1] ?? output.length;

    const markerContentStart = markerIndex + START.length;
    const markerNewline = output.indexOf('\n', markerContentStart);
    const markerLineEnd = markerNewline < 0 ? output.length : markerNewline;
    const markerLineTail = output.slice(markerContentStart, markerLineEnd);
    const payloadStart = skipWhitespace(output, markerContentStart);
    const startsJsonArray = output[payloadStart] === '[';
    const jsonArrayEnd = startsJsonArray ? findJsonArrayEnd(output, payloadStart) : null;
    const isInternalCandidate = startsJsonArray || markerLineTail.trim() === '';

    if (startsJsonArray) {
      const jsonEnd = jsonArrayEnd;
      const closeIndex = jsonEnd === null ? -1 : skipWhitespace(output, jsonEnd);
      if (jsonEnd !== null && output.startsWith(END, closeIndex)) {
        const blockEnd = standaloneBlockEnd(output, closeIndex + END.length);
        if (blockEnd !== null) {
          blocks.push({
            start: lineStartAt(output, markerIndex),
            end: blockEnd,
            raw: output.slice(payloadStart, jsonEnd),
          });
          markerNumber++;
          while (markerNumber < markers.length && markers[markerNumber] < blockEnd) markerNumber++;
          continue;
        }
        // 終了タグ後に同じ行の文章が続く場合は、本文中の引用として保持する。
        markerNumber++;
        continue;
      }
    }

    while (closerNumber < closers.length && closers[closerNumber].closeIndex < markerContentStart)
      closerNumber++;
    let nextCloserNumber = closerNumber;
    let fallback: ReplySuggestionCloser | null = null;
    while (
      nextCloserNumber < closers.length &&
      closers[nextCloserNumber].closeIndex < nextMarkerIndex
    ) {
      fallback = closers[nextCloserNumber];
      nextCloserNumber++;
    }
    closerNumber = nextCloserNumber;

    // 壊れたブロックは次の開始タグを越えず、範囲内の最後の独立終了タグまで隠す。
    if (fallback !== null) {
      blocks.push({
        start: lineStartAt(output, markerIndex),
        end: fallback.blockEnd,
        raw: null,
      });
      markerNumber++;
      while (markerNumber < markers.length && markers[markerNumber] < fallback.blockEnd)
        markerNumber++;
      continue;
    }

    if (jsonArrayEnd !== null) {
      // 終了タグが未到着・途中・壊れている場合も、独立行で始まった候補は隠す。
      blocks.push({ start: lineStartAt(output, markerIndex), end: output.length, raw: null });
      break;
    }

    if (isInternalCandidate && (!startsJsonArray || jsonArrayEnd === null)) {
      // 配列が未完、または開始タグだけの行なら、最初の未完ブロック以降を隠す。
      blocks.push({ start: lineStartAt(output, markerIndex), end: output.length, raw: null });
      break;
    }

    // JSON配列の例やタグの説明として完結している本文は保持する。
    markerNumber++;
  }
  return blocks;
}

function removeBlocks(output: string, blocks: ReplySuggestionBlock[]): string {
  let cursor = 0;
  let result = '';
  for (const block of blocks) {
    result += output.slice(cursor, block.start);
    cursor = block.end;
  }
  return result + output.slice(cursor);
}

export function appendReplySuggestionInstruction(prompt: string, count = 3): string {
  const example = Array.from({ length: count }, (_, index) => `候補${index + 1}`);
  return `${prompt}\n\n[system-context]\n通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を${count}件生成してください。出力の末尾に次の形式を厳密に付け、通常の回答本文では候補に言及しないでください。候補はユーザー視点の自然な日本語にしてください。\n${START}${JSON.stringify(example)}${END}`;
}

export function extractReplySuggestions(
  output: string,
  count = 3
): {
  text: string;
  suggestions: string[];
} {
  const blocks = findInternalBlocks(output);
  let suggestions: string[] = [];
  for (const block of blocks) {
    if (block.raw === null) continue;
    try {
      const parsed = JSON.parse(block.raw);
      if (Array.isArray(parsed)) {
        suggestions = parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .slice(0, count);
      }
    } catch {
      // 壊れた候補ブロックはユーザーへ見せず、候補なしとして扱う。
    }
  }
  const text = removeBlocks(output, blocks).trimEnd();
  return { text: stripReplySuggestionMarkup(text), suggestions };
}

/** 候補機能がOFFでも内部タグを除去し、候補自体は公開しない。 */
export function sanitizeReplySuggestionOutput(
  output: string,
  enabled: boolean,
  count = 3
): {
  text: string;
  suggestions: string[];
} {
  const extracted = extractReplySuggestions(output, count);
  if (!enabled) extracted.suggestions = [];
  return extracted;
}

// 開始タグの断片を隠すときの最小一致長。これ未満（`<` 単体など）は本文として扱う。
const MARKER_PREFIX = '<xangi_';

/** 独立行の完全・未完ブロックだけを隠し、本文中のインライン引用は保持する。 */
export function stripReplySuggestionMarkup(output: string): string {
  let visible = removeBlocks(output, findInternalBlocks(output));

  // 開始タグが途中まで届いた時点でも、十分長い独立行の断片だけを隠す。
  const trailingWhitespaceStart = visible.search(/\s*$/);
  const contentEnd = trailingWhitespaceStart < 0 ? visible.length : trailingWhitespaceStart;
  for (let len = START.length - 1; len >= MARKER_PREFIX.length; len--) {
    if (!visible.slice(0, contentEnd).endsWith(START.slice(0, len))) continue;
    const fragmentIndex = contentEnd - len;
    if (isStandaloneMarker(visible, fragmentIndex)) {
      visible = visible.slice(0, lineStartAt(visible, fragmentIndex));
    }
    break;
  }
  return visible.trimEnd();
}

export function formatNumberedSuggestions(suggestions: string[]): string {
  return suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join('\n');
}

export function resolveReplySuggestionSkipPermissions(
  skipPermissions: boolean | undefined
): boolean {
  return skipPermissions ?? false;
}

export function fallbackReplySuggestions(count = 3): string[] {
  return [
    'もう少し詳しく教えて',
    'その方針で進めて',
    '別の案も見せて',
    '具体例を見せて',
    '注意点を教えて',
  ].slice(0, count);
}
