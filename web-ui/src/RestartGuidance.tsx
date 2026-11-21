import { useEffect, useRef, type ReactNode } from 'react';

export function RestartGuidance({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div ref={ref} className="settings-status success" role="status">
      {children && <p>{children}</p>}
      <p>
        <strong>反映にはxangiの再起動が必要です。</strong>
      </p>
      <p>
        今すぐ反映する場合は、xangiに「再起動して」と依頼してください。再起動中は接続が一時的に切れます。
      </p>
    </div>
  );
}
