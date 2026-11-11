import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppNavigation, DESTINATIONS } from '../web-ui/src/AppNavigation.js';
import { ThemeControl } from '../web-ui/src/ThemeSelect.js';

describe('AppNavigation', () => {
  it('keeps primary destinations separate from overflow destinations', () => {
    expect(DESTINATIONS.filter((destination) => destination.placement === 'primary')).toEqual([
      expect.objectContaining({ id: 'chat', href: '/' }),
      expect.objectContaining({ id: 'workspace', href: '/workspace' }),
      expect.objectContaining({ id: 'monitor', href: '/monitor' }),
    ]);
    expect(DESTINATIONS.filter((destination) => destination.placement === 'secondary')).toEqual([
      expect.objectContaining({ id: 'schedules', href: '/schedules' }),
      expect.objectContaining({ id: 'extensions', href: '/extensions' }),
      expect.objectContaining({ id: 'settings', href: '/settings' }),
    ]);
  });

  it('renders saved shortcuts in order and sends unavailable entries to the catalog', () => {
    const html = renderToStaticMarkup(createElement(AppNavigation, {
      current: 'extensions', moreOpen: false, onMore: () => undefined,
      favorites: [{ id: 'studio', displayName: 'Studio', available: true }, { id: 'gone', displayName: 'Gone', available: false }],
    }));
    expect(html).toContain('href="/api/extensions/studio/ui"');
    expect(html.indexOf('Studio')).toBeLessThan(html.indexOf('Gone'));
    expect(html).toContain('拡張一覧で状態を確認');
  });

  it('hides opted-out favorites and the empty rail group, including mobile links', async () => {
    const { FavoriteLinks } = await import('../web-ui/src/extensionFavorites.js');
    const favorites = [
      { id: 'hidden', displayName: 'Hidden', available: true, showInSidebar: false },
      { id: 'shown', displayName: 'Shown', available: true, showInSidebar: true },
    ];
    const props = { current: 'extensions' as const, moreOpen: false, onMore: () => undefined };
    const rail = renderToStaticMarkup(createElement(AppNavigation, { ...props, favorites }));
    const mobile = renderToStaticMarkup(createElement(FavoriteLinks, { favorites }));
    for (const html of [rail, mobile]) {
      expect(html).not.toContain('/api/extensions/hidden/ui');
      expect(html).toContain('/api/extensions/shown/ui');
    }
    const empty = renderToStaticMarkup(createElement(AppNavigation, { ...props, favorites: favorites.slice(0, 1) }));
    expect(empty).not.toContain('app-navigation-favorites');
  });

  it('marks the current destination and exposes the mobile more control', () => {
    const html = renderToStaticMarkup(
      createElement(AppNavigation, {
        current: 'extensions',
        moreOpen: false,
        onMore: () => undefined,
      })
    );

    expect(html).toContain('aria-label="xangiの主要機能"');
    expect(html).toContain('href="/extensions"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-controls="app-more-sheet"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('その他');
  });

  it('only marks more active for destinations contained in the more menu', () => {
    const monitor = renderToStaticMarkup(
      createElement(AppNavigation, {
        current: 'monitor',
        moreOpen: false,
        onMore: () => undefined,
      })
    );
    const extensions = renderToStaticMarkup(
      createElement(AppNavigation, {
        current: 'extensions',
        moreOpen: false,
        onMore: () => undefined,
      })
    );

    expect(monitor).toMatch(/<a class="active" aria-current="page" href="\/monitor">/);
    expect(monitor).toContain('class="app-more-trigger"');
    expect(extensions).toContain('class="app-more-trigger active"');
  });

  it('keeps the shared navigation fixed instead of overriding it per page', () => {
    const styles = readFileSync(new URL('../web-ui/src/styles.css', import.meta.url), 'utf8');
    const monitorOverride = styles.match(/\.monitor-page\s*>\s*\.app-topbar\s*\{([^}]*)\}/)?.[1];

    expect(styles).toMatch(/\.app-topbar\s*\{[\s\S]*?position:\s*fixed;/);
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.app-topbar\s*\{[\s\S]*?inset:\s*auto 0 0;/
    );
    expect(monitorOverride).toBeUndefined();
  });

  it('keeps the workspace toolbar compact and gives remaining height to the browser', () => {
    const styles = readFileSync(new URL('../web-ui/src/styles.css', import.meta.url), 'utf8');
    const workspaceShell = styles.match(/\.workspace-browser-shell\s*\{([^}]*)\}/)?.[1];

    expect(workspaceShell).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\);/);
    expect(workspaceShell).toMatch(/height:\s*100dvh/);
  });

  it('uses a compact theme menu in the rail and direct choices in the mobile sheet', () => {
    const rail = renderToStaticMarkup(
      createElement(ThemeControl, {
        variant: 'rail',
        preference: 'system',
        onChange: () => undefined,
      })
    );
    const sheet = renderToStaticMarkup(
      createElement(ThemeControl, {
        variant: 'sheet',
        preference: 'dark',
        onChange: () => undefined,
      })
    );

    expect(rail).toContain('aria-label="表示テーマ: 端末設定"');
    expect(rail).toContain('aria-haspopup="true"');
    expect(rail).toContain('aria-expanded="false"');
    expect(rail).not.toContain('<select');
    expect(sheet).toContain('aria-label="表示テーマ"');
    expect(sheet).toContain('端末設定');
    expect(sheet).toContain('ライト');
    expect(sheet).toContain('ダーク');
    expect(sheet).toContain('aria-pressed="true"');
    expect(sheet).not.toContain('<select');
  });
});
