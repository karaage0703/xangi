import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busyLabel,
  busy = false,
  variant = 'primary',
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  variant?: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPointerDownRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const frame = requestAnimationFrame(() => {
        if (!dialog.open) dialog.showModal();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onPointerDown={(event) => {
        backdropPointerDownRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const clickedBackdrop =
          event.target === event.currentTarget && backdropPointerDownRef.current;
        backdropPointerDownRef.current = false;
        if (clickedBackdrop && !busy) onCancel();
      }}
    >
      <div className="confirm-dialog-body">
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
      </div>
      <div className="confirm-dialog-actions">
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>
          キャンセル
        </button>
        <button
          type="button"
          className={`confirm-dialog-${variant}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? busyLabel || `${confirmLabel}中…` : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function TextInputDialog({
  open,
  title,
  label,
  value,
  confirmLabel,
  busyLabel,
  busy = false,
  error = '',
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropPointerDownRef = useRef(false);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const frame = requestAnimationFrame(() => {
        if (!dialog.open) dialog.showModal();
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && value.trim()) onConfirm();
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog text-input-dialog"
      aria-labelledby={titleId}
      aria-describedby={error ? errorId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onPointerDown={(event) => {
        backdropPointerDownRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const clickedBackdrop =
          event.target === event.currentTarget && backdropPointerDownRef.current;
        backdropPointerDownRef.current = false;
        if (clickedBackdrop && !busy) onCancel();
      }}
    >
      <form onSubmit={submit}>
        <div className="confirm-dialog-body">
          <h2 id={titleId}>{title}</h2>
          <label className="confirm-dialog-field" htmlFor={inputId}>
            <span>{label}</span>
            <input
              ref={inputRef}
              id={inputId}
              value={value}
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
          {error && (
            <p id={errorId} className="confirm-dialog-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="confirm-dialog-primary" disabled={busy || !value.trim()}>
            {busy ? busyLabel || `${confirmLabel}中…` : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
