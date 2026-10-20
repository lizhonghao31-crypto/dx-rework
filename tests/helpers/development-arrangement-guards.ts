import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {Pool} from 'pg';
import type {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {arrangementInput} from './development-arrangement-fixture.js';
import {arrangementTodos} from '../../apps/api/src/production-platform/development-arrangement-todos.js';
export async function exerciseArrangementGuards(db:Pool,execution:DevelopmentExecutionService,clerk:TrustedActorContext,root:TrustedActorContext,sourceId:string,workerId:string,denied:TrustedActorContext){
 const initial=await arrangementInput(db,execution,clerk,sourceId,workerId);
 await expect(execution.arrange(denied,sourceId,initial,randomUUID())).rejects.toMatchObject({statusCode:404});
 const invalid=structuredClone(initial);invalid.entries.find(row=>row.kind==='development_sewing')!.assigneeId=clerk.actorId;
 await expect(execution.arrange(clerk,sourceId,invalid,randomUUID())).rejects.toThrow('有效岗位');
 expect((await execution.read(clerk,sourceId)).arrangement?.version).toBe(initial.expectedVersion);
 const staleDocument={...initial,expectedDocumentVersion:initial.expectedDocumentVersion+1};
 await expect(execution.arrange(clerk,sourceId,staleDocument,randomUUID())).rejects.toThrow('资料已更新');
 const takeover={...initial,management:'takeover' as const,managementReason:'TEST主管接管安排'};
 await expect(execution.arrange(clerk,sourceId,takeover,randomUUID())).rejects.toMatchObject({statusCode:403});
 const supervisorId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='pattern_room_supervisor' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
 const supervisor={...root,actorId:supervisorId,actorRoles:['pattern_room_supervisor']};
 await execution.arrange(supervisor,sourceId,takeover,randomUUID());
 const controlled=await arrangementInput(db,execution,clerk,sourceId,workerId);
 await expect(execution.arrange(clerk,sourceId,controlled,randomUUID())).rejects.toThrow('接管');
 await execution.arrange(supervisor,sourceId,{...controlled,management:'release',managementReason:'TEST交回日常文员'},randomUUID());
 const racing=await arrangementInput(db,execution,clerk,sourceId,workerId);
 const results=await Promise.allSettled([execution.arrange(clerk,sourceId,racing,randomUUID()),execution.arrange(clerk,sourceId,racing,randomUUID())]);
 expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);
 const changed=await arrangementInput(db,execution,clerk,sourceId,workerId),stale=structuredClone(changed);
 stale.entries.find(row=>row.kind==='development_pattern')!.expectedTask!.state='pending';
 await expect(execution.arrange(clerk,sourceId,stale,randomUUID())).rejects.toThrow('已被办理或改派');
 const enabled=async(value:boolean)=>{const client=await db.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('dx_rework.employee_access_actor_id',$1,true)",[root.actorId]);await client.query('UPDATE app_users SET enabled=$2 WHERE id=$1',[workerId,value]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
 await enabled(false);
 try{
  expect((await arrangementTodos(db,clerk)).filter(todo=>todo.entityId===sourceId)).toHaveLength(1);
  await expect(execution.arrange(clerk,sourceId,changed,randomUUID())).rejects.toThrow('有效岗位');
 }finally{await enabled(true);}
 expect((await db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='development_round_arranged' AND after_state->>'management' IN ('takeover','release')",[sourceId])).rows[0].n).toBe(2);
}
