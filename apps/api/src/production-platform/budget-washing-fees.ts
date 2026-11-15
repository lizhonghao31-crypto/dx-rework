import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {BudgetDocumentSchema,BudgetWashingFeeSchema,calculateBudget,type BudgetDocument,type BudgetWashingFeeInput,type BudgetWashingFees} from '@dx-rework/contracts/digital-budget';
import {compareQuotationBudget} from '@dx-rework/contracts/digital-quotation';
import {isRootActor} from '../access/business-authority.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {washingOrderActive,washingPlans,washingHash,washingConflict,linkWashingBudgetFeeWithClient,type WashingDB} from './bulk-washing-repository.js';
import {formalOrderQuantity,readBudgetQuoteComparison} from './quotation-budget-basis.js';

/** The original budget publisher may append a washing-only immutable version.
 * No other budget field, adopted sourcing/contract or quote basis is changed. */
export class BudgetWashingFeeService{
 constructor(private readonly pool:Pool){}
 private async authorize(db:WashingDB,actor:TrustedActorContext,orderId:string,lock=false){
  const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'order',orderId,'budget');
  const order=(await db.query('SELECT primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0];
  return isRootActor(actor)||Boolean(order?.primary_merchandiser_id===actor.actorId&&await(lock?policy.lockActiveRole(actor.actorId,'order_merchandiser'):policy.activeRole(actor.actorId,'order_merchandiser')));
 }
 async read(actor:TrustedActorContext,orderId:string,client?:PoolClient):Promise<BudgetWashingFees>{
  const db=client??await this.pool.connect();
  try{if(!client)await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const permission=await this.authorize(db,actor,orderId),row=(await db.query('SELECT * FROM digital_budget_documents WHERE production_order_id=$1',[orderId])).rows[0];
   const active=await washingOrderActive(db,orderId),plans=await washingPlans(db,orderId),latest=[...new Map(plans.map(plan=>[plan.lineId,plan])).values()];
   const po=(await db.query('SELECT line_id,po_number,color FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[orderId])).rows;
   const lines=latest.filter(plan=>plan.document.arrangement.mode!=='none').map(plan=>{const line=po.find(line=>line.line_id===plan.lineId);return {lineId:plan.lineId,label:[line?.po_number,line?.color].filter(Boolean).join(' · ')||'本PO',version:plan.version,fee:plan.document.fee};});
   const published=row?.status==='published',history=(await db.query('SELECT version,document,published_at,washing_supplement FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version DESC',[orderId])).rows;
   const references:BudgetWashingFees['references']=[],previous=new Map<string,string>();
   for(const plan of plans){const fee=plan.document.fee,key=JSON.stringify(fee);if(previous.get(plan.lineId)===key)continue;previous.set(plan.lineId,key);
    if(fee.kind==='budget_row'){const budget=history.find(row=>row.version===fee.version),item=budget?.document.rows.find((row:{rowId:string})=>row.rowId===fee.rowId);
     references.push({lineId:plan.lineId,planVersion:plan.version,budgetVersion:fee.version,name:item?.name??'原费用依据待核',consumption:item?.consumption??null,unitPrice:item?.unitPrice??null});}
   }
   const result:BudgetWashingFees={productionOrderId:orderId,budgetVersion:row?.version??0,canPublish:permission&&active&&published&&lines.length>0,
    reason:!active?'本单已暂停、终止或结案，费用历史保留':!published?'请先沿原预算完成最终发布':!lines.length?'本单没有已采用的适用洗水安排':!permission?'洗水费用由本单主跟单或Root发布':'',
    comparison:published?await readBudgetQuoteComparison(db,orderId,row,true):null,lines,rows:published?row.document.rows.filter((r:{section:string;name:string})=>r.section==='外发工序'&&r.name):[],
    history:history.filter(item=>item.washing_supplement).map(item=>({...item.washing_supplement,version:item.version,publishedAt:new Date(item.published_at).toISOString()})),references};
   if(!client)await db.query('COMMIT');return result;
  }catch(error){if(!client)await db.query('ROLLBACK');throw error;}finally{if(!client)db.release();}
 }
 async publish(actor:TrustedActorContext,orderId:string,value:BudgetWashingFeeInput,key:string){
  const input=BudgetWashingFeeSchema.parse(value);if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))washingConflict('缺少有效操作标识');
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   if(!await this.authorize(db,actor,orderId,true))digitalForbidden();
   const command=`budget:${orderId}:washing-fee`,hash=washingHash(input),prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)washingConflict('操作标识已用于其他费用内容');await db.query('COMMIT');return prior.response as BudgetWashingFees;}
   const state=await this.read(actor,orderId,db);if(!state.canPublish)washingConflict(state.reason);
   if(state.budgetVersion!==input.expectedVersion)washingConflict('预算已变化，费用未覆盖，请重新读取');
   const line=state.lines.find(row=>row.lineId===input.lineId);if(!line||line.version!==input.expectedWashingVersion)washingConflict('本PO洗水安排已变化，费用未覆盖');
   let version=input.expectedVersion,rowId:string;
   if(input.source.kind==='existing'){
    version=input.source.version;rowId=input.source.rowId;
    if(line!.fee.kind==='budget_row'&&line!.fee.version===version&&line!.fee.rowId===rowId)washingConflict('本PO已采用此预算费用行，无需重复关联');
   }
   else{
    const current=(await db.query('SELECT * FROM digital_budget_documents WHERE production_order_id=$1 FOR UPDATE',[orderId])).rows[0];
    const document:BudgetDocument=BudgetDocumentSchema.parse(current.document),source=input.source;
    if(source.kind==='adjust'){
     const ref=line!.fee,old=document.rows.find(row=>row.rowId===source.rowId);
     if(ref.kind!=='budget_row'||ref.rowId!==source.rowId||!old||old.section!=='外发工序'||old.category!=='洗水')washingConflict('只能调整本PO当前引用的洗水行；其他预算及加工价不能改写');
     rowId=source.rowId;
    }else rowId=randomUUID();
    const row={...source.row,rowId,section:'外发工序' as const,category:'洗水'};
    const next=BudgetDocumentSchema.parse({...document,rows:source.kind==='adjust'?document.rows.map(old=>old.rowId===rowId?row:old):[...document.rows,row]});
    const comparison=await readBudgetQuoteComparison(db,orderId,{...current,document:next},true);
    if(comparison.policy==='quote_v1'){
     const checked=comparison.confirmation?compareQuotationBudget(next,comparison.confirmation,await formalOrderQuantity(db,orderId)):comparison;
     if(checked.state!=='within_limit')washingConflict(checked.reason);
    }
    version=input.expectedVersion+1;
    const supplement={kind:'washing_fee',action:source.kind,baseVersion:input.expectedVersion,lineId:input.lineId,rowId,reason:input.reason};
    await db.query(`INSERT INTO digital_budget_versions(production_order_id,version,document,totals,published_by,published_at,quote_id,quote_version,budget_comparable_total,confirmed_quote_total,washing_supplement)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[orderId,version,JSON.stringify(next),JSON.stringify(calculateBudget(next)),actor.actorId,businessNow().toISOString(),current.quote_id,current.quote_version,comparison.budgetComparableTotal,comparison.confirmedQuoteTotal,JSON.stringify(supplement)]);
    // Budget completion is the original publication fact, not this later fee
    // revision. Its own version above records the fee approval timestamp.
    await db.query(`UPDATE digital_budget_documents SET version=$2,document=$3,status='published',updated_by=$4,updated_at=CURRENT_TIMESTAMP WHERE production_order_id=$1`,[orderId,version,JSON.stringify(next),actor.actorId]);
    // Until an external sourcing case adopts the budget, its existing
    // preparation follows the published version. Keep the original task and
    // publication fact; linked sourcing/contracts retain their adopted basis.
    // Sourcing creation holds this same lifecycle lock, so the link check and
    // version advance cannot race a case adopting the previous version.
    await db.query(`UPDATE digital_budget_preparations p SET budget_version=$2
     WHERE p.production_order_id=$1 AND NOT EXISTS(
      SELECT 1 FROM digital_production_child_links l WHERE l.production_order_id=p.production_order_id AND l.module='sourcing')`,[orderId,version]);
   }
   const linked=await linkWashingBudgetFeeWithClient(db,actor,orderId,input.lineId,input.expectedWashingVersion,{kind:'budget_row',version,rowId});
   const response=await this.read(actor,orderId,db);
   await db.query('INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.requestId,actor.actorId,'budget_washing_fee','digital_budget',orderId,JSON.stringify({version,rowId,lineId:input.lineId,reason:input.reason,washingPlan:linked})]);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query('COMMIT');return response;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
}
