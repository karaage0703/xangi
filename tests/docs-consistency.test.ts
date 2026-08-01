import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = process.cwd();

const DOC_PAIRS = [
  'design.md',
  'discord-setup.md',
  'events.md',
  'inter-instance-chat.md',
  'line-setup.md',
  'slack-setup.md',
  'telegram-setup.md',
  'usage.md',
];

const MARKDOWN_FILES = [
  'README.md',
  'README.en.md',
  ...DOC_PAIRS.flatMap((name) => [`docs/${name}`, `docs/en/${name}`]),
];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function proseOnly(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

describe('documentation consistency', () => {
  it('keeps every Japanese and English document linked in both directions', () => {
    for (const name of DOC_PAIRS) {
      expect(readRepoFile(`docs/${name}`)).toContain(`[English](en/${name})`);
      expect(readRepoFile(`docs/en/${name}`)).toContain(`[日本語](../${name})`);
    }
  });

  it('resolves every local Markdown link target', () => {
    const missing: string[] = [];

    for (const file of MARKDOWN_FILES) {
      const markdown = proseOnly(readRepoFile(file));
      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const href = match[1].trim().replace(/^<|>$/g, '');
        if (/^(?:https?:|mailto:|#)/.test(href)) continue;
        const target = decodeURIComponent(href.split('#', 1)[0]);
        if (!existsSync(resolve(repoRoot, dirname(file), target))) {
          missing.push(`${file}: ${href}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('documents every event platform and the timeout event emitted by the runtime', () => {
    const source = readRepoFile('src/events-emitter.ts');
    const webChatSource = readRepoFile('src/web-chat.ts');
    const platformDeclaration = source.match(/export type Platform = ([^;]+);/)?.[1] ?? '';
    const platforms = [...platformDeclaration.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(platforms).not.toEqual([]);
    expect(webChatSource).toContain('events.timeoutExtended(');
    expect(webChatSource).not.toContain('events.timeoutStarted(');
    expect(webChatSource).not.toContain('events.timeoutCleared(');
    for (const file of ['docs/events.md', 'docs/en/events.md']) {
      const docs = readRepoFile(file);
      for (const platform of platforms) expect(docs.toLowerCase()).toContain(platform);
      expect(docs).toContain('timeout.extended');
      expect(docs).not.toContain('timeout.started');
      expect(docs).not.toContain('timeout.cleared');
    }
  });

  it('keeps the README focused on entry points instead of internal xangi-cmd operations', () => {
    for (const file of ['README.md', 'README.en.md']) {
      const readme = readRepoFile(file);
      expect(readme.split('\n').length).toBeLessThan(180);
      expect(readme).not.toContain('xangi-cmd schedule_');
      expect(readme).not.toContain('xangi-cmd discord_');
    }
  });
});
