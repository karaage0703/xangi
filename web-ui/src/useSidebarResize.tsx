import { useEffect, useRef, useState } from 'react';

const WIDTH_KEY = 'xangi-chat-sidebar-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const COMPACT_QUERY = '(max-width: 768px), (max-height: 500px) and (hover: none)';

function readWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? Math.min(560, value) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Resizing still works when browser storage is unavailable.
  }
}

export function useSidebarResize(enabled: boolean) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    previous: number;
    current: number;
    handle: HTMLDivElement;
  } | null>(null);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(560, viewportWidth - 360));
  const width = Math.max(MIN_WIDTH, Math.min(preferredWidth, maxWidth));
  const clamp = (value: number) => Math.round(Math.max(MIN_WIDTH, Math.min(value, maxWidth)));

  const finish = (cancelled: boolean) => {
    const previous = drag.current;
    if (!previous) return;
    cancelled ||= window.innerWidth !== viewportWidth || window.matchMedia(COMPACT_QUERY).matches;
    drag.current = null;
    if (cancelled) setPreferredWidth(previous.previous);
    else saveWidth(previous.current);
    setResizing(false);
    if (previous.handle.hasPointerCapture(previous.id))
      previous.handle.releasePointerCapture(previous.id);
  };

  useEffect(() => {
    const update = () => {
      // A viewport change cancels a drag but never replaces the saved desktop preference.
      const previous = drag.current;
      if (previous) {
        drag.current = null;
        setPreferredWidth(previous.previous);
        setResizing(false);
        if (previous.handle.hasPointerCapture(previous.id))
          previous.handle.releasePointerCapture(previous.id);
      }
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!enabled && drag.current) {
      const previous = drag.current;
      drag.current = null;
      setPreferredWidth(previous.previous);
      setResizing(false);
      if (previous.handle.hasPointerCapture(previous.id))
        previous.handle.releasePointerCapture(previous.id);
    }
  }, [enabled]);

  const handle = enabled ? (
    <div
      className="chat-sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label="サイドバーの幅"
      aria-orientation="vertical"
      aria-controls="chat-sidebar"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-valuetext={`${width}px`}
      title="ドラッグまたは左右キーで幅を変更。ダブルクリックで標準幅に戻す"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || window.matchMedia(COMPACT_QUERY).matches)
          return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          width,
          previous: preferredWidth,
          current: width,
          handle: event.currentTarget,
        };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        active.current = clamp(active.width + event.clientX - active.x);
        setPreferredWidth(active.current);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id === event.pointerId) finish(false);
      }}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => {
        setPreferredWidth(DEFAULT_WIDTH);
        saveWidth(DEFAULT_WIDTH);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          return;
        }
        if (drag.current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = clamp(
          event.key === 'Home'
            ? MIN_WIDTH
            : event.key === 'End'
              ? maxWidth
              : width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10)
        );
        setPreferredWidth(next);
        saveWidth(next);
      }}
    />
  ) : null;

  return { width, resizing, handle };
}
