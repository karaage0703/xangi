import { useEffect, useState } from 'react';
import { HISTORY_EVENT, historyAvailability, goHistory } from './appHistory';

export function HistoryControls({
  includeFrameHistory = false,
}: {
  includeFrameHistory?: boolean;
}) {
  const [available, setAvailable] = useState(historyAvailability);
  useEffect(() => {
    const update = () => setAvailable(historyAvailability());
    window.addEventListener(HISTORY_EVENT, update);
    return () => window.removeEventListener(HISTORY_EVENT, update);
  }, []);
  // Navigation.canGoBack/Forward omit child-frame session-history entries.
  // With embedded content, keep native joint-history traversal reachable.
  return (
    <nav className="history-controls" aria-label="画面の履歴">
      <button
        type="button"
        aria-label="戻る"
        title="戻る"
        disabled={!includeFrameHistory && !available.back}
        onClick={() => goHistory(-1)}
      >
        ←
      </button>
      <button
        type="button"
        aria-label="進む"
        title="進む"
        disabled={!includeFrameHistory && !available.forward}
        onClick={() => goHistory(1)}
      >
        →
      </button>
    </nav>
  );
}
