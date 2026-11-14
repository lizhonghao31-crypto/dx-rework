import {acceptanceBusinessContext} from '../../apps/api/src/acceptance-clock/business-time.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {DevelopmentArrangementInput} from '@dx-rework/contracts/development-arrangement';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
export async function arrangementInput(db:Pool,execution:DevelopmentExecutionService,actor:TrustedActorContext,sourceId:string,workerId:string):Promise<DevelopmentArrangementInput>{
 const plan=(await execution.read(actor,sourceId)).arrangement!;
 const entries=[];
 for(const row of plan.rows){
  const candidates=row.requiredRole==='pattern_room_worker'?[{user_id:workerId}]:(await db.query(`SELECT a.user_id FROM user_role_assignments a JOIN app_users u ON u.id=a.user_id WHERE a.role_code=$1 AND a.revoked_at IS NULL AND u.enabled ORDER BY a.user_id`,[row.requiredRole])).rows;const context=acceptanceBusinessContext();let id:string|null=null;for(const candidate of candidates)if(!context||await context.acceptsActor(candidate.user_id)){id=candidate.user_id;break;}
  entries.push({... (row.stepRef?{stepRef:row.stepRef}:{}),kind:row.kind as DevelopmentArrangementInput['entries'][number]['kind'],assigneeId:row.editable?id:row.assigneeId,expectedTask:row.taskId?{taskId:row.taskId,state:row.state!,assigneeId:row.assigneeId}:null,reason:row.assigneeId&&id!==row.assigneeId?'TEST明确改派':''});
 }
 return {roundNumber:plan.roundNumber,expectedDocumentVersion:plan.documentVersion,expectedVersion:plan.version,entries,management:'keep',managementReason:''};
}
export async function arrangeTestRound(db:Pool,execution:DevelopmentExecutionService,actor:TrustedActorContext,sourceId:string,workerId:string){
 return execution.arrange(actor,sourceId,await arrangementInput(db,execution,actor,sourceId,workerId),randomUUID());
}
