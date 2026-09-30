import { useEffect, useRef, type ReactNode } from "react";

/** Native modal focus/inert behavior with the existing application dialog skin. */
export function SourcingFinanceDifferenceDialog({ children, busy, onClose }: {
  children: ReactNode;
  busy: boolean;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return <dialog ref={ref} className="system-dialog sourcing-finance-difference-dialog"
    aria-label="发现不一致" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {children}
  </dialog>;
}
