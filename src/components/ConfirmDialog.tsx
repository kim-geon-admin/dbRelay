import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    if (!focusable.length) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const direction = event.shiftKey ? -1 : 1;
    focusable[(current + direction + focusable.length) % focusable.length].focus();
    event.preventDefault();
  };

  return <div className="confirmation-backdrop" role="presentation"><section ref={dialogRef} className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" aria-describedby="confirmation-dialog-description" onKeyDown={handleKeyDown}>
    <p className="app-page__eyebrow">삭제 확인</p>
    <h2 id="confirmation-dialog-title">{title}</h2>
    <p id="confirmation-dialog-description">{description}</p>
    <div className="editor-actions confirmation-dialog__actions"><button type="button" onClick={onCancel}>취소</button><button type="button" className="confirmation-dialog__confirm" aria-label={confirmLabel} onClick={onConfirm}>{confirmLabel}</button></div>
  </section></div>;
}
