import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('settings UI', () => {
  it('keeps backend fields and the save button the same explicit height in embedded webviews', () => {
    const styles = readFileSync(new URL('../web-ui/src/styles.css', import.meta.url), 'utf8');
    const fields = styles.match(
      /\.settings-backend-form input,\s*\.settings-backend-form select,\s*\.settings-row select\s*\{([^}]*)\}/s
    )?.[1];
    const button = styles.match(/\.settings-backend-form button\s*\{([^}]*)\}/s)?.[1];

    expect(fields).toMatch(/^\s*height:\s*44px;/m);
    expect(button).toMatch(/^\s*height:\s*44px;/m);
  });

  it('uses a select when model discovery returns choices and exposes workspace management', () => {
    const source = readFileSync(new URL('../web-ui/src/Settings.tsx', import.meta.url), 'utf8');

    expect(source).toContain('models?.models.length ? (');
    expect(source).toContain('<option value="">バックエンド既定</option>');
    expect(source).toContain('aria-labelledby="settings-workspace-title"');
    expect(source).toContain("getJson<{ workspaces: RegisteredWorkspace[] }>('/api/workspaces')");
    expect(source).toContain('Workspaceの登録を解除');
  });
});
