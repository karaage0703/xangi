import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

/** Keep the newest stream state; render at most every 50ms (250ms in background). */
export function useBufferedState<T>(
  initial: T
): [T, (next: SetStateAction<T>) => void, () => void] {
  const [value, setValue] = useState(initial);
  const latest = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setValue(latest.current);
  }, []);
  const update = useCallback(
    (next: SetStateAction<T>) => {
      latest.current =
        typeof next === 'function' ? (next as (previous: T) => T)(latest.current) : next;
      if (latest.current === undefined || latest.current === '') flush();
      else timer.current ??= setTimeout(flush, document.hidden ? 250 : 50);
    },
    [flush]
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return [value, update, flush];
}
