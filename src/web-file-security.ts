import { isAbsolute } from 'path';
import { realFileWithinRoots } from './file-utils.js';

export function isRealFileWithin(root: string, target: string): boolean {
  return isAbsolute(target) && realFileWithinRoots(target, [root]) !== null;
}

export function parseDisplayedUserAttachments(
  content: string,
  allowedRoots: string[]
): { content: string; attachments: string[] } {
  const attachments: string[] = [];
  const displayLines: string[] = [];
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\[添付ファイル\](?:[ \t]+(.+?))?[ \t]*$/);
    if (!marker) {
      displayLines.push(line);
      continue;
    }

    const candidates: string[] = [];
    if (marker[1]) candidates.push(marker[1].trim());

    while (index + 1 < lines.length) {
      const bullet = lines[index + 1].match(/^[ \t]*-[ \t]+(.+?)[ \t]*$/);
      if (!bullet) break;
      index += 1;
      candidates.push(bullet[1].trim());
    }

    for (const candidate of candidates) {
      if (
        allowedRoots.some((root) => isRealFileWithin(root, candidate)) &&
        !attachments.includes(candidate)
      ) {
        attachments.push(candidate);
      }
    }
  }

  return {
    content: displayLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    attachments,
  };
}
