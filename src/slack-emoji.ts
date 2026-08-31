import { emojify } from 'node-emoji';

/** Render Slack-style standard emoji aliases while leaving Markdown code untouched. */
export function renderSlackEmojiAliases(markdown: string): string {
  let result = '';
  let plainStart = 0;
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] !== '`') {
      index += 1;
      continue;
    }

    let fenceEnd = index + 1;
    while (markdown[fenceEnd] === '`') fenceEnd += 1;
    const fence = markdown.slice(index, fenceEnd);
    const closing = markdown.indexOf(fence, fenceEnd);
    if (closing < 0) {
      index = fenceEnd;
      continue;
    }

    result += emojify(markdown.slice(plainStart, index));
    const codeEnd = closing + fence.length;
    result += markdown.slice(index, codeEnd);
    index = codeEnd;
    plainStart = codeEnd;
  }

  return result + emojify(markdown.slice(plainStart));
}
