import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe('Web UI dialogs', () => {
  it('does not use browser blocking dialogs that silently fail in embedded WKWebView', () => {
    const webUiRoot = join(process.cwd(), 'web-ui', 'src');
    const offenders = sourceFiles(webUiRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return (
        source
          .match(/\b(?:(?:window|globalThis)\.)?(?:alert|confirm|prompt)\s*\(/g)
          ?.map((match) => ({
            path: path.slice(process.cwd().length + 1),
            match,
          })) ?? []
      );
    });

    expect(offenders).toEqual([]);
  });

  it('keeps confirmation, text input, and inline error feedback in the page', () => {
    const chatSource = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Chat.tsx'), 'utf8');
    const schedulesSource = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'Schedules.tsx'),
      'utf8'
    );
    const dialogSource = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'ConfirmDialog.tsx'),
      'utf8'
    );

    expect(dialogSource).toContain('export function TextInputDialog');
    expect(chatSource).toContain('title="メッセージを削除"');
    expect(chatSource).toContain('title="セッション名を変更"');
    expect(chatSource).toContain('title="xangiを再起動"');
    expect(chatSource).toContain('title="応答中のペインを閉じる"');
    expect(chatSource).toContain('setError(result.rejected.map');
    expect(schedulesSource).toContain('title="スケジュールを削除"');
  });
});
