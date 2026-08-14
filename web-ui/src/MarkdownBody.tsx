import { Children, isValidElement, memo, ReactNode, useState } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from './MessageContent';
import { workspaceTargetFromHref, workspaceViewerUrl } from './workspace-navigation';

const REMARK_PLUGINS = [remarkGfm];

function markdownUrlTransform(value: string): string {
  return workspaceTargetFromHref(value) ? value : defaultUrlTransform(value);
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
      urlTransform={markdownUrlTransform}
      components={{
        a({ href, children, title, className }) {
          // Message links must not replace the chat document. This also keeps local
          // file-style links from stranding the user on the server's 404 response.
          const separateContext = Boolean(href && !href.startsWith('#'));
          const workspaceTarget = href ? workspaceTargetFromHref(href) : undefined;
          return (
            <a
              href={workspaceTarget ? workspaceViewerUrl(workspaceTarget) : href}
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
