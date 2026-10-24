/** Read model over original immutable factory facts; no second quantity/event store. */
export type FactoryScope={lineId:string;quantity:number};
export type BatchFact={fact_id:string;kind:string;payload:Record<string,unknown>;occurred_at:Date|string|null};
export type BatchCheck={return_fact_id:string;line_id:string;result:string;allow_dispatch?:boolean;dispatch_reason?:string;checked_at:Date|string};
export type BatchRow={lineId:string;quantity:number;returned:number;sent:number;reworked:number;available:number;result:string|null;allowDispatch:boolean;reason:string;checkedAt:string|null};
export type FactoryBatch={factId:string;sendFactId:string|null;occurredAt:string|null;rows:BatchRow[]};
export const scopes=(value:unknown):FactoryScope[]=>Array.isArray(value)?value.filter((v):v is FactoryScope=>Boolean(v&&typeof v.lineId==='string'&&Number.isSafeInteger(v.quantity)&&v.quantity>0)):[];
const amount=(fact:BatchFact,lineId:string)=>scopes(fact.payload.lines).find(l=>l.lineId===lineId)?.quantity??0;
export function factoryBatchLedger(lines:FactoryScope[],facts:BatchFact[],checks:BatchCheck[],noCraft:boolean){
 const sends=facts.filter(f=>f.kind==='工艺发出'),returns=facts.filter(f=>f.kind==='工艺回仓'),dispatches=facts.filter(f=>f.kind==='仓库实际发厂');
 const batches:FactoryBatch[]=returns.map(f=>({factId:f.fact_id,sendFactId:typeof f.payload.sendFactId==='string'?f.payload.sendFactId:null,occurredAt:f.occurred_at?new Date(f.occurred_at).toISOString():null,rows:scopes(f.payload.lines).map(l=>{
  const check=checks.filter(c=>c.return_fact_id===f.fact_id&&c.line_id===l.lineId).at(-1),sent=dispatches.filter(d=>d.payload.returnFactId===f.fact_id).reduce((n,d)=>n+amount(d,l.lineId),0),reworked=sends.filter(d=>d.payload.fromReturnId===f.fact_id).reduce((n,d)=>n+amount(d,l.lineId),0);
  return {...l,returned:l.quantity,sent,reworked,available:Math.max(0,l.quantity-sent-reworked),result:check?.result??null,allowDispatch:check?.result==='合格'||check?.result==='需处理'&&check.allow_dispatch===true,reason:check?.dispatch_reason??'',checkedAt:check?new Date(check.checked_at).toISOString():null};
 })}));
 const totals=lines.map(l=>{const sent=dispatches.reduce((n,f)=>n+amount(f,l.lineId),0),craftSent=sends.filter(f=>!f.payload.fromReturnId).reduce((n,f)=>n+amount(f,l.lineId),0);return {...l,sent,remaining:Math.max(0,l.quantity-sent),craftRemaining:Math.max(0,l.quantity-craftSent)};});
 const pendingSends=sends.map(s=>({factId:s.fact_id,occurredAt:s.occurred_at?new Date(s.occurred_at).toISOString():null,rows:scopes(s.payload.lines).map(l=>({...l,remaining:l.quantity-returns.filter(r=>r.payload.sendFactId===s.fact_id).reduce((n,r)=>n+amount(r,l.lineId),0)}))}));
 return {batches,totals,pendingSends,quantityConflict:totals.some(l=>l.sent>l.quantity),complete:totals.length>0&&totals.every(l=>l.sent===l.quantity),canDispatch:noCraft?totals.some(l=>l.remaining>0):batches.some(b=>b.rows.some(l=>l.available>0&&l.allowDispatch))};
}
