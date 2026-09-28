import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './document-attachment.css';

type Info = { kind: string; text?: string; truncated?: boolean; pages?: number };
export function DocumentAttachment({ path, sessionId }: { path: string; sessionId: string }) {
  const [open, setOpen] = useState(true);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const name = path.split('/').pop() || path;
  const url = (mode: string, number?: number) =>
    `/api/session-attachment?${new URLSearchParams({ sessionId, path, mode, ...(number ? { page: String(number) } : {}) })}`;
  useEffect(() => {
    setInfo(null);
    setError('');
    setPage(1);
    setZoom(100);
    setOpen(true);
    setExpanded(false);
  }, [path, sessionId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setInfo(null);
    setError('');
    const params = new URLSearchParams({ sessionId, path, mode: 'info' });
    void fetch(`/api/session-attachment?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'プレビューを取得できませんでした。');
        setInfo(body);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause.message || cause));
      });
    return () => controller.abort();
  }, [open, path, sessionId, retry]);
  useEffect(() => {
    if (!expanded) return;
    dialog.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, [expanded]);
  function close() {
    setExpanded(false);
    requestAnimationFrame(() => opener.current?.focus());
  }
  function contents() {
    if (error)
      return (
        <p role="alert">
          {error}{' '}
          <button
            onClick={() => {
              setError('');
              setRetry((n) => n + 1);
            }}
          >
            再試行
          </button>
        </p>
      );
    if (!info) return <p role="status">プレビューを準備しています…</p>;
    if (info.kind === 'text' || info.kind === 'markdown')
      return (
        <div className="document-text">
          {info.truncated && (
            <p role="status">先頭2MBを表示しています。全文は原本をダウンロードしてください。</p>
          )}
          {info.kind === 'markdown' ? (
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{ img: ({ alt }) => <span>{alt || '画像'}</span> }}
            >
              {info.text || ''}
            </Markdown>
          ) : (
            <pre>{info.text}</pre>
          )}
        </div>
      );
    if (info.kind === 'pages')
      return (
        <div>
          <nav className="document-pages" aria-label={`${name}のページ操作`}>
            <button disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
              前へ
            </button>
            <label>
              ページ{' '}
              <input
                type="number"
                min={1}
                max={info.pages}
                value={page}
                onChange={(event) => {
                  const n = Number(event.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= (info.pages || 1)) setPage(n);
                }}
              />
            </label>
            <span>/ {info.pages}</span>
            <button disabled={page >= (info.pages || 1)} onClick={() => setPage((n) => n + 1)}>
              次へ
            </button>
            <label>
              拡大{' '}
              <select
                aria-label="拡大率"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              >
                <option value={100}>幅に合わせる</option>
                <option value={150}>150%</option>
                <option value={200}>200%</option>
                <option value={300}>300%</option>
              </select>
            </label>
          </nav>
          <div className="document-image-scroll">
            <img
              key={`${page}-${retry}`}
              className="document-page"
              style={{ width: `${zoom}%`, maxWidth: 'none' }}
              src={url('page', page)}
              alt={`${name} ${page}ページ`}
              onError={() =>
                setError(
                  'ページを表示できませんでした。再試行するか原本をダウンロードしてください。'
                )
              }
            />
          </div>
        </div>
      );
    if (info.kind === 'html')
      return (
        <iframe
          title={`${name}のプレビュー`}
          src={url('raw')}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      );
    if (info.kind === 'image')
      return (
        <img
          className="document-page"
          src={url('raw')}
          alt={name}
          onError={() => setError('画像を取得できませんでした。')}
        />
      );
    if (info.kind === 'audio')
      return (
        <audio controls src={url('raw')} onError={() => setError('音声を取得できませんでした。')} />
      );
    if (info.kind === 'video')
      return (
        <video controls src={url('raw')} onError={() => setError('動画を取得できませんでした。')} />
      );
    return <p>この形式はプレビューに対応していません。原本をダウンロードして開いてください。</p>;
  }
  return (
    <section className="document-attachment" aria-label={`${name}の添付ファイル`}>
      <header>
        <strong>{name}</strong>
        <div className="document-actions">
          <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? 'プレビューを閉じる' : 'プレビュー'}
          </button>
          <a href={url('download')} download={name}>
            原本をダウンロード
          </a>
          {open && (
            <button ref={opener} onClick={() => setExpanded(true)}>
              全画面で開く
            </button>
          )}
        </div>
      </header>
      {open && !expanded && <div className="document-content">{contents()}</div>}
      {expanded && (
        <dialog
          ref={dialog}
          className="document-dialog"
          aria-label={`${name}の全画面プレビュー`}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <header>
            <strong>{name}</strong>
            <button autoFocus onClick={close}>
              閉じて戻る
            </button>
          </header>
          <div className="document-content">{contents()}</div>
        </dialog>
      )}
    </section>
  );
}
