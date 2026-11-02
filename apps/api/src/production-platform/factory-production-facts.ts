import type {Pool,PoolClient} from 'pg';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
type DB=Pick<Pool|PoolClient,'query'>;
/** Original factory execution allocations define scope; inspections never add production or receipt quantity. */
export async function factoryProductionScopes(db:DB,orderId:string){
 return (await db.query(`SELECT p.production_order_id,p.factory_decision_id,p.sourcing_decision_id,p.supplier_id,p.supplier_name_snapshot,p.dispatched_at,line.position,line.completed_quantity,
  (SELECT status FROM sourcing_production_transitions state WHERE state.production_order_id=p.production_order_id AND state.factory_decision_id IS NOT DISTINCT FROM p.factory_decision_id ORDER BY sequence DESC LIMIT 1) AS execution_status,
  map.line_id,line.quantity,po.po_number,po.color,po.factory_delivery_date::text AS target_date
  FROM digital_production_child_links link JOIN sourcing_production_factory_orders p ON p.production_order_id=link.child_id
  CROSS JOIN LATERAL sourcing_factory_execution_lines(p.production_order_id,p.sourcing_decision_id) line
  JOIN digital_production_child_lines map ON map.module='production' AND map.child_id=p.production_order_id AND map.child_line_key=line.position::text
  JOIN digital_production_po_lines po ON po.line_id=map.line_id AND po.production_order_id=link.production_order_id
  WHERE link.module='production' AND link.production_order_id=$1 AND line.quantity>0 ORDER BY p.factory_decision_id NULLS FIRST,po.position`,[orderId])).rows;
}
export async function factoryProductionFacts(db:DB,orderId:string){
 const scopes=await factoryProductionScopes(db,orderId);
 const events=(await db.query(`SELECT e.*,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
 WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='factory_garment_qc' ORDER BY e.recorded_at,e.event_id`,[orderId])).rows;
 const checks=scopes.map(scope=>{
  const matches=events.filter(e=>e.payload.productionId===scope.production_order_id&&e.payload.factoryDecisionId===scope.factory_decision_id
   && e.payload.checks.some((c:{lineId:string;allocationQuantity:number})=>c.lineId===scope.line_id&&c.allocationQuantity>=scope.quantity));
  const first=matches[0],last=matches.at(-1),check=last?.payload.checks.find((c:{lineId:string})=>c.lineId===scope.line_id);
  return {productionId:scope.production_order_id as string,factoryDecisionId:scope.factory_decision_id as string|null,lineId:scope.line_id as string,
   supplierName:scope.supplier_name_snapshot as string,poNumber:scope.po_number as string|null,color:scope.color as string,quantity:Number(scope.quantity),targetDate:scope.target_date as string|null,
   inspected:!!first,completedAt:first?.occurred_at?new Date(first.occurred_at).toISOString():null,
   result:check?.result as '合格'|'需处理'|undefined,problem:check?.problem as string|undefined,operator:last?.display_name as string|undefined,eventId:first?.event_id as string|undefined};
 });
 const facts:Record<string,SlaNodeFact>={};
 for(const lineId of new Set(checks.map(c=>c.lineId))){const parts=checks.filter(c=>c.lineId===lineId),done=parts.every(c=>c.inspected);
  facts[`factory_production:${lineId}`]={businessCompleted:done,evidence:parts.map(c=>c.eventId??`factory:${c.productionId}:${c.factoryDecisionId??'original'}:unchecked`).join(','),
   ...(done&&parts.every(c=>c.completedAt)?{completedAt:new Date(Math.max(...parts.map(c=>Date.parse(c.completedAt!)))).toISOString()}:{})};
 }
 return {history:events.map(e=>({eventId:e.event_id as string,occurredAt:e.occurred_at?new Date(e.occurred_at).toISOString():null,operator:e.display_name as string,factoryDecisionId:e.payload.factoryDecisionId as string|null,checks:e.payload.checks as Array<{lineId:string;allocationQuantity:number;result:'合格'|'需处理';problem:string}>})),checks,facts,revision:events.length,complete:checks.length>0&&checks.every(c=>c.inspected)};
}
