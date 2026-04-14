/**
 * ワークスペースコンテキスト（AGENTS.md, MEMORY.md）の読み込み
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// CLAUDE.md is typically a symlink to AGENTS.md, so only read AGENTS.md to avoid duplication
const CONTEXT_FILES = ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md'];

export function loadWorkspaceContext(workspace: string): string {
  const parts: string[] = [];

  for (const file of CONTEXT_FILES) {
    const filePath = join(workspace, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim()) {
          parts.push(`## ${file}\n${content}`);
        }
      } catch {
        // ignore read errors
      }
    }
  }

  return parts.join('\n\n');
}
