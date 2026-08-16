import { useCallback, useEffect, useRef, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'xangi-theme';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '端末設定' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
];

function storedTheme(): ThemePreference {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

function themeLabel(preference: ThemePreference): string {
  return THEME_OPTIONS.find((option) => option.value === preference)?.label ?? '端末設定';
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  if (preference === 'light') {
    return (
      <>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.4-6.4L17 7m-10 10-1.4 1.4m12.8 0L17 17M7 7 5.6 5.6" />
      </>
    );
  }
  if (preference === 'dark') {
    return <path d="M18.5 15.5A7.5 7.5 0 0 1 8.5 5.4a7.5 7.5 0 1 0 10 10.1Z" />;
  }
  return <path d="M4 5.5h16v11H4v-11Zm5 15h6m-3-4v4" />;
}

export function initializeTheme(): void {
  applyTheme(storedTheme());
}

export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(storedTheme);

  useEffect(() => {
    applyTheme(preference);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (preference === 'system') applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const choosePreference = useCallback((next: ThemePreference) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setPreference(next);
  }, []);

  return [preference, choosePreference];
}

function ThemeOptions({
  preference,
  onChange,
  variant,
}: {
  preference: ThemePreference;
  onChange: (preference: ThemePreference) => void;
  variant: 'menu' | 'sheet';
}) {
  return (
    <div className={`theme-options theme-options--${variant}`} role="group" aria-label="表示テーマ">
      {THEME_OPTIONS.map((option) => (
        <button
          className={preference === option.value ? 'selected' : ''}
          type="button"
          aria-pressed={preference === option.value}
          onClick={() => onChange(option.value)}
          key={option.value}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <ThemeIcon preference={option.value} />
          </svg>
          <span>{option.label}</span>
          {variant === 'menu' ? (
            <span className="theme-option-check" aria-hidden="true">
              {preference === option.value ? '✓' : ''}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function ThemeControl({
  variant,
  preference,
  onChange,
}: {
  variant: 'rail' | 'sheet';
  preference: ThemePreference;
  onChange: (preference: ThemePreference) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  if (variant === 'sheet') {
    return (
      <section className="theme-control theme-control--sheet" aria-labelledby="theme-sheet-label">
        <h3 id="theme-sheet-label">表示テーマ</h3>
        <ThemeOptions preference={preference} onChange={onChange} variant="sheet" />
      </section>
    );
  }

  return (
    <div className="theme-control theme-control--rail" ref={containerRef}>
      <button
        className="theme-trigger"
        type="button"
        aria-label={`表示テーマ: ${themeLabel(preference)}`}
        aria-haspopup="true"
        aria-expanded={menuOpen}
        aria-controls="theme-menu"
        onClick={() => setMenuOpen((open) => !open)}
        ref={triggerRef}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <ThemeIcon preference={preference} />
        </svg>
        <span>表示</span>
      </button>
      {menuOpen ? (
        <div className="theme-menu" id="theme-menu">
          <ThemeOptions
            preference={preference}
            onChange={(next) => {
              onChange(next);
              setMenuOpen(false);
              triggerRef.current?.focus();
            }}
            variant="menu"
          />
        </div>
      ) : null}
    </div>
  );
}
