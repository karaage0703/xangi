import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ComposerExtension } from './composerExtensions';
import './composer-input.css';

export interface ComposerInputHandle {
  cancel(): void;
}
interface Props {
  extensions: ComposerExtension[];
  contextKey: string;
  disabled: boolean;
  onText(text: string, previous: string): void;
  onActive(active: boolean): void;
  onStart(): void;
}
function contextId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, '0')
  ).join('');
}
interface Operation {
  id: string;
  requestId: string;
  revision: number;
  text: string;
}

/** Trusted installed extensions contribute text snapshots, never a send operation. */
export const ComposerInput = forwardRef<ComposerInputHandle, Props>(
  function ComposerInput(props, ref) {
    const frames = useRef(new Map<string, HTMLIFrameElement>());
    const frameRefs = useRef(new Map<string, (frame: HTMLIFrameElement | null) => void>());
    const current = useRef(props);
    current.current = props;
    const context = useRef(contextId());
    const operation = useRef<Operation | null>(null);
    const [messages, setMessages] = useState<Record<string, string>>({});
    const ids = props.extensions.map((e) => e.id).join(',');
    const configure = useCallback(() => {
      for (const [id, frame] of frames.current)
        frame.contentWindow?.postMessage(
          {
            type: 'xangi.composer.configure',
            schemaVersion: 1,
            contextId: context.current,
            disabled:
              current.current.disabled || Boolean(operation.current && operation.current.id !== id),
          },
          location.origin
        );
    }, []);
    const cancel = useCallback(() => {
      context.current = contextId();
      operation.current = null;
      current.current.onActive(false);
      setMessages({});
      configure();
    }, [configure]);
    useImperativeHandle(ref, () => ({ cancel }), [cancel]);
    useLayoutEffect(() => {
      cancel();
    }, [props.contextKey, props.disabled, ids, cancel]);
    useEffect(() => {
      const hidden = () => {
        if (document.hidden) cancel();
      };
      document.addEventListener('visibilitychange', hidden);
      window.addEventListener('pagehide', cancel);
      return () => {
        document.removeEventListener('visibilitychange', hidden);
        window.removeEventListener('pagehide', cancel);
      };
    }, [cancel]);
    useEffect(() => {
      const receive = (event: MessageEvent) => {
        if (event.origin !== location.origin) return;
        const id = [...frames.current].find(([, f]) => f.contentWindow === event.source)?.[0];
        const m = event.data;
        if (!id || !m || typeof m !== 'object' || m.schemaVersion !== 1) return;
        if (m.type === 'xangi.composer.ready') {
          configure();
          return;
        }
        if (m.contextId !== context.current) return;
        if (m.type === 'xangi.composer.availability') {
          if (typeof m.message === 'string' && m.message.length > 0 && m.message.length <= 1000)
            setMessages((old) => ({ ...old, [id]: m.message }));
          return;
        }
        if (
          current.current.disabled ||
          document.hidden ||
          !current.current.extensions.some((e) => e.id === id)
        )
          return;
        if (typeof m.requestId !== 'string' || !m.requestId || m.requestId.length > 100) return;
        if (m.type === 'xangi.composer.begin') {
          if (operation.current) return;
          operation.current = { id, requestId: m.requestId, revision: 0, text: '' };
          current.current.onStart();
          current.current.onActive(true);
          configure();
        }
        const op = operation.current;
        if (!op || op.id !== id || op.requestId !== m.requestId) return;
        if (
          m.type === 'xangi.composer.update' &&
          Number.isSafeInteger(m.revision) &&
          m.revision > op.revision &&
          typeof m.text === 'string' &&
          m.text.trim() &&
          m.text.length <= 100000
        ) {
          current.current.onText(m.text, op.text);
          op.text = m.text;
          op.revision = m.revision;
        } else if (
          m.type === 'xangi.composer.status' &&
          typeof m.message === 'string' &&
          m.message.length <= 1000
        ) {
          setMessages((old) => ({ ...old, [id]: m.message }));
        } else if (m.type === 'xangi.composer.end') {
          operation.current = null;
          context.current = contextId();
          current.current.onActive(false);
          setMessages((old) => ({
            ...old,
            [id]: typeof m.error === 'string' ? m.error.slice(0, 1000) : '',
          }));
          configure();
        }
      };
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    }, [configure]);
    return (
      <span className="composer-extensions">
        {props.extensions.map((extension) => (
          <span key={extension.id} className="composer-extension">
            <iframe
              title={extension.displayName}
              allow="microphone"
              className="composer-extension-frame"
              src={`/api/extensions/${encodeURIComponent(extension.id)}/service/composer/`}
              ref={(() => {
                let callback = frameRefs.current.get(extension.id);
                if (!callback) {
                  callback = (frame) => {
                    if (frame) frames.current.set(extension.id, frame);
                    else {
                      frames.current.get(extension.id)?.contentWindow?.postMessage(
                        {
                          type: 'xangi.composer.configure',
                          schemaVersion: 1,
                          contextId: contextId(),
                          disabled: true,
                        },
                        location.origin
                      );
                      frames.current.delete(extension.id);
                    }
                  };
                  frameRefs.current.set(extension.id, callback);
                }
                return callback;
              })()}
              onLoad={() => {
                if (operation.current?.id === extension.id) cancel();
                configure();
              }}
            />
            {messages[extension.id] && (
              <span className="composer-extension-status" role="status">
                {messages[extension.id]}
              </span>
            )}
          </span>
        ))}
      </span>
    );
  }
);
