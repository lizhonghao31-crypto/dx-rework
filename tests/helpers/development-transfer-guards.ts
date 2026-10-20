import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import type {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {AccessMasterDataService} from '../../apps/api/src/access/service.js';
import {arrangementInput} from './development-arrangement-fixture.js';
export async function exerciseDevelopmentTransfer(db:Pool,execution:DevelopmentExecutionService,native:PatternRoomOrderService,root:TrustedActorContext,clerk:TrustedActorContext,sourceId:string,orderId:string,workerId:string,replacementId:string,authorityOnly=false){
 const initial=await execution.read(root,sourceId),plan=initial.arrangement!,sewing=plan.rows.find(row=>row.kind==='development_sewing')!;
 const order=await native.get(root,orderId),round=order.rounds.find(row=>row.roundId===order.currentRoundId)!,segment=round.segments.at(-1)!;
 const person=(await db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active ORDER BY person_id LIMIT 1',[replacementId])).rows[0];if(!person)throw Error('TEST replacement master-data fixture missing');
 const body={orderId,roundId:order.currentRoundId,version:order.version,segmentId:segment.segmentId,personId:person.person_id,amount:'0.000',reason:'TEST-P05实际换人，原工人无本段工作',roundNumber:plan.roundNumber,expectedDocumentVersion:plan.documentVersion,expectedArrangementVersion:plan.version,expectedTask:{taskId:sewing.taskId!,state:sewing.state!,assigneeId:sewing.assigneeId}};
 const version=async()=>(await native.get(root,orderId)).version;
 if(authorityOnly){
 // Native authority remains valid even while another authorized identity owns
 // daily arrangements. Synchronization preserves that manager and other rows.
 const takeover=await arrangementInput(db,execution,root,sourceId,workerId);
 await execution.arrange(root,sourceId,{...takeover,management:'takeover',managementReason:'TEST Root保留安排管理，主管仍可合法原执行换人'},randomUUID());
 const supervisorId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='pattern_room_supervisor' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
 const supervisor:TrustedActorContext={...root,actorId:supervisorId,actorRoles:['pattern_room_supervisor'],authorizationCapability:'pattern_room:orders:transfer',authorizationCapabilities:['pattern_room:orders:view','pattern_room:orders:transfer','digital_production:view','todo:view']};
 const tasks=new DigitalProductionTaskService(db);const worker=(id:string):TrustedActorContext=>({actorId:id,actorRoles:['pattern_room_worker'],authorizationCapability:'todo:view',authorizationCapabilities:['todo:view','digital_production:view','pattern_room:orders:view','pattern_room:orders:complete'],requestId:randomUUID()});
 const managed=await execution.read(root,sourceId),managedPlan=managed.arrangement!,managedTask=managedPlan.rows.find(r=>r.kind==='development_sewing')!,priorNative=await native.get(root,orderId),priorSegment=priorNative.rounds.find(r=>r.roundId===priorNative.currentRoundId)!.segments.at(-1)!;
 await execution.transferExecution(supervisor,sourceId,{...body,version:priorNative.version,segmentId:priorSegment.segmentId,expectedArrangementVersion:managedPlan.version,expectedTask:{taskId:managedTask.taskId!,state:managedTask.state!,assigneeId:managedTask.assigneeId}},randomUUID());
 const afterSupervisor=await execution.read(root,sourceId);expect(afterSupervisor.arrangement!.managerId).toBe(root.actorId);expect(afterSupervisor.arrangement!.rows.find(r=>r.kind==='development_sewing')!.assigneeId).toBe(replacementId);expect(afterSupervisor.arrangement!.rows.filter(r=>r.kind!=='development_sewing')).toEqual(managedPlan.rows.filter(r=>r.kind!=='development_sewing'));
 // Master-data fixture only; never give Root a normal worker role to make the
 // business test pass. The original native self-work exception is the authority.
 const existingRoot=(await db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[root.actorId])).rows[0];
 const rootPerson=existingRoot?.person_id??(await new AccessMasterDataService(db,'corp').createPerson({...root,authorizationCapability:'master_data:manage'},{personType:'internal',appUserId:root.actorId,displayName:'TEST P05 Root执行身份',aliases:[],reason:'TEST原有Root自接手主数据'})).personId;
 const forbiddenPlan=await arrangementInput(db,execution,root,sourceId,workerId);forbiddenPlan.entries.find(r=>r.kind==='development_sewing')!.assigneeId=root.actorId;forbiddenPlan.entries.find(r=>r.kind==='development_sewing')!.reason='TEST不能经日常安排发明Root候选';
 await expect(execution.arrange(root,sourceId,forbiddenPlan,randomUUID())).rejects.toMatchObject({statusCode:409});
 const actual=await native.get(root,orderId),actualSegment=actual.rounds.find(r=>r.roundId===actual.currentRoundId)!.segments.at(-1)!,rootBody={roundId:actual.currentRoundId,version:actual.version,segmentId:actualSegment.segmentId,personId:rootPerson,amount:'0',reason:'TEST原有Root自接手特例'};
 await expect(native.transfer(clerk,orderId,rootBody,randomUUID())).rejects.toMatchObject({statusCode:403});expect((await native.get(root,orderId)).version).toBe(actual.version);
 await native.transfer(root,orderId,rootBody,randomUUID());
 const rootPlan=(await execution.read(root,sourceId)).arrangement!;expect(rootPlan.managerId).toBe(root.actorId);expect(rootPlan.rows.find(r=>r.kind==='development_sewing')).toMatchObject({assigneeId:root.actorId,valid:true});expect((await tasks.read(root,sewing.taskId!)).canExecute).toBe(true);
 expect((await db.query("SELECT count(*)::int n FROM user_role_assignments WHERE user_id=$1 AND role_code='pattern_room_worker' AND revoked_at IS NULL",[root.actorId])).rows[0].n).toBe(0);
 expect((await db.query('SELECT sum(amount)=$2::numeric AS balanced FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId,segment.amount])).rows[0].balanced).toBe(true);
 await expect(tasks.read(worker(replacementId),sewing.taskId!)).rejects.toMatchObject({statusCode:404});
  return;
 }
 await expect(execution.readNativeExecution(clerk,sourceId)).rejects.toMatchObject({statusCode:403});
 expect((await execution.transferExecutionReceipt(root,sourceId,randomUUID())).receipt).toBeNull();
 await expect(execution.transferExecutionReceipt(clerk,sourceId,randomUUID())).rejects.toMatchObject({statusCode:403});
 await expect(execution.transferExecution(clerk,sourceId,body,randomUUID())).rejects.toMatchObject({statusCode:403});
 for(const input of [{...body,orderId:randomUUID()},{...body,roundNumber:plan.roundNumber+1},{...body,expectedArrangementVersion:plan.version+1},{...body,expectedDocumentVersion:plan.documentVersion+1},{...body,expectedTask:{...body.expectedTask,assigneeId:replacementId}}]){
  await expect(execution.transferExecution(root,sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:409});expect(await version()).toBe(order.version);
 }
 await expect(execution.transferExecution(root,sourceId,{...body,amount:'999999999999.000'},randomUUID())).rejects.toMatchObject({statusCode:400});
 await db.query("CREATE FUNCTION test_p05_transfer_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST-P05 atomic rollback'; END $$");
 await db.query("CREATE TRIGGER test_p05_transfer_rollback BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action='development_round_arranged') EXECUTE FUNCTION test_p05_transfer_rollback()");
 try{await expect(execution.transferExecution(root,sourceId,body,randomUUID())).rejects.toThrow('TEST-P05 atomic rollback');}finally{await db.query('DROP TRIGGER test_p05_transfer_rollback ON audit_events');await db.query('DROP FUNCTION test_p05_transfer_rollback()');}
 expect(await version()).toBe(order.version);expect((await native.get(root,orderId)).rounds.find(row=>row.roundId===order.currentRoundId)!.segments).toHaveLength(1);
 expect((await execution.read(root,sourceId)).arrangement!.version).toBe(plan.version);
 const auditBefore=Number((await db.query("SELECT count(*) n FROM audit_events WHERE entity_id=$1 AND action='development_round_arranged'",[sourceId])).rows[0].n);
 const key='p05-'+ 'x'.repeat(124);await Promise.all([execution.transferExecution(root,sourceId,body,key),execution.transferExecution(root,sourceId,body,key)]);
 const changed=await native.get(root,orderId),current=changed.rounds.find(row=>row.roundId===order.currentRoundId)!,updated=await execution.read(root,sourceId);
 expect(await execution.transferExecutionReceipt(root,sourceId,key)).toMatchObject({committedVersion:order.version+1,receipt:{version:order.version+1,currentWorkerName:changed.currentWorkerName}});
 expect(changed.version).toBe(order.version+1);expect(current.segments).toHaveLength(2);expect(current.segments[0]!.workerUserId).toBe(workerId);expect(current.segments[0]!.amount).toMatch(/^0(?:\.0+)?$/);expect(current.segments[1]!.workerUserId).toBe(replacementId);
 expect((await db.query('SELECT sum(amount)=$2::numeric AS balanced FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId,segment.amount])).rows[0].balanced).toBe(true);
 expect(updated.tasks.find(task=>task.taskId===sewing.taskId)).toMatchObject({enteredAt:initial.tasks.find(task=>task.taskId===sewing.taskId)!.enteredAt,dueAt:initial.tasks.find(task=>task.taskId===sewing.taskId)!.dueAt});
 expect(updated.arrangement!.version).toBe(plan.version+1);expect(updated.arrangement!.rows.find(row=>row.kind==='development_sewing')).toMatchObject({taskId:sewing.taskId,assigneeId:replacementId});
 expect(updated.arrangement!.rows.filter(row=>row.kind!=='development_sewing')).toEqual(plan.rows.filter(row=>row.kind!=='development_sewing'));
 expect(Number((await db.query("SELECT count(*) n FROM audit_events WHERE entity_id=$1 AND action='development_round_arranged'",[sourceId])).rows[0].n)).toBe(auditBefore+1);
 const worker=(id:string):TrustedActorContext=>({actorId:id,actorRoles:['pattern_room_worker'],authorizationCapability:'todo:view',authorizationCapabilities:['todo:view','digital_production:view','pattern_room:orders:view','pattern_room:orders:complete'],requestId:randomUUID()});
 const tasks=new DigitalProductionTaskService(db);await expect(tasks.read(worker(workerId),sewing.taskId!)).rejects.toMatchObject({statusCode:404});expect((await tasks.read(worker(replacementId),sewing.taskId!)).canExecute).toBe(true);
 const todos=new TodoService(db,undefined,undefined,undefined,new DigitalProductionNotificationService(db));
 const oldList=await todos.listForActor(worker(workerId),{module:'digital_production',query:initial.sheet.designStyleNo!}),newList=await todos.listForActor(worker(replacementId),{module:'digital_production',query:initial.sheet.designStyleNo!});
 expect(oldList.todos.filter(todo=>todo.entityId===sewing.taskId)).toHaveLength(0);expect(newList.todos.filter(todo=>todo.entityId===sewing.taskId)).toHaveLength(1);
 expect((await db.query("SELECT count(*)::int n FROM rework_todos WHERE dedupe_key=$1 AND status='pending'",[`pattern-room:${orderId}:${order.currentRoundId}:execution:${current.segments[1]!.segmentId}`])).rows[0].n).toBe(0);
 // Original linked endpoint is retained and must use the same transactional synchronization.
 const originalPerson=(await db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active ORDER BY person_id LIMIT 1',[workerId])).rows[0].person_id;
 await native.transfer(root,orderId,{roundId:changed.currentRoundId,version:changed.version,segmentId:current.segments[1]!.segmentId,personId:originalPerson,amount:'0',reason:'TEST-P05原入口同步回归'},randomUUID());
 expect((await execution.read(root,sourceId)).arrangement!.rows.find(row=>row.kind==='development_sewing')!.assigneeId).toBe(workerId);
 await expect(tasks.read(worker(replacementId),sewing.taskId!)).rejects.toMatchObject({statusCode:404});
 expect((await db.query('SELECT sum(amount)=$2::numeric AS balanced FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId,segment.amount])).rows[0].balanced).toBe(true);
 expect(await execution.transferExecutionReceipt(root,sourceId,key)).toMatchObject({committedVersion:order.version+1,receipt:{version:order.version+2}});

}
