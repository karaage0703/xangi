import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import { artifactPreviewUrl, workspaceFileUrl } from './api';

const IMAGE_EXTENSIONS = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;
const AUDIO_EXTENSIONS = /\.(?:aac|flac|m4a|mp3|ogg|wav)$/i;
const VIDEO_EXTENSIONS = /\.(?:m4v|mov|mp4|webm)$/i;
const HTML_EXTENSIONS = /\.html?$/i;

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

const MarkdownBody = lazy(() => import('./MarkdownBody'));

function HtmlArtifact({ path }: { path: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const previewUrl = artifactPreviewUrl(path);
  const downloadUrl = workspaceFileUrl(path);
  const name = path.split('/').pop() || path;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!fullscreen || !dialog || dialog.open) return;
    dialog.showModal();
  }, [fullscreen]);

  const closeFullscreen = () => {
    setFullscreen(false);
    requestAnimationFrame(() => openButtonRef.current?.focus());
  };

  return (
    <section className="html-artifact" aria-label={`${name}のHTMLプレビュー`}>
      <header>
        <div>
          <span className="html-artifact-kicker">HTML ARTIFACT</span>
          <strong>{name}</strong>
        </div>
        <div className="html-artifact-actions">
          <button ref={openButtonRef} type="button" onClick={() => setFullscreen(true)}>
            全画面で開く
          </button>
          <a href={downloadUrl}>保存</a>
        </div>
      </header>
      <iframe
        src={previewUrl}
        title={`${name}のHTMLプレビュー`}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
      {fullscreen ? (
        <dialog
          ref={dialogRef}
          className="html-artifact-dialog"
          aria-label={`${name}の全画面プレビュー`}
          onCancel={(event) => {
            event.preventDefault();
            closeFullscreen();
          }}
        >
          <header>
            <strong>{name}</strong>
            <button
              type="button"
              autoFocus
              onClick={closeFullscreen}
              aria-label="全画面表示を閉じる"
            >
              × 閉じる
            </button>
          </header>
          <iframe
            src={previewUrl}
            title={`${name}の全画面HTMLプレビュー`}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
          />
        </dialog>
      ) : null}
    </section>
  );
}

function Media({ path }: { path: string }) {
  const url = workspaceFileUrl(path);
  const name = path.split('/').pop() || path;
  if (HTML_EXTENSIONS.test(path)) {
    return <HtmlArtifact path={path} />;
  }
  if (IMAGE_EXTENSIONS.test(path)) {
    return (
      <a className="media-preview image" href={url} target="_blank" rel="noopener noreferrer">
        <img src={url} alt={name} loading="lazy" />
      </a>
    );
  }
  if (AUDIO_EXTENSIONS.test(path)) {
    return <audio className="media-preview" controls preload="metadata" src={url} />;
  }
  if (VIDEO_EXTENSIONS.test(path)) {
    return <video className="media-preview" controls preload="metadata" src={url} />;
  }
  return (
    <a className="media-file" href={url} target="_blank" rel="noopener noreferrer">
      {name} を開く
    </a>
  );
}

interface MediaMatch {
  start: number;
  end: number;
  path: string;
}

const MEDIA_PATTERN = /MEDIA:([^\s\n`"'<>()[\]{}（）［］【】「」『』、。！？,;]+)/g;

function inlineCodeRanges(line: string, offset: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const openerPattern = /`+/g;
  let opener: RegExpExecArray | null;
  while ((opener = openerPattern.exec(line))) {
    const delimiter = opener[0];
    const closeAt = line.indexOf(delimiter, openerPattern.lastIndex);
    if (closeAt < 0) continue;
    ranges.push({ start: offset + opener.index, end: offset + closeAt + delimiter.length });
    openerPattern.lastIndex = closeAt + delimiter.length;
  }
  return ranges;
}

function mediaMatches(content: string): MediaMatch[] {
  const matches: MediaMatch[] = [];
  const lines = content.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/, '');
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const { marker, length } = fence;
      const trimmed = line.trim();
      if (trimmed.length >= length && [...trimmed].every((character) => character === marker)) {
        fence = undefined;
      }
      offset += lineWithEnding.length;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length };
      offset += lineWithEnding.length;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      offset += lineWithEnding.length;
      continue;
    }

    const codeRanges = inlineCodeRanges(line, offset);
    for (const match of line.matchAll(MEDIA_PATTERN)) {
      const start = offset + (match.index ?? 0);
      if (codeRanges.some((range) => start >= range.start && start < range.end)) continue;
      matches.push({ start, end: start + match[0].length, path: match[1] });
    }
    offset += lineWithEnding.length;
  }
  return matches;
}

export function splitMedia(content: string): Array<{ kind: 'text' | 'media'; value: string }> {
  const parts: Array<{ kind: 'text' | 'media'; value: string }> = [];
  let index = 0;
  for (const match of mediaMatches(content)) {
    const text = content.slice(index, match.start);
    if (text.trim()) parts.push({ kind: 'text', value: text });
    parts.push({ kind: 'media', value: match.path });
    index = match.end;
  }
  const rest = content.slice(index);
  if (rest.trim()) parts.push({ kind: 'text', value: rest });
  return parts.length > 0 ? parts : [{ kind: 'text', value: content }];
}

export const MessageContent = memo(function MessageContent({
  content,
  markdown,
}: {
  content: string;
  markdown: boolean;
}) {
  if (!markdown) return <div className="plain-message">{content}</div>;
  return (
    <div className="markdown-message">
      {splitMedia(content).map((part, index) =>
        part.kind === 'media' ? (
          <Media key={`media-${index}`} path={part.value} />
        ) : (
          <Suspense
            key={`text-${index}`}
            fallback={<div className="markdown-loading">{part.value}</div>}
          >
            <MarkdownBody content={part.value} />
          </Suspense>
        )
      )}
    </div>
  );
});

export { copyText };
