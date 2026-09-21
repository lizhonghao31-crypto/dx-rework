import { SourcingNewUnitPriceSchema } from "@dx-rework/contracts";
import { formatBusinessCurrency } from "@dx-rework/contracts/business-display";
import { Button } from "@dx-rework/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

const editablePrice = (value: string): boolean => /^(?:\d+(?:\.\d*)?)?$/.test(value);

export function SourcingBudgetPriceCorrectionDialog({ currentPrice, busy, error, onClose, onSubmit }: {
  currentPrice: string; busy: boolean; error: string; onClose(): void; onSubmit(daxingUnitPrice: string, reason: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const [price,setPrice]=useState(""), [reason,setReason]=useState(""), [attempted,setAttempted]=useState(false);
  const parsed=SourcingNewUnitPriceSchema.safeParse(price.trim());
  const priceError=attempted&&!parsed.success?(parsed.error.issues[0]?.message??"请填写有效预算价"):"";
  const reasonError=attempted&&!reason.trim()?"请填写更正原因":"";
  useEffect(()=>{ const modal=ref.current, previous=document.body.style.overflow; document.body.style.overflow="hidden"; modal?.showModal();
    const frame=requestAnimationFrame(()=>inputRef.current?.focus()); return()=>{cancelAnimationFrame(frame);modal?.close();document.body.style.overflow=previous;};},[]);
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setAttempted(true);if(parsed.success&&reason.trim())onSubmit(parsed.data,reason.trim());};
  return <dialog ref={ref} className="system-dialog sourcing-budget-price-correction-dialog" aria-label="更正预算价"
    onCancel={event=>{event.preventDefault();if(!busy)onClose();}}><form onSubmit={submit}>
    <div className="system-dialog__copy"><h2>更正预算价</h2><p>只更正跟单登记的预算价，不改变 IE 价、生产价或当前流程。</p></div>
    <div className="sourcing-budget-price-correction__current"><span>当前预算价</span><strong>{formatBusinessCurrency(currentPrice)}</strong></div>
    <label className="system-dialog__field"><span>新预算价</span><input ref={inputRef} inputMode="decimal" value={price} disabled={busy}
      aria-invalid={!!priceError} onChange={event=>{if(editablePrice(event.target.value))setPrice(event.target.value);}} />{priceError?<small role="status">{priceError}</small>:null}</label>
    <label className="system-dialog__field"><span>更正原因</span><textarea value={reason} disabled={busy} maxLength={500}
      aria-invalid={!!reasonError} onChange={event=>setReason(event.target.value)} />{reasonError?<small role="status">{reasonError}</small>:null}</label>
    {error?<p className="sourcing-budget-price-correction__error" role="alert">{error}</p>:null}
    <div className="system-dialog__actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button>
      <Button type="submit" variant="primary" disabled={busy}>{busy?"正在更正…":"确认更正"}</Button></div>
  </form></dialog>;
}