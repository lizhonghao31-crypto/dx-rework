import { useEffect, useRef, type ReactNode } from "react";

/** Scoped to board-room actions; Escape never submits an action. */
export function PatternDialog({ title, busy, onClose, children }: {
  title: string; busy: boolean; onClose(): void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => { dialog?.close(); document.body.style.overflow = overflow; };
  }, []);
  return <dialog className="pattern-action-dialog" ref={ref} aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}
