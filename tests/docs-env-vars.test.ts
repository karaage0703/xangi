import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

const SETUP_DOCS = [
  'docs/discord-setup.md',
  'docs/en/discord-setup.md',
  'docs/slack-setup.md',
  'docs/en/slack-setup.md',
  'docs/line-setup.md',
  'docs/en/line-setup.md',
];

const ENV_NAME_PATTERN =
  /\b(?:ALLOWED_USER|(?:[A-Z0-9]+_)+(?:TOKEN|SECRET|ALLOWED_USER|WEBHOOK_PATH|WEBHOOK_PORT))\b/g;

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function extractEnvNames(text: string): Set<string> {
  return new Set(text.match(ENV_NAME_PATTERN) ?? []);
}

function extractKnownEnvNames(): Set<string> {
  const names = new Set<string>();

  const envExample = readRepoFile('.env.example');
  for (const match of envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    names.add(match[1]);
  }

  const sourceFiles = [
    'src/config.ts',
    'src/index.ts',
    'src/line.ts',
    'src/events-emitter.ts',
    'src/pet-inbox-server.ts',
    'src/even-terminal-server.ts',
  ];
  for (const file of sourceFiles) {
    const source = readRepoFile(file);
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      names.add(match[1]);
    }
  }

  return names;
}

describe('setup docs environment variables', () => {
  it('refer only to env names that exist in .env.example or runtime config', () => {
    const knownEnvNames = extractKnownEnvNames();
    const unknown: string[] = [];

    for (const file of SETUP_DOCS) {
      const envNames = extractEnvNames(readRepoFile(file));
      for (const name of envNames) {
        if (!knownEnvNames.has(name)) {
          unknown.push(`${file}: ${name}`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });
});
