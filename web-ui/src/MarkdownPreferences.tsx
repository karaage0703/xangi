import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'xangi-markdown-breaks';

const MarkdownPreferencesContext = createContext({
  lineBreaks: true,
  setLineBreaks: (_enabled: boolean): boolean => false,
});

function storedLineBreaks(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function MarkdownPreferencesProvider({ children }: { children: ReactNode }) {
  const [lineBreaks, setLineBreaks] = useState(storedLineBreaks);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setLineBreaks(storedLineBreaks());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const chooseLineBreaks = useCallback((enabled: boolean): boolean => {
    setLineBreaks(enabled);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(enabled));
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <MarkdownPreferencesContext.Provider value={{ lineBreaks, setLineBreaks: chooseLineBreaks }}>
      {children}
    </MarkdownPreferencesContext.Provider>
  );
}

export function useMarkdownPreferences() {
  return useContext(MarkdownPreferencesContext);
}

export function MarkdownDisplaySettings() {
  const { lineBreaks, setLineBreaks } = useMarkdownPreferences();
  const [saveFailed, setSaveFailed] = useState(false);

  return (
    <section
      id="display"
      className="settings-card"
      aria-labelledby="settings-display-title"
      tabIndex={-1}
    >
      <div className="settings-card-heading">
        <div>
          <h2 id="settings-display-title">表示</h2>
          <p>このブラウザに保存し、チャットとファイルプレビューに即時反映します。</p>
        </div>
      </div>
      <div className="settings-row">
        <div>
          <label htmlFor="markdown-breaks-setting">Markdownの改行をそのまま表示</label>
          <p id="markdown-breaks-description">
            ON（既定）では1回の改行も表示します。OFFでは段落内の改行を空白として表示します。
            コードブロックや原文は変わりません。
          </p>
        </div>
        <select
          id="markdown-breaks-setting"
          aria-describedby="markdown-breaks-description"
          value={lineBreaks ? 'on' : 'off'}
          onChange={(event) => setSaveFailed(!setLineBreaks(event.target.value === 'on'))}
        >
          <option value="on">ON</option>
          <option value="off">OFF</option>
        </select>
      </div>
      {saveFailed ? (
        <p className="settings-status error" role="status">
          このブラウザに保存できません。現在の画面にのみ反映しています。
        </p>
      ) : null}
    </section>
  );
}
