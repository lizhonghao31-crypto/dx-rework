import type {BulkWashingCommand,BulkWashingFact,BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
export type WashingAction=BulkWashingCommand['kind']|'rework';
export const washingFactLabel=(fact:BulkWashingFact)=>({send:'送洗',return:'洗回',factory_start:'工厂开始洗水',factory_complete:'工厂洗好',inspection:'洗后检查',receipt_link:'关联收货'})[fact.kind];
/** Only offer the current unreturned/unchecked/rejected remainder. This is a
 * UI projection; the original transactional ledger remains authoritative. */
export function washingActionRecords(scope:BulkWashingScopeView,action:WashingAction){
 const live=scope.facts.filter(f=>!f.voided),byId=new Map(live.map(f=>[f.id,f]));
 const returned=new Map<string,number>(),linked=new Map<string,number>(),checks=new Map<string,number>();
 for(const f of live){
  if(f.kind==='return'||f.kind==='factory_complete'){const id=f.kind==='return'?f.sendId:f.startId;returned.set(id,(returned.get(id)??0)+f.quantity);}
  if(f.kind==='inspection')checks.set(f.completionId,f.qualifiedQuantity);
  if(f.kind==='receipt_link')linked.set(f.completionId,(linked.get(f.completionId)??0)+f.quantity);
 }
 const label=(f:BulkWashingFact)=>{const round=scope.ledger.rework?.rounds[f.id]??0;return `${round?`返洗第${round}轮 · `:''}${washingFactLabel(f)}`;};
 if(action==='rework')return (scope.ledger.rework?.available??[]).flatMap(item=>{
  const fact=byId.get(item.inspectionId);return fact?.kind==='inspection'?[{id:fact.id,quantity:item.quantity,label:`返洗第${item.round}轮 · 原不合格${fact.quantity-fact.qualifiedQuantity}件 · 尚可返洗${item.quantity}件`,at:fact.occurredAt}]:[];
 });
 return live.flatMap(f=>{
  const quantity=action==='return'&&f.kind==='send'||action==='factory_complete'&&f.kind==='factory_start'?f.quantity-(returned.get(f.id)??0)
   :action==='inspection'&&['return','factory_complete'].includes(f.kind)&&!checks.has(f.id)?f.quantity
   :action==='receipt_link'&&f.kind==='factory_complete'?(checks.get(f.id)??0)-(linked.get(f.id)??0)
   :action==='void'?f.quantity:0;
  return quantity>0?[{id:f.id,quantity,label:label(f),at:f.occurredAt}]:[];
 });
}
