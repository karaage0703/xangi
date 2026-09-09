import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';

function useModalDialog(
  open: boolean,
  busy: boolean,
  onCancel: () => void,
  focusRef?: RefObject<HTMLInputElement | null>
) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPointerDownRef = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const frame = requestAnimationFrame(() => {
        if (!dialog.open) dialog.showModal();
        focusRef?.current?.focus();
        focusRef?.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!open && dialog.open) dialog.close();
  }, [focusRef, open]);
  return {
    ref,
    onCancel: (event: SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (!busy) onCancel();
    },
    onPointerDown: (event: PointerEvent<HTMLDialogElement>) => {
      backdropPointerDownRef.current = event.target === event.currentTarget;
    },
    onClick: (event: MouseEvent<HTMLDialogElement>) => {
      const clickedBackdrop =
        event.target === event.currentTarget && backdropPointerDownRef.current;
      backdropPointerDownRef.current = false;
      if (clickedBackdrop && !busy) onCancel();
    },
  };
}

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
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useModalDialog(open, busy, onCancel);

  return (
    <dialog
      {...dialog}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
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
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const dialog = useModalDialog(open, busy, onCancel, inputRef);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && value.trim()) onConfirm();
  };

  return (
    <dialog
      {...dialog}
      className="confirm-dialog text-input-dialog"
      aria-labelledby={titleId}
      aria-describedby={error ? errorId : undefined}
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
