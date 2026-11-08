import { Button } from "@dx-rework/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

export function SourcingReturnDialog({ busy, error, onClose, onSubmit, reason:draftReason, onReasonChange }: {
  reason?:string;onReasonChange?:(reason:string)=>void;
  busy: boolean; error: string; onClose(): void; onSubmit(reason: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [localReason,setLocalReason]=useState("");
  const reason=draftReason??localReason,setReason=onReasonChange??setLocalReason;
  useEffect(() => { const modal = ref.current; modal?.showModal(); return () => modal?.close(); }, []);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && reason.trim()) onSubmit(reason.trim()); };
  return <dialog ref={ref} className="system-dialog" aria-label="退回跟单修改" onCancel={event => {event.preventDefault(); if (!busy) onClose();}}>
    <form onSubmit={submit}>
      <div className="system-dialog__copy"><h2>退回跟单修改</h2><p>修改后重新提交 IE、供应链总监和老板确认，流程累计用时保留。</p></div>
      <label className="system-dialog__field"><span>退回原因 *</span><textarea autoFocus required maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="system-dialog__actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={busy || !reason.trim()}>{busy ? "正在退回…" : "确认退回"}</Button></div>
    </form>
  </dialog>;
}
