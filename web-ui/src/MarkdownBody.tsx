import { Children, isValidElement, memo, ReactNode, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { workspaceFileUrl } from './api';
import { copyText } from './MessageContent';

const REMARK_PLUGINS = [remarkGfm];
const URI_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function workspacePathFromHref(href: string): string | undefined {
  if (
    href.startsWith('#') ||
    href.startsWith('?') ||
    href.startsWith('//') ||
    href === '/' ||
    /^\/(?:workspace|monitor)(?:$|[?#])/.test(href) ||
    /^\/(?:api|assets)\//.test(href) ||
    (URI_SCHEME.test(href) && !WINDOWS_ABSOLUTE_PATH.test(href))
  ) {
    return undefined;
  }

  const decoded = decodePath(href);
  return decoded.replace(/#L\d+(?::\d+)?$/, '').replace(/:\d+(?::\d+)?$/, '');
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function Pre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const value = nodeText(children).replace(/\n$/, '');
  return (
    <div className="code-block">
      <button
        type="button"
        className="code-copy"
        onClick={() => {
          copyText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'コピー済み' : 'コピー'}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

const MarkdownBody = memo(function MarkdownBody({ content }: { content: string }) {
  return (
    <Markdown
      skipHtml
      remarkPlugins={REMARK_PLUGINS}
      components={{
        a({ href, children, title, className }) {
          // Message links must not replace the chat document. This also keeps local
          // file-style links from stranding the user on the server's 404 response.
          const separateContext = Boolean(href && !href.startsWith('#'));
          const workspacePath = href ? workspacePathFromHref(href) : undefined;
          return (
            <a
              href={workspacePath ? workspaceFileUrl(workspacePath) : href}
              title={title}
              className={className}
              target={separateContext ? '_blank' : undefined}
              rel={separateContext ? 'noopener noreferrer' : undefined}
            >
              {children}
            </a>
          );
        },
        code({ className, children }) {
          return <code className={className}>{Children.toArray(children)}</code>;
        },
        pre({ children }) {
          return <Pre>{children}</Pre>;
        },
      }}
    >
      {content}
    </Markdown>
  );
});

export default MarkdownBody;
