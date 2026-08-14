import {
  type CSSProperties,
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, getJson, requestJson, workspaceFileUrl } from './api';
import { AppTopbar } from './AppTopbar';
import {
  lineSelection,
  workspaceParentPath,
  workspaceTargetFromSearch,
  workspaceViewerUrl,
} from './workspace-navigation';

const MarkdownBody = lazy(() => import('./MarkdownBody'));

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  mtimeMs: number;
  tags?: string[];
}

interface WorkspaceDirectory {
  path: string;
  parent: string | null;
  entries: WorkspaceEntry[];
}

interface WorkspaceFile {
  path: string;
  content: string;
  version: string;
  size: number;
  mtimeMs: number;
}

type EditorMode = 'edit' | 'preview';
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';
type SortKey = 'name' | 'mtime';
type SortDirection = 'asc' | 'desc';
type MobilePane = 'files' | 'editor';

const SIDEBAR_WIDTH_KEY = 'xangi-workspace-sidebar-width';

function initialSidebarWidth(): number {
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= 220 && stored <= 560 ? stored : 300;
}

function encodePath(path: string): string {
  return encodeURIComponent(path);
}

function fileSize(bytes?: number): string {
  if (!Number.isFinite(bytes)) return '';
  if ((bytes as number) < 1024) return `${bytes} B`;
  return `${((bytes as number) / 1024).toFixed(1)} KB`;
}

function pathSegments(path: string): Array<{ label: string; path: string }> {
  const result = [{ label: 'workspace', path: '' }];
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    result.push({ label: segment, path: current });
  }
  return result;
}

function stateLabel(state: SaveState): string {
  if (state === 'dirty') return '未保存の変更';
  if (state === 'saving') return '保存中…';
  if (state === 'saved') return '保存しました';
  if (state === 'conflict') return '別の場所で更新されています';
  if (state === 'error') return '保存できませんでした';
  return '保存済み';
}

function markdownBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

export function Workspace() {
  const [directory, setDirectory] = useState<WorkspaceDirectory>({
    path: '',
    parent: null,
    entries: [],
  });
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [selected, setSelected] = useState<WorkspaceFile>();
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<EditorMode>('edit');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [message, setMessage] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [tagFilter, setTagFilter] = useState('');
  const [mobilePane, setMobilePane] = useState<MobilePane>('files');
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const resizeStart = useRef({ x: 0, width: sidebarWidth });
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pendingLocation = useRef<{ line: number; column?: number } | undefined>(undefined);
  const initialLocationHandled = useRef(false);

  const dirty = selected !== undefined && draft !== selected.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const markdown = selected?.path.toLowerCase().endsWith('.md') === true;

  const loadDirectory = useCallback(async (path: string) => {
    if (dirtyRef.current) {
      setMessage('ファイルを移動する前に、変更を保存するか再読込してください。');
      return;
    }
    setDirectoryLoading(true);
    setMessage('');
    try {
      const result = await getJson<WorkspaceDirectory>(
        `/api/workspace/entries?path=${encodePath(path)}`
      );
      setDirectory(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDirectoryLoading(false);
    }
  }, []);

  const openFile = useCallback(async (path: string, line?: number, column?: number) => {
    if (dirtyRef.current) {
      setMessage('別のファイルを開く前に、変更を保存するか再読込してください。');
      return;
    }
    setMessage('');
    setSaveState('idle');
    try {
      const file = await getJson<WorkspaceFile>(`/api/workspace/file?path=${encodePath(path)}`);
      setSelected(file);
      setDraft(file.content);
      setMode(line ? 'edit' : file.path.toLowerCase().endsWith('.md') ? 'preview' : 'edit');
      pendingLocation.current = line ? { line, column } : undefined;
      setMobilePane('editor');
      window.history.replaceState({}, '', workspaceViewerUrl({ path: file.path, line, column }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useLayoutEffect(() => {
    const location = pendingLocation.current;
    const editor = editorRef.current;
    if (!location || !editor || mode !== 'edit') return;
    const selection = lineSelection(draft, location.line, location.column);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(selection.start, selection.end);
    const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 21;
    editor.scrollTop = Math.max(0, (selection.line - 2) * lineHeight);
    pendingLocation.current = undefined;
  }, [draft, mode, selected]);

  const reloadFile = useCallback(async () => {
    if (!selected) return;
    setMessage('');
    try {
      const file = await getJson<WorkspaceFile>(
        `/api/workspace/file?path=${encodePath(selected.path)}`
      );
      setSelected(file);
      setDraft(file.content);
      setSaveState('idle');
    } catch (error) {
      setSaveState('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [selected]);

  const saveFile = useCallback(async () => {
    if (!selected || !dirty || saveState === 'saving') return;
    setSaveState('saving');
    setMessage('');
    try {
      const file = await requestJson<WorkspaceFile>('/api/workspace/file', {
        method: 'PUT',
        body: JSON.stringify({
          path: selected.path,
          content: draft,
          version: selected.version,
        }),
      });
      setSelected(file);
      setDraft(file.content);
      setSaveState('saved');
      window.setTimeout(
        () => setSaveState((current) => (current === 'saved' ? 'idle' : current)),
        1600
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSaveState('conflict');
        setMessage('ファイルが外部で更新されました。再読込してから編集し直してください。');
      } else {
        setSaveState('error');
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }, [draft, dirty, saveState, selected]);

  useEffect(() => {
    if (initialLocationHandled.current) return;
    initialLocationHandled.current = true;
    const target = workspaceTargetFromSearch(window.location.search);
    if (!target) {
      void loadDirectory('');
      return;
    }
    void loadDirectory(workspaceParentPath(target.path));
    void openFile(target.path, target.line, target.column);
  }, [loadDirectory, openFile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveFile]);

  const breadcrumbs = useMemo(() => pathSegments(directory.path), [directory.path]);
  const availableTags = useMemo(
    () =>
      [...new Set(directory.entries.flatMap((entry) => entry.tags ?? []))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [directory.entries]
  );
  const visibleEntries = useMemo(() => {
    const filtered = directory.entries.filter(
      (entry) => entry.type === 'directory' || !tagFilter || entry.tags?.includes(tagFilter)
    );
    return [...filtered].sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      const comparison =
        sortKey === 'mtime' ? left.mtimeMs - right.mtimeMs : left.name.localeCompare(right.name);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [directory.entries, sortDirection, sortKey, tagFilter]);
  const visibleSaveState: SaveState = dirty && saveState === 'idle' ? 'dirty' : saveState;
  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const next = Math.min(
      560,
      Math.max(220, resizeStart.current.width + event.clientX - resizeStart.current.x)
    );
    setSidebarWidth(next);
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  };

  return (
    <main className="workspace-browser-shell">
      <AppTopbar current="workspace" />

      <section
        className={`workspace-browser-layout mobile-pane-${mobilePane}`}
        style={{ '--workspace-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="workspace-file-panel" aria-label="Workspace files">
          <nav className="workspace-breadcrumbs" aria-label="パンくず">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.path || 'root'}>
                {index > 0 && <span aria-hidden="true">/</span>}
                <button type="button" onClick={() => void loadDirectory(crumb.path)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>

          <div className="workspace-file-controls">
            <select
              aria-label="ファイルの並び順"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
            >
              <option value="name">名前順</option>
              <option value="mtime">更新日時順</option>
            </select>
            <button
              type="button"
              aria-label={sortDirection === 'asc' ? '降順に変更' : '昇順に変更'}
              title={sortDirection === 'asc' ? '降順に変更' : '昇順に変更'}
              onClick={() => setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))}
            >
              {sortDirection === 'asc' ? '昇順' : '降順'}
            </button>
            <select
              aria-label="タグで絞り込み"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="">すべてのタグ</option>
              {availableTags.map((tag) => (
                <option value={tag} key={tag}>
                  #{tag}
                </option>
              ))}
            </select>
          </div>

          <div className="workspace-file-list" aria-busy={directoryLoading}>
            {directory.parent !== null && (
              <button
                type="button"
                className="workspace-file-row directory"
                onClick={() => void loadDirectory(directory.parent || '')}
              >
                <span className="workspace-file-icon" aria-hidden="true">
                  ↑
                </span>
                <span>ひとつ上へ</span>
              </button>
            )}
            {visibleEntries.map((entry) => (
              <button
                type="button"
                className={`workspace-file-row ${entry.type} ${
                  selected?.path === entry.path ? 'selected' : ''
                }`}
                aria-current={selected?.path === entry.path ? 'page' : undefined}
                key={entry.path}
                onClick={() =>
                  entry.type === 'directory'
                    ? void loadDirectory(entry.path)
                    : void openFile(entry.path)
                }
              >
                <span className="workspace-file-icon" aria-hidden="true">
                  {entry.type === 'directory' ? '▸' : '·'}
                </span>
                <span className="workspace-file-primary">
                  <span className="workspace-file-name">{entry.name}</span>
                  {entry.tags && entry.tags.length > 0 && (
                    <small className="workspace-file-tags">
                      {entry.tags
                        .slice(0, 2)
                        .map((tag) => `#${tag}`)
                        .join(' ')}
                    </small>
                  )}
                </span>
                {entry.type === 'file' && (
                  <small className="workspace-file-size">{fileSize(entry.size)}</small>
                )}
              </button>
            ))}
            {!directoryLoading && visibleEntries.length === 0 && (
              <p className="workspace-file-empty">表示できるファイルはありません。</p>
            )}
            {directoryLoading && <p className="workspace-file-empty">読み込み中…</p>}
          </div>
        </aside>

        <div
          className="workspace-resizer"
          role="separator"
          aria-label="ファイル一覧の幅"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={560}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            resizeStart.current = { x: event.clientX, width: sidebarWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={resizeSidebar}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = Math.min(
              560,
              Math.max(220, sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20))
            );
            setSidebarWidth(next);
            window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
          }}
        />

        <section className="workspace-editor-panel" aria-label="File editor">
          {message && (
            <div className="workspace-editor-message" role="alert">
              <span>{message}</span>
              {saveState === 'conflict' && selected && (
                <button type="button" onClick={() => void reloadFile()}>
                  最新版を再読込
                </button>
              )}
            </div>
          )}
          {selected ? (
            <>
              <header className="workspace-editor-header">
                <button
                  type="button"
                  className="workspace-mobile-files-button"
                  onClick={() => setMobilePane('files')}
                >
                  ← ファイル一覧
                </button>
                <div className="workspace-editor-file">
                  <strong>{selected.path}</strong>
                  <small>
                    {fileSize(selected.size)} · {new Date(selected.mtimeMs).toLocaleString()}
                  </small>
                </div>
                <div className="workspace-editor-actions">
                  {visibleSaveState !== 'idle' && (
                    <span
                      className={`workspace-save-status ${visibleSaveState}`}
                      role="status"
                      aria-live="polite"
                    >
                      {stateLabel(visibleSaveState)}
                    </span>
                  )}
                  {markdown && (
                    <div className="workspace-editor-tabs" role="group" aria-label="表示モード">
                      <button
                        type="button"
                        className={mode === 'preview' ? 'active' : ''}
                        aria-pressed={mode === 'preview'}
                        onClick={() => setMode('preview')}
                      >
                        プレビュー
                      </button>
                      <button
                        type="button"
                        className={mode === 'edit' ? 'active' : ''}
                        aria-pressed={mode === 'edit'}
                        onClick={() => setMode('edit')}
                      >
                        編集
                      </button>
                    </div>
                  )}
                  <button type="button" className="button" onClick={() => void reloadFile()}>
                    再読込
                  </button>
                  <a
                    className="button"
                    href={workspaceFileUrl(selected.path)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    rawで開く
                  </a>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!dirty || saveState === 'saving'}
                    onClick={() => void saveFile()}
                  >
                    {saveState === 'saving' ? '保存中…' : '保存'}
                  </button>
                </div>
              </header>

              {mode === 'preview' && markdown ? (
                <article className="workspace-markdown-preview markdown-message">
                  <div className="workspace-markdown-document">
                    <Suspense fallback={<p>プレビューを読み込み中…</p>}>
                      <MarkdownBody content={markdownBody(draft)} />
                    </Suspense>
                  </div>
                </article>
              ) : (
                <textarea
                  ref={editorRef}
                  className="workspace-editor"
                  aria-label={`${selected.path}を編集`}
                  spellCheck={markdown}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setSaveState('idle');
                    setMessage('');
                  }}
                />
              )}
            </>
          ) : (
            <div className="workspace-editor-empty">
              <span aria-hidden="true">↖</span>
              <h2>ファイルを選択</h2>
              <p>左の一覧からMarkdownやコードを開けます。</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
