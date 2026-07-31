import { Children, isValidElement, memo, ReactNode, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from './MessageContent';

const REMARK_PLUGINS = [remarkGfm];

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
        a({ href, children, ...props }) {
          const external = href?.startsWith('http://') || href?.startsWith('https://');
          return (
            <a
              {...props}
              href={href}
              target={external ? '_blank' : undefined}
              rel={external ? 'noopener noreferrer' : undefined}
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
