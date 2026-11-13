"use client";
import { useEffect, useRef, useState } from "react";

export function ConfirmDialog({
  title,
  message,
  label,
  action,
  close,
  checkboxLabel,
}: {
  title: string;
  message: string;
  label: string;
  action: (checked: boolean) => void | Promise<void>;
  checkboxLabel?: string;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    cancel.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-message">{message}</p>
      {checkboxLabel && (
        <label className="dialog-checkbox">
          <input
            type="checkbox"
            checked={checked}
            disabled={busy}
            onChange={(e) => setChecked(e.target.checked)}
          />
          {checkboxLabel}
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button ref={cancel} disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await action(checked);
              close();
            } catch (e) {
              setError(String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Please wait…" : label}
        </button>
      </div>
    </dialog>
  );
}
