import type {Pool,PoolClient} from 'pg';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
type DB=Pick<Pool|PoolClient,'query'>;
const factoryScopeColumns=`p.production_order_id,p.factory_decision_id,p.sourcing_decision_id,p.supplier_id,p.supplier_name_snapshot,p.dispatched_at,line.position,line.completed_quantity,
  (SELECT status FROM sourcing_production_transitions state WHERE state.production_order_id=p.production_order_id AND state.factory_decision_id IS NOT DISTINCT FROM p.factory_decision_id ORDER BY sequence DESC LIMIT 1) AS execution_status,
  map.line_id,line.quantity,po.po_number,po.color,po.factory_delivery_date::text AS target_date`;
const factoryScopeFrom=`FROM digital_production_child_links link JOIN sourcing_production_factory_orders p ON p.production_order_id=link.child_id
  CROSS JOIN LATERAL sourcing_factory_execution_lines(p.production_order_id,p.sourcing_decision_id) line
  JOIN digital_production_child_lines map ON map.module='production' AND map.child_id=p.production_order_id AND map.child_line_key=line.position::text
  JOIN digital_production_po_lines po ON po.line_id=map.line_id AND po.production_order_id=link.production_order_id
  WHERE link.module='production'`;
/** Original factory execution allocations define scope; inspections never add production or receipt quantity. */
export async function factoryProductionScopes(db:DB,orderId:string,options:{includeZero?:boolean}={}){
 return (await db.query(`SELECT ${factoryScopeColumns}
  ${factoryScopeFrom} AND link.production_order_id=$1 ${options.includeZero?'':'AND line.quantity>0'} ORDER BY p.factory_decision_id NULLS FIRST,po.position`,[orderId])).rows;
}

/** Read the same effective allocations for an already selected set of masters. */
export async function factoryProductionScopesForOrders(db:DB,orderIds:readonly string[],options:{includeZero?:boolean}={}){
 const scopes=new Map<string,Awaited<ReturnType<typeof factoryProductionScopes>>>();
 if(!orderIds.length)return scopes;
 const rows=(await db.query(`SELECT link.production_order_id AS master_order_id,${factoryScopeColumns}
  ${factoryScopeFrom} AND link.production_order_id=ANY($1::uuid[]) ${options.includeZero?'':'AND line.quantity>0'}
  ORDER BY link.production_order_id,p.factory_decision_id NULLS FIRST,po.position`,[orderIds])).rows;
 for(const {master_order_id,...row} of rows){
  const current=scopes.get(master_order_id);
  if(current)current.push(row);else scopes.set(master_order_id,[row]);
 }
 return scopes;
}
/** Completion's business date belongs to its factory scope. A later shipment
 * or registration timestamp cannot replace that date. */
export async function factoryProductionCompletion(db:DB,orderId:string,lineIds?:readonly string[]){
 const scopes=(await factoryProductionScopes(db,orderId)).filter(scope=>!lineIds||lineIds.includes(scope.line_id));
 const transitions=(await db.query(`SELECT t.production_order_id,t.factory_decision_id,t.business_date::text,t.actor_id,u.display_name
  FROM sourcing_production_transitions t JOIN app_users u ON u.id=t.actor_id
  WHERE t.status='production_completed' AND EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='production' AND l.production_order_id=$1 AND l.child_id=t.production_order_id)`,[orderId])).rows;
 const rows=scopes.map(scope=>({scope,transition:transitions.find(t=>t.production_order_id===scope.production_order_id&&t.factory_decision_id===scope.factory_decision_id)}));
 const completed=rows.length>0&&rows.every(row=>['production_completed','shipped'].includes(row.scope.execution_status)&&row.transition);
 const dates=rows.map(row=>row.transition?.business_date as string|undefined);
 const operators=[...new Map(rows.flatMap(row=>row.transition?[[row.transition.actor_id,{id:row.transition.actor_id as string,name:row.transition.display_name as string|null}] as const]:[])).values()];
 return {completed,actualDate:completed&&dates.every(Boolean)?(dates as string[]).sort().at(-1)!:null,operators};
}
export type NativeFactoryTimeline={productionId:string;factoryDecisionId:string|null;lineId:string;quantity:number;
 dispatchedAt:string|null;startTransitionRef:string|null;completedDate:string|null;completionTransitionRef:string|null};
/** Preserve native factory/PO allocation and date precision. Dispatch starts
 * that execution, not a fictitious full-order R; QC is never production A.
 */
export async function nativeFactoryTimeline(db:DB,orderId:string):Promise<NativeFactoryTimeline[]>{
 const scopes=await factoryProductionScopes(db,orderId);
 if(!scopes.length)return [];
 const transitions=(await db.query(`SELECT t.production_transition_id,t.production_order_id,t.factory_decision_id,t.status,t.business_date::text,
   coalesce((event.after_state->'acceptanceClock'->>'now')::timestamptz,transfer.effective_at) AS transferred_at
  FROM sourcing_production_transitions t
  LEFT JOIN sourcing_production_factory_transfers transfer ON transfer.factory_decision_id=t.factory_decision_id AND transfer.production_order_id=t.production_order_id
  LEFT JOIN operation_events event ON event.event_id=transfer.operation_event_id
  WHERE t.production_order_id=ANY($1::uuid[]) AND t.status IN ('in_production','production_completed')
  ORDER BY t.production_order_id,t.factory_decision_id NULLS FIRST,t.sequence`,[[...new Set(scopes.map(scope=>scope.production_order_id))]])).rows;
 return scopes.map(scope=>{
  const events=transitions.filter(event=>event.production_order_id===scope.production_order_id&&event.factory_decision_id===scope.factory_decision_id);
  const start=events.find(event=>event.status==='in_production'),completion=events.find(event=>event.status==='production_completed');
  const completed=['production_completed','shipped'].includes(scope.execution_status)&&!!completion;
  const dispatchedAt=scope.factory_decision_id?start?.transferred_at:scope.dispatched_at;
  return {productionId:scope.production_order_id,factoryDecisionId:scope.factory_decision_id??null,lineId:scope.line_id,quantity:Number(scope.quantity),
   dispatchedAt:start&&dispatchedAt?new Date(dispatchedAt).toISOString():null,
   startTransitionRef:start?`sourcing_production_transitions:${start.production_transition_id}`:null,
   completedDate:completed?completion.business_date:null,completionTransitionRef:completed?`sourcing_production_transitions:${completion.production_transition_id}`:null};
 });
}
export async function factoryProductionFacts(db:DB,orderId:string){
 const allScopes=await factoryProductionScopes(db,orderId,{includeZero:true});
 const events=(await db.query(`SELECT e.*,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
 WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='factory_garment_qc' ORDER BY e.recorded_at,e.event_id`,[orderId])).rows;
 return projectFactoryProductionFacts(allScopes,events);
}

export async function factoryProductionFactsForOrders(db:DB,orderIds:readonly string[]){
 const result=new Map<string,ReturnType<typeof projectFactoryProductionFacts>>(),ids=[...new Set(orderIds)];
 if(!ids.length)return result;
 const scopes=await factoryProductionScopesForOrders(db,ids,{includeZero:true});
 const rows=(await db.query(`SELECT e.*,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
  WHERE e.resource_kind='order' AND e.resource_id=ANY($1::uuid[]) AND e.event_kind='factory_garment_qc' ORDER BY e.resource_id,e.recorded_at,e.event_id`,[ids])).rows;
 const history=new Map<string,typeof rows>();
 for(const event of rows){const list=history.get(event.resource_id);if(list)list.push(event);else history.set(event.resource_id,[event]);}
 for(const id of ids)result.set(id,projectFactoryProductionFacts(scopes.get(id)??[],history.get(id)??[]));
 return result;
}

type FactoryQcEvent={event_id:string;actor_id:string;display_name:string|null;occurred_at:Date|null;time_quality:string;
 payload:{productionId:string;factoryDecisionId:string|null;checks:Array<{lineId:string;allocationQuantity:number;result:'合格'|'需处理';problem:string;attachmentIds?:string[]}>}};
function projectFactoryProductionFacts(allScopes:Awaited<ReturnType<typeof factoryProductionScopes>>,events:readonly FactoryQcEvent[]){
 const scopes=allScopes.filter(scope=>Number(scope.quantity)>0);
 const checks=scopes.map(scope=>{
  const matches=events.filter(e=>e.payload.productionId===scope.production_order_id&&e.payload.factoryDecisionId===scope.factory_decision_id
   && e.payload.checks.some((c:{lineId:string;allocationQuantity:number})=>c.lineId===scope.line_id&&c.allocationQuantity>=scope.quantity));
  const first=matches[0],last=matches.at(-1),check=last?.payload.checks.find((c:{lineId:string})=>c.lineId===scope.line_id);
  return {productionId:scope.production_order_id as string,factoryDecisionId:scope.factory_decision_id as string|null,lineId:scope.line_id as string,
   supplierName:scope.supplier_name_snapshot as string,poNumber:scope.po_number as string|null,color:scope.color as string,quantity:Number(scope.quantity),targetDate:scope.target_date as string|null,
   inspected:!!first,completedAt:first?.occurred_at?new Date(first.occurred_at).toISOString():null,
   completedQuality:first?.time_quality as string|undefined,completedBy:first?{id:first.actor_id as string,name:first.display_name as string|null}:null,
   result:check?.result as '合格'|'需处理'|undefined,problem:check?.problem as string|undefined,operator:last?.display_name as string|undefined,eventId:first?.event_id as string|undefined};
 });
 const facts:Record<string,SlaNodeFact>={};
 for(const lineId of new Set(checks.map(c=>c.lineId))){const parts=checks.filter(c=>c.lineId===lineId),done=parts.every(c=>c.inspected);
  facts[`factory_production:${lineId}`]={businessCompleted:done,evidence:parts.map(c=>c.eventId??`factory:${c.productionId}:${c.factoryDecisionId??'original'}:unchecked`).join(','),
   ...(done&&parts.every(c=>c.completedAt)?{completedAt:new Date(Math.max(...parts.map(c=>Date.parse(c.completedAt!)))).toISOString()}:{})};
 }
 return {history:events.map(e=>({eventId:e.event_id as string,occurredAt:e.occurred_at?new Date(e.occurred_at).toISOString():null,operator:e.display_name as string,factoryDecisionId:e.payload.factoryDecisionId as string|null,...(e.payload.checks.some(check=>check.attachmentIds?.length)?{productionId:e.payload.productionId}:{}),supplierName:allScopes.find(scope=>scope.production_order_id===e.payload.productionId&&scope.factory_decision_id===(e.payload.factoryDecisionId??null))?.supplier_name_snapshot as string|undefined??null,checks:e.payload.checks as Array<{lineId:string;allocationQuantity:number;result:'合格'|'需处理';problem:string;attachmentIds?:string[]}>})),checks,facts,revision:events.length,complete:checks.length>0&&checks.every(c=>c.inspected)};
}
