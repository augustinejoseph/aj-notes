"use client";
import { useEffect, useRef, useState } from "react";

export function InputDialog({
  title,
  label,
  initialValue = "",
  maxLength,
  options,
  action,
  close,
}: {
  title: string;
  label: string;
  initialValue?: string;
  maxLength?: number;
  options?: { value: string; label: string }[];
  action: (value: string) => void | Promise<void>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    (field.current || select.current)?.focus();
    field.current?.select();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="input-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!options && !value.trim()) return;
          setBusy(true);
          try {
            await action(options ? value : value.trim());
            close();
          } catch (e) {
            setError(String(e));
            setBusy(false);
          }
        }}
      >
        <h2 id="input-dialog-title">{title}</h2>
        <label className="dialog-field">
          {label}
          {options ? (
            <select
              ref={select}
              aria-label={label}
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              ref={field}
              aria-label={label}
              value={value}
              required
              maxLength={maxLength}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || (!options && !value.trim())}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
