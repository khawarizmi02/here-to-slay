import { useEffect, useRef, type ReactNode } from "react";

/**
 * A panel over whatever is on screen, which stays as it was, titled `title`.
 * Close and Escape close it; focus starts on Close and goes back where it was.
 */
export function Dialog({ title, className, onClose, children }: { title: string; className: string; onClose(): void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus goes back where it was, such as the button that opened the dialog.
    const before = document.activeElement;
    close.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" aria-label={title} className={`dialog ${className}`}>
        <header>
          <h2>{title}</h2>
          <button ref={close} type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
