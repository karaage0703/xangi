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
});
