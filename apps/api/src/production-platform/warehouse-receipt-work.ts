import type {Pool,PoolClient} from 'pg';
import type {PreparationResource,ProductionReadinessState} from '@dx-rework/contracts/production-readiness';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {digitalForbidden} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {workbenchPreorderPublication} from './development-source-lifecycle.js';
import {assignedWarehousePreparationResources} from './warehouse-assigned-resources.js';
import {deriveWarehouseReceiptWork} from './warehouse-receipt-projection.js';
import {readWarehouseInstructionDemands} from './warehouse-instruction-demand.js';
import {readWarehouseReceiptReconciliations,reconciliationResourceKey} from './warehouse-receipt-reconciliation-repository.js';
import {acceptanceBusinessContext,businessNow} from '../acceptance-clock/business-time.js';

/** Exact resource read for the original assigned warehouse identity. This
 * read performs no business writes, does not open a new task, and does not
 * convert an unactionable draft, report or quality gate to a physical receipt. */
export async function readWarehouseReceiptWork(db:Pool,actor:TrustedActorContext,resource:PreparationResource,read:(connection:PoolClient)=>Promise<ProductionReadinessState>,includeReconciliation=false){
 const connection=await db.connect();
 try{
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(!isRootActor(actor)&&!(await assignedWarehousePreparationResources(connection,actor))
   .some(key=>key.kind===resource.kind&&key.id===resource.id))return digitalForbidden();
  const state=await read(connection);
  const eligible=state.canRecord.some(kind=>kind==='fabric_receipt'||kind==='accessories_ready')&&
   (resource.kind==='order'||(await developmentDocumentRow(connection,resource.id))?.status==='published'||
    Boolean(await workbenchPreorderPublication(connection,resource.id)));
  const adopted=eligible&&resource.kind==='order'?(await readWarehouseInstructionDemands(connection,[resource.id])).get(resource.id):undefined;
  const resources=[resource,...(resource.kind==='order'&&state.sourceId?[{kind:'source' as const,id:state.sourceId}]:[])];
  const rows=eligible&&includeReconciliation?await readWarehouseReceiptReconciliations(connection,resources):null;
  const bindings=rows?resources.flatMap(scope=>rows.get(reconciliationResourceKey(scope))??[]):undefined;
  const items=eligible?deriveWarehouseReceiptWork(state,businessNow().toISOString(),adopted,bindings):[];
  const context=acceptanceBusinessContext();
  if(context?.scenarioId&&await context.acceptsActor(actor.actorId))for(const item of items){
   if(item.reconciliation)item.reconciliation.allowOperatorAttestation=true;
  }
  await connection.query('COMMIT');return items;
 }catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
}
