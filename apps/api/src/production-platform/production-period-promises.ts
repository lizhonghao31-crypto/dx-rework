import type {PoolClient} from 'pg';
import type {ProductionPromiseVersion} from '@dx-rework/contracts/production-period';
import type {StatisticsTime} from '@dx-rework/contracts/production-statistics';
import {slaDateBoundary} from '@dx-rework/domain/digital-sla-plan';
import {SlaPlanRepository} from './sla-plan-repository.js';

const businessInstant=(value:unknown,source:string):StatisticsTime=>{const time=value as {now?:unknown}|null,valid=typeof time?.now==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time.now)&&Number.isFinite(Date.parse(time.now));return {at:valid?new Date(time.now as string).toISOString():null,date:null,precision:valid?'instant':'unknown',quality:valid?'verified':'unknown',sourceRefs:[source]};};
/** Original approved append-only date changes are the promise chain. The first
 * order's server-authored business time and the matching SLA change plan supply
 * effectivity; neither an audit recording date nor today's field fills a gap. */
export async function productionPeriodPromises(db:PoolClient,orderId:string,lineIds:readonly string[]):Promise<ProductionPromiseVersion[]>{
 const originalInstruction=(await db.query("SELECT version.document->>'category' AS category FROM digital_factory_routes route JOIN digital_bulk_preparations preparation USING(preparation_id) JOIN digital_instruction_versions version ON version.production_order_id=route.production_order_id AND version.version=preparation.instruction_version WHERE route.production_order_id=$1",[orderId])).rows[0];
 const ids=new Set(lineIds),plans=await new SlaPlanRepository(db).plans(orderId),changes=(await db.query(`SELECT fact.*,fact.new_date::text AS actual_date,audit.action,audit.after_state FROM digital_po_date_changes fact JOIN audit_events audit ON audit.id=fact.approval_event_id WHERE fact.production_order_id=$1 ORDER BY fact.line_id,fact.date_kind,fact.version`,[orderId])).rows,result:ProductionPromiseVersion[]=[];
 for(const row of changes){if(!ids.has(row.line_id))continue;const kind=row.date_kind as 'customer'|'factory',anchorKey=(kind==='customer'?'customer_shipping_date:':'factory_delivery_date:')+row.line_id,ref='digital_po_date_changes:'+row.approval_event_id+':'+row.line_id;
  const matched=plans.find(plan=>{const anchor=plan.plan.anchors[anchorKey];return anchor?.precision==='date'&&anchor.value===row.actual_date&&anchor.source===ref;}),initial=row.source==='initial_po'&&row.action==='digital_order_created',effective=initial?businessInstant(row.after_state?.slaBusinessTime,'audit_events:'+row.approval_event_id+':slaBusinessTime'):businessInstant(matched?.time,matched?'sla-plan:'+matched.planId:ref+':missing-effectivity');
  result.push({scopeId:kind+':'+row.line_id,version:Number(row.version),promiseId:row.change_id,orderId,lineId:row.line_id,kind,ruleVersion:kind==='customer'?'native-customer-date-exclusive-v1':'factory-delivery-milestone-unverified',category:originalInstruction?.category??null,deadline:slaDateBoundary(row.actual_date).at!,deadlinePrecision:'date',deadlineExclusive:true,effective,recordedAt:new Date(row.created_at).toISOString(),sourceRefs:[ref,'audit_events:'+row.approval_event_id,...matched?['sla-plan:'+matched.planId]:[]]});
 }
 return result;
}
