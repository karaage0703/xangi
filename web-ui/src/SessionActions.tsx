import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function SessionActions({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ above: false, height: 280 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className={`session-action-menu${open ? ' is-open' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="session-actions-trigger"
        aria-label={`${title}の操作`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          const rect = root.current?.getBoundingClientRect();
          const scroll = root.current?.closest('.sidebar-scroll')?.getBoundingClientRect();
          if (rect && scroll) {
            const below = scroll.bottom - rect.bottom - 4;
            const above = rect.top - scroll.top - 4;
            setPlacement({
              above: below < 240 && above > below,
              height: Math.max(44, Math.min(280, Math.max(above, below))),
            });
          }
          setOpen((value) => !value);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </svg>
      </button>
      <div
        id={id}
        className={`session-actions${placement.above ? ' above' : ''}`}
        style={{ maxHeight: placement.height }}
        role="group"
        aria-label={`${title}の操作一覧`}
        onClick={(event) => {
          if ((event.target as Element).closest('button')) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
