import type {BulkWashingFact,BulkWashingMode,BulkWashingScope} from '@dx-rework/contracts/bulk-washing';

/** Pure projection of the effective event set supplied by the original command
 * transaction. Replaced/revoked events remain in history, not in this input.
 * Uncovered or superseded quantities cannot become available for packing. */
export function bulkWashingLedger(scope:BulkWashingScope,mode:BulkWashingMode,facts:readonly BulkWashingFact[]){
 const quantity=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 if(!quantity(scope.quantity))throw Error('洗水范围数量无效');
 const own=facts.filter(fact=>fact.scopeId===scope.scopeId);
 const reasons=new Set<string>();
 if(new Set(own.map(fact=>fact.id)).size!==own.length)reasons.add('洗水记录身份重复');
 const current=own.filter(fact=>fact.quantityVersion===scope.quantityVersion);
 if(current.length!==own.length)reasons.add('原数量已更正，洗水范围待复核');
 const byId=new Map(current.map(fact=>[fact.id,fact]));
 let sent=0,washed=0,qualified=0,started=0,reworkSent=0,reworkWashed=0,reworkQualified=0;
 const returned=new Map<string,number>(),checked=new Set<string>(),reworked=new Map<string,number>(),rounds:Record<string,number>={};
 const positions=new Map(current.map((fact,index)=>[fact.id,index]));
 const positive=(n:number)=>quantity(n)&&n>0;
 for(const fact of current){
  if(!positive(fact.quantity)){reasons.add('洗水记录数量无效');continue;}
  if(fact.occurredAt!==null&&!Number.isFinite(Date.parse(fact.occurredAt)))reasons.add('洗水发生时间无效');
  if(fact.kind==='send'){
   if(mode!=='after_receipt')reasons.add('洗水记录与采用路线不一致');
   if(fact.reworkOfInspectionId)reworkSent+=fact.quantity;else sent+=fact.quantity;
  }else if(fact.kind==='return'){
   if(mode!=='after_receipt')reasons.add('洗水记录与采用路线不一致');
   const send=byId.get(fact.sendId);
   if(send?.kind!=='send')reasons.add('洗回缺少同范围有效送洗记录');
   else if(fact.occurredAt&&send.occurredAt&&Date.parse(fact.occurredAt)<Date.parse(send.occurredAt))reasons.add('洗回时间早于送洗');
   returned.set(fact.sendId,(returned.get(fact.sendId)??0)+fact.quantity);
   if(send?.kind==='send'&&send.reworkOfInspectionId)reworkWashed+=fact.quantity;else washed+=fact.quantity;
   rounds[fact.id]=rounds[fact.sendId]??0;
  }else if(fact.kind==='factory_start'){
   if(mode!=='factory')reasons.add('洗水记录与采用路线不一致');
   if(fact.reworkOfInspectionId)reworkSent+=fact.quantity;else started+=fact.quantity;
  }else if(fact.kind==='factory_complete'){
   if(mode!=='factory')reasons.add('洗水记录与采用路线不一致');
   const start=byId.get(fact.startId);
   if(start?.kind!=='factory_start')reasons.add('工厂洗好缺少同批实际开始记录');
   else if(start.occurredAt&&fact.occurredAt&&Date.parse(fact.occurredAt)<Date.parse(start.occurredAt))reasons.add('洗水完成早于开始');
   returned.set(fact.startId,(returned.get(fact.startId)??0)+fact.quantity);
   if(start?.kind==='factory_start'&&start.reworkOfInspectionId)reworkWashed+=fact.quantity;else washed+=fact.quantity;
   rounds[fact.id]=rounds[fact.startId]??0;
  }else if(fact.kind==='receipt_link'){
   if(mode!=='factory')reasons.add('只有工厂洗好路线需要关联原收货批次');
  }else{
   const completion=byId.get(fact.completionId);
   if(checked.has(fact.completionId))reasons.add('同批洗后检查存在多个有效版本');
   checked.add(fact.completionId);
   if(!completion||!['return','factory_complete'].includes(completion.kind)||completion.quantity!==fact.quantity)reasons.add('洗后检查与当前洗回数量不一致');
   if(completion?.occurredAt&&fact.occurredAt&&Date.parse(fact.occurredAt)<Date.parse(completion.occurredAt))reasons.add('洗后检查早于洗水完成');
   if(!quantity(fact.qualifiedQuantity)||fact.qualifiedQuantity>fact.quantity)reasons.add('洗后合格数量无效');
   else{qualified+=fact.qualifiedQuantity;if((rounds[fact.completionId]??0)>0)reworkQualified+=fact.qualifiedQuantity;}
   rounds[fact.id]=rounds[fact.completionId]??0;
  }
  if(fact.kind==='send'||fact.kind==='factory_start'){
   rounds[fact.id]=0;
   if(fact.reworkOfInspectionId){
    const origin=byId.get(fact.reworkOfInspectionId);
    if(origin?.kind!=='inspection'||(positions.get(origin.id)??Infinity)>=(positions.get(fact.id)??-1))reasons.add('返洗须关联本批此前有效的不合格检查');
    else{
     if(fact.occurredAt&&origin.occurredAt&&Date.parse(fact.occurredAt)<Date.parse(origin.occurredAt))reasons.add('返洗开始早于原不合格检查');
     const used=(reworked.get(origin.id)??0)+fact.quantity;reworked.set(origin.id,used);
     if(used>origin.quantity-origin.qualifiedQuantity)reasons.add('返洗数量超过原检查尚未返洗的不合格余量');
     rounds[fact.id]=(rounds[origin.id]??0)+1;
    }
   }
  }
 }
 for(const [id,count]of returned){const send=byId.get(id);if((send?.kind==='send'||send?.kind==='factory_start')&&count>send.quantity)reasons.add('洗回数量超过对应送洗数量');}
 if(started>scope.quantity||sent>scope.quantity||washed>scope.quantity||qualified>washed||reworkWashed>reworkSent||![sent,washed,qualified,started,reworkSent,reworkWashed,reworkQualified].every(quantity))reasons.add('洗水累计数量超过有效范围');
 if(mode==='none'&&own.length)reasons.add('免洗范围仍有洗水事实，须保留并核对路线变更');
 const conflict=reasons.size>0,applicable=mode!=='none';
 const covered=!conflict&&applicable?qualified:null;
 // A zero/cancelled allocation is not a completed batch. No-wash is not a
 // fabricated completion either; its normal QC/packing rules remain upstream.
 const complete=covered!==null&&scope.quantity>0&&covered===scope.quantity;
 const inspectionTimes=current.filter(f=>f.kind==='inspection').map(f=>f.occurredAt);
 const completedAt=complete&&inspectionTimes.length&&inspectionTimes.every(at=>at!==null)
  ?new Date(Math.max(...inspectionTimes.map(at=>Date.parse(at!)))).toISOString():null;
 const available=conflict?[]:current.flatMap(fact=>fact.kind==='inspection'&&fact.quantity-fact.qualifiedQuantity-(reworked.get(fact.id)??0)>0
  ?[{inspectionId:fact.id,quantity:fact.quantity-fact.qualifiedQuantity-(reworked.get(fact.id)??0),round:(rounds[fact.id]??0)+1}]:[]);
 return {applicable,conflict,reasons:[...reasons],sent,washed,qualified:covered,
  remaining:covered===null?null:scope.quantity-covered,complete,completedAt,
  rework:{sent:reworkSent,washed:reworkWashed,qualified:reworkQualified,available,rounds},
  sendable:!conflict&&mode==='after_receipt'?scope.quantity-sent:0};
}
