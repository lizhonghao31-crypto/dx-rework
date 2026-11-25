import {countedCraftCheck} from './quality-craft-problem-scope.js';
/** Read model over original immutable factory facts; no second quantity/event store. */
export type FactoryScope={lineId:string;quantity:number};
export type BatchFact={fact_id:string;kind:string;payload:Record<string,unknown>;occurred_at:Date|string|null};
export type BatchCheck={check_id?:string;return_fact_id:string;line_id:string;result:string;allow_dispatch?:boolean;dispatch_reason?:string;checked_at:Date|string;quantity_scope?:unknown;supersedes_check_id?:string|null};
export type BatchRow={lineId:string;quantity:number;returned:number;sent:number;reworked:number;available:number;releasedAvailable?:number;uninspectedQuantity?:number;qualifiedQuantity?:number;result:string|null;allowDispatch:boolean;reason:string;checkedAt:string|null};
export type FactoryBatch={factId:string;sendFactId:string|null;occurredAt:string|null;rows:BatchRow[]};
export const scopes=(value:unknown):FactoryScope[]=>Array.isArray(value)?value.filter((v):v is FactoryScope=>Boolean(v&&typeof v.lineId==='string'&&Number.isSafeInteger(v.quantity)&&v.quantity>0)):[];
const amount=(fact:BatchFact,lineId:string)=>scopes(fact.payload.lines).find(l=>l.lineId===lineId)?.quantity??0;
export const factoryBatchReleaseAvailable=(row:BatchRow)=>row.releasedAvailable??(row.allowDispatch?row.available:0);
export function activeCountedCraftChecks(checks:readonly BatchCheck[]){
 const replaced=new Set(checks.flatMap(check=>check.supersedes_check_id?[check.supersedes_check_id]:[]));
 return checks.filter(check=>check.quantity_scope!=null&&(!check.check_id||!replaced.has(check.check_id)));
}
export function factoryBatchLedger(lines:FactoryScope[],facts:BatchFact[],checks:BatchCheck[],noCraft:boolean){
 const sends=facts.filter(f=>f.kind==='工艺发出'),returns=facts.filter(f=>f.kind==='工艺回仓'),dispatches=facts.filter(f=>f.kind==='仓库实际发厂');
 const batches:FactoryBatch[]=returns.map(f=>({factId:f.fact_id,sendFactId:typeof f.payload.sendFactId==='string'?f.payload.sendFactId:null,occurredAt:f.occurred_at?new Date(f.occurred_at).toISOString():null,rows:scopes(f.payload.lines).map(l=>{
  const consumed=sends.filter(d=>d.payload.fromReturnId===f.fact_id);
  const history=checks.filter(c=>c.return_fact_id===f.fact_id&&c.line_id===l.lineId),check=history.at(-1);
  const sent=dispatches.filter(d=>d.payload.returnFactId===f.fact_id).reduce((n,d)=>n+amount(d,l.lineId),0),reworked=consumed.reduce((n,d)=>n+amount(d,l.lineId),0);
  const available=Math.max(0,l.quantity-sent-reworked);
  const counted=activeCountedCraftChecks(history).map(entry=>({entry,count:countedCraftCheck(entry.quantity_scope,l.quantity)}));
  const inspected=counted.reduce((sum,row)=>sum+(row.count?.inspectedQuantity??0),0),valid=counted.every(row=>row.count!==null)&&inspected<=l.quantity;
  const qualifiedQuantity=counted.reduce((sum,row)=>sum+(row.count?.qualifiedQuantity??0),0);
  const released=counted.reduce((sum,{entry,count})=>sum+(count?(entry.allow_dispatch===true?count.inspectedQuantity:count.qualifiedQuantity):0),0);
  const legacyRelease=check?.result==='合格'||check?.result==='需处理'&&check.allow_dispatch===true;
  // Native repair moves the explicitly held problem pieces, not a substitute
  // quantity of passed pieces. Exceptionally released problems, if any,
  // still share the same inspected-and-released limit.
  const fromRelease=consumed.reduce((n,d)=>{
   const binding=d.payload.warehouseMotion as {reworkId?:string;checkId?:string}|undefined;
   const held=binding?.reworkId&&binding.checkId&&counted.some(({entry})=>entry.check_id===binding.checkId&&entry.allow_dispatch!==true);
   return n+(held?0:amount(d,l.lineId));
  },0);
  const releasedAvailable=!counted.length?undefined:valid?Math.min(available,Math.max(0,released-sent-fromRelease)):0;
  const result=counted.length?(valid?(counted.some(row=>row.count!.problemQuantity>0)?'需处理':'合格'):null):check?.result??null;
  return {...l,returned:l.quantity,sent,reworked,available,...(releasedAvailable===undefined?{}:{releasedAvailable,uninspectedQuantity:valid?l.quantity-inspected:0,qualifiedQuantity:valid?qualifiedQuantity:0}),result,allowDispatch:releasedAvailable===undefined?legacyRelease:releasedAvailable>0,reason:check?.dispatch_reason??'',checkedAt:check?new Date(check.checked_at).toISOString():null};
 })}));
 const totals=lines.map(l=>{const sent=dispatches.reduce((n,f)=>n+amount(f,l.lineId),0),craftSent=sends.filter(f=>!f.payload.fromReturnId).reduce((n,f)=>n+amount(f,l.lineId),0);return {...l,sent,remaining:Math.max(0,l.quantity-sent),craftRemaining:Math.max(0,l.quantity-craftSent)};});
 const pendingSends=sends.map(s=>({factId:s.fact_id,occurredAt:s.occurred_at?new Date(s.occurred_at).toISOString():null,rows:scopes(s.payload.lines).map(l=>({...l,remaining:l.quantity-returns.filter(r=>r.payload.sendFactId===s.fact_id).reduce((n,r)=>n+amount(r,l.lineId),0)}))}));
 return {batches,totals,pendingSends,quantityConflict:totals.some(l=>l.sent>l.quantity),complete:totals.length>0&&totals.every(l=>l.sent===l.quantity),canDispatch:noCraft?totals.some(l=>l.remaining>0):batches.some(b=>b.rows.some(l=>factoryBatchReleaseAvailable(l)>0))};
}
