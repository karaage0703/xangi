import { lazy, memo, Suspense } from 'react';
import { workspaceFileUrl } from './api';

const IMAGE_EXTENSIONS = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;
const AUDIO_EXTENSIONS = /\.(?:aac|flac|m4a|mp3|ogg|wav)$/i;
const VIDEO_EXTENSIONS = /\.(?:m4v|mov|mp4|webm)$/i;

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

function Media({ path }: { path: string }) {
  const url = workspaceFileUrl(path);
  const name = path.split('/').pop() || path;
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

function splitMedia(content: string): Array<{ kind: 'text' | 'media'; value: string }> {
  const parts: Array<{ kind: 'text' | 'media'; value: string }> = [];
  const pattern = /MEDIA:([^\s\n]+)/g;
  let index = 0;
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const text = content.slice(index, start);
    if (text.trim()) parts.push({ kind: 'text', value: text });
    parts.push({ kind: 'media', value: match[1] });
    index = start + match[0].length;
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
