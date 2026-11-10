import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {OperationEventRepository} from '../tools/repositories.js';
import type {TodoProjectionService} from '../todos/projection-service.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {memberCanWriteModule} from '../access/member-module-policy.js';
import {ContextBusinessClock} from '../acceptance-clock/business-time.js';

type DB=Pick<PoolClient,'query'>;
/** Ordinary legacy sourcing keeps its original creator-based workflow. Digital
 * approval also requires the current mother-order contract recipient to exist. */
export async function sourcingOwnerReady(db:DB,caseId:string){
 const row=(await db.query("SELECT to_jsonb(s)->>'workflow_generation' AS generation FROM sourcing_cases s WHERE s.sourcing_case_id=$1",[caseId])).rows[0];
 if(!row)return false;
 if(row.generation!=='digital_production_v1')return true;
 const id=(await db.query(`SELECT o.primary_merchandiser_id FROM digital_production_child_links l
  JOIN digital_production_orders o USING(production_order_id) WHERE l.module='sourcing' AND l.child_id=$1`,[caseId])).rows[0]?.primary_merchandiser_id;
 if(!id||!await new DigitalProductionAccessPolicy(db).activeRole(id,'order_merchandiser')||!await memberCanWriteModule(db,id,'sourcing'))return false;
 return (await db.query("SELECT todo_user_has_direct_role($1::uuid,'order_merchandiser','sourcing:contract:record') AS eligible",[id])).rows[0]?.eligible===true;
}

/** The caller owns the existing lifecycle lock and transaction. Missing staff
 * must not start an approval clock. The original personnel command releases a
 * previously uncreated approval once, from its real business-time event. */
export async function releaseSourcingOwnerApproval(database:Pool,db:PoolClient,actor:TrustedActorContext,orderId:string,projection:TodoProjectionService){
 if(!(await db.query("SELECT 1 FROM digital_production_child_links WHERE production_order_id=$1 AND module='sourcing' LIMIT 1",[orderId])).rowCount)return;
 const rows=(await db.query(`SELECT s.sourcing_case_id,d.sourcing_decision_id,d.decision_version FROM digital_production_child_links l
  JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id AND to_jsonb(s)->>'workflow_generation'='digital_production_v1' AND s.deleted_at IS NULL
  JOIN current_sourcing_cases c ON c.sourcing_case_id=s.sourcing_case_id
  JOIN LATERAL(SELECT sourcing_decision_id,decision_version,operation_event_id FROM sourcing_decisions WHERE sourcing_case_id=s.sourcing_case_id ORDER BY decision_version DESC LIMIT 1)d ON true
  JOIN operation_events origin ON origin.event_id=d.operation_event_id AND origin.action='sourcing.management_decision.record'
  WHERE l.module='sourcing' AND l.production_order_id=$1 AND c.status='pending_owner_approval'
   AND origin.after_state->'approvalReadiness'->>'version'='1' AND origin.after_state->'approvalReadiness'->>'waitingFor'='primary_merchandiser'
   AND NOT EXISTS(SELECT 1 FROM rework_todos t WHERE t.entity_type='sourcing_case' AND t.entity_id=s.sourcing_case_id::text
    AND t.category='sourcing_owner_approval' AND t.todo_type='business_action'
    AND t.dedupe_key LIKE 'sourcing:'||s.sourcing_case_id::text||':owner:'||d.decision_version::text||':%')`,[orderId])).rows;
 if(!rows.length)return;
 const time=await new ContextBusinessClock(database,db).read({kind:'order',id:orderId});
 for(const row of rows){
  if(!await sourcingOwnerReady(db,row.sourcing_case_id))continue;
  const eventId=await new OperationEventRepository().append(db,actor,{action:'sourcing.owner.ready',entityType:'sourcing_case',entityId:row.sourcing_case_id,
   after:{decisionId:row.sourcing_decision_id,approvalReadiness:{version:1,readyAt:time.now,basis:'current-primary-merchandiser-assigned'}},reason:'主跟单已合法指派，老板审批条件齐备'});
  await projection.actionableForAllAssignedRole(db,actor,{category:'sourcing_owner_approval',sourceEventId:eventId,sourceAction:'sourcing.owner.ready',entityType:'sourcing_case',entityId:row.sourcing_case_id,
   requiredRole:'owner_group',requiredCapability:'sourcing:owner:approve',route:{routeName:'sourcing_detail',entityId:row.sourcing_case_id},policyKey:'general',dedupeKey:`sourcing:${row.sourcing_case_id}:owner:${row.decision_version}`});
 }
}
