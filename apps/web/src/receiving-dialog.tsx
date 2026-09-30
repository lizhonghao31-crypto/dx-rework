import { useEffect, useRef, type ReactNode } from "react";
import "./receiving-dialog.css";

/** Receiving-only dialog; native modal behavior keeps keyboard focus in the active layer. */
export function ReceivingDialog({ children, title, busy = false, onClose }: {
  children: ReactNode;
  title: string;
  busy?: boolean;
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
  return <dialog ref={ref} className="receiving-dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {children}
  </dialog>;
}
