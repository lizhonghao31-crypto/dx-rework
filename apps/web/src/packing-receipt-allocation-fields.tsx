import type {PackingAllocationInput,PackingTimeInput} from '@dx-rework/contracts';
import type {BoardRow} from './receiving-board-types.js';

export type PackingAllocationDraft={quantity:string;mode:PackingTimeInput['mode']|'same';value:string};
export function originalPackingAllocationDrafts(row:BoardRow):Record<string,PackingAllocationDraft>{
 return Object.fromEntries((row.packingAllocations??[]).map(allocation=>[allocation.receiptId,{quantity:String(allocation.quantity),mode:allocation.actualTime.precision==='instant'?'instant':allocation.actualTime.precision==='date'?'date':'unknown',
  value:allocation.actualTime.precision==='instant'?new Date(Date.parse(allocation.actualTime.at)+8*3600000).toISOString().replace(/Z$/,''):allocation.actualTime.precision==='date'?allocation.actualTime.date:''}]));
}
export function packingAllocationInputs(row:BoardRow,drafts:Record<string,PackingAllocationDraft>,same:PackingTimeInput):PackingAllocationInput[]{
 return Object.entries(drafts).flatMap(([receiptId,draft])=>{
  if(!draft.quantity.trim()||draft.quantity==='0')return [];
  const receipt=row.receivingHistory.find(receipt=>receipt.receiptId===receiptId),quantity=Number(draft.quantity);
  if(!receipt?.quantityVersion||!Number.isSafeInteger(quantity)||quantity<=0||quantity>receipt.actualQuantity)throw new Error('请核对各收货批次的装箱数量及最新收货版本');
  let packingTime:PackingTimeInput;
  if(draft.mode==='same')packingTime=same;
  else if(draft.mode==='instant'){
   const at=new Date(`${draft.value}+08:00`);if(!draft.value||!Number.isFinite(at.getTime()))throw new Error('请填写本批实际装箱时间');
   packingTime={mode:'instant',value:at.toISOString()};
  }else if(draft.mode==='date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(draft.value))throw new Error('请填写本批实际装箱日期');packingTime={mode:'date',value:draft.value};}
  else packingTime={mode:draft.mode};
  return [{receiptId,quantityVersion:receipt.quantityVersion,quantity,packingTime}];
 });
}

export function PackingReceiptAllocationFields({row,enabled,onEnabled,drafts,onChange,disabled}:{row:BoardRow;enabled:boolean;onEnabled(value:boolean):void;drafts:Record<string,PackingAllocationDraft>;onChange(value:Record<string,PackingAllocationDraft>):void;disabled:boolean}){
 const change=(id:string,fields:Partial<PackingAllocationDraft>)=>onChange({...drafts,[id]:{quantity:'',mode:'unknown',value:'',...drafts[id],...fields}});
 return <fieldset className="packing-receipt-allocation" disabled={disabled}><legend>装箱批次关联（选填）</legend><label className="packing-receipt-allocation__toggle"><input type="checkbox" checked={enabled} onChange={event=>onEnabled(event.target.checked)}/>明确本次累计装箱对应的收货批次</label>
 {enabled&&<><p>仅填写真实对应关系，数量合计须等于上方累计装箱数；原记录自动带入。未关联时保留累计实绩，不推定逐批完成时间。</p>{row.receivingHistory.filter(receipt=>receipt.actualQuantity>0).map(receipt=>{
  const draft=drafts[receipt.receiptId]??{quantity:'',mode:'unknown',value:''};
  return <div className="factory-batch-scope" key={receipt.receiptId}><label>收货第{receipt.sequence}笔 · 实收{receipt.actualQuantity}<input aria-label={`第${receipt.sequence}笔装箱数量`} type="number" min="0" max={receipt.actualQuantity} step="1" value={draft.quantity} onChange={event=>change(receipt.receiptId,{quantity:event.target.value})}/></label>
   <label>本批实际装箱时间<select aria-label={`第${receipt.sequence}笔装箱时间`} value={draft.mode} onChange={event=>change(receipt.receiptId,{mode:event.target.value as PackingAllocationDraft['mode'],value:''})}><option value="unknown">时间未记录</option><option value="same">与本次装箱同时完成</option><option value="instant">填写实际时间</option><option value="date">只记实际日期</option></select></label>
   {draft.mode==='instant'&&<input aria-label={`第${receipt.sequence}笔实际装箱时间（北京时间）`} type="datetime-local" step="0.001" value={draft.value} onChange={event=>change(receipt.receiptId,{value:event.target.value})}/>}
   {draft.mode==='date'&&<input aria-label={`第${receipt.sequence}笔实际装箱日期`} type="date" value={draft.value} onChange={event=>change(receipt.receiptId,{value:event.target.value})}/>}
  </div>;
 })}</>}
 </fieldset>;
}
