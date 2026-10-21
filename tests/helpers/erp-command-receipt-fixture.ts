import {EmployeeAccessService} from "../../apps/api/src/access/employee-access-service.js";
import {AccessMasterDataService} from "../../apps/api/src/access/service.js";
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {expect} from 'vitest';
import {ErpEmergencyReworkIntakeV1Schema,ErpEmergencyLinkV1Schema,ErpReworkIntakeV1Schema,ErpCommandReceiptSchema,serializeErpCommandFingerprint,type ErpCommandScope} from '@dx-rework/contracts/erp-integration';
import {ErpIntegrationService} from '../../apps/api/src/erp/erp-integration-service.js';
import {createErpIntegrationActor,ERP_INTEGRATION_SERVICE_ACTOR_ID} from '../../apps/api/src/erp/erp-integration-identity.js';
import {IdempotencyRepository,type TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
const fingerprint=(scope:ErpCommandScope,input:unknown)=>createHash('sha256').update(serializeErpCommandFingerprint(scope,input)).digest('hex');
export async function exerciseErpReceipt(db:Pool,merchandiser:string,admin:TrustedActorContext,denied:TrustedActorContext,todos:TodoProjectionService,root:TrustedActorContext){
 // TEST identity initialization only: 0089 disables non-human principals with
 // no manual grants. Simulate an explicitly configured integration in this
 // owned schema; no human identity/role is added and production stays disabled.
 const originalPrincipal=(await db.query('SELECT enabled FROM app_users WHERE id=$1',[ERP_INTEGRATION_SERVICE_ACTOR_ID])).rows[0];expect(originalPrincipal).toBeDefined();
 expect((await db.query('SELECT 1 FROM identity_mappings WHERE user_id=$1',[ERP_INTEGRATION_SERVICE_ACTOR_ID])).rowCount).toBe(0);
 await db.query('UPDATE app_users SET enabled=true WHERE id=$1',[ERP_INTEGRATION_SERVICE_ACTOR_ID]);
 try{

 const service=new ErpIntegrationService(db,'corp',undefined,undefined,undefined,todos),actor=createErpIntegrationActor('TEST-p15'),key=randomUUID();
 const input=ErpReworkIntakeV1Schema.parse({contractVersion:'1',source:{sourceSystem:'erp',externalId:`TEST-ERP-${key}`,externalIdempotencyKey:key,erpNodeId:null},payload:{styleNo:'TEST-ERP-RECEIPT',orderNo:null,merchandiserUserId:merchandiser,processingFactory:{type:'own_factory'},problemPart:'TEST部位',problemDescription:'TEST合成问题',reworkQuantity:12}});
 const hash=fingerprint('erp.rework.intake.v1',input);
 const [created,replayed]=await Promise.all([service.intakeFromErp(actor,input,key),service.intakeFromErp(actor,input,key)]);
 expect(created.value.reworkOrderId).toBe(replayed.value.reworkOrderId);expect([created.reused,replayed.reused].sort()).toEqual([false,true]);
 const orderId=created.value.reworkOrderId;
 const snapshot=async()=>({
  idem:(await db.query('SELECT * FROM idempotency_records WHERE scope LIKE \'erp.rework.%\' ORDER BY scope,actor_key,idempotency_key')).rows,
  intake:(await db.query('SELECT * FROM erp_rework_intakes WHERE rework_order_id=$1',[orderId])).rows,
  events:(await db.query("SELECT * FROM operation_events WHERE entity_type='rework_order' AND entity_id=$1 ORDER BY event_id",[orderId])).rows,
  outbox:(await db.query('SELECT * FROM message_outbox WHERE aggregate_id=$1 ORDER BY event_id',[orderId])).rows,
  todos:(await db.query("SELECT * FROM rework_todos WHERE entity_id=$1 ORDER BY todo_id",[orderId])).rows,
 });
 const before=await snapshot(),receipt=ErpCommandReceiptSchema.parse(await service.intakeReceipt(actor,key,hash));expect(receipt).toMatchObject({outcome:'confirmed',receipt:created.value});expect(await snapshot()).toEqual(before);
 expect(before.events.filter(row=>row.action==='rework.submit')).toHaveLength(1);expect(before.outbox.filter(row=>row.topic==='rework.pending_process_configuration')).toHaveLength(1);expect(before.todos).toHaveLength(1);
 await expect(service.intakeReceipt(actor,key,'b'.repeat(64))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT',statusCode:409});
 await expect(service.intakeReceipt(denied,key,hash)).rejects.toMatchObject({statusCode:403});
 await expect(service.intakeFromErp({...actor,actorRoles:['system_admin']},input,key)).rejects.toMatchObject({statusCode:403});
 const changed={...input,payload:{...input.payload,reworkQuantity:13}};await expect(service.intakeFromErp(actor,changed,key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT',statusCode:409});
 expect(await service.intakeReceipt(actor,randomUUID(),hash)).toMatchObject({outcome:'unconfirmed',reason:'missing_or_expired',receipt:null});expect(await snapshot()).toEqual(before);
 const result=await service.result(actor,orderId);expect(result.workerWages).toEqual({totalAmount:'0.00',items:[]});expect(result.attachments).toEqual([]);expect(result.source.linkageStatus).toBe('linked');
 await expect(service.result(denied,orderId)).rejects.toMatchObject({statusCode:403});await expect(service.result(actor,randomUUID())).rejects.toMatchObject({statusCode:404});
 // Identity/role guards apply again on replay and on a read; completed keys are not access grants.
 await db.query('UPDATE app_users SET enabled=false WHERE id=$1',[ERP_INTEGRATION_SERVICE_ACTOR_ID]);
 try{await expect(service.intakeReceipt(actor,key,hash)).rejects.toMatchObject({code:'INTEGRATION_DISABLED',statusCode:503});await expect(service.intakeFromErp(actor,input,key)).rejects.toMatchObject({code:'INTEGRATION_DISABLED',statusCode:503});}finally{await db.query('UPDATE app_users SET enabled=true WHERE id=$1',[ERP_INTEGRATION_SERVICE_ACTOR_ID]);}
 const emergencyKey=randomUUID(),emergency=ErpEmergencyReworkIntakeV1Schema.parse({contractVersion:'1',reason:'TEST隔离环境模拟ERP不可用',payload:input.payload});
 const emergencyResult=await service.emergencyIntake(admin,emergency,emergencyKey),emergencyHash=fingerprint('erp.rework.emergency_intake.v1',emergency);
 expect(await service.emergencyReceipt(admin,emergencyKey,emergencyHash)).toMatchObject({outcome:'confirmed',receipt:emergencyResult.value});
 await expect(service.emergencyReceipt(denied,emergencyKey,emergencyHash)).rejects.toMatchObject({statusCode:403});
 expect(await service.intakeReceipt(actor,emergencyKey,emergencyHash)).toMatchObject({outcome:'unconfirmed',receipt:null});
 expect((await service.result(actor,emergencyResult.value.reworkOrderId)).source).toMatchObject({linkedErp:null,linkageStatus:'pending'});
 const employeeAccess=new EmployeeAccessService(db,'corp',new AccessMasterDataService(db,'corp'),{} as never,{} as never,{enabled:false,dingtalkUserId:undefined,secret:undefined},`ding-${root.actorId}`);
 await employeeAccess.disableAccess(root,admin.actorId,'TEST核验应急身份停用后的原回执拒绝');
 try{await expect(service.emergencyReceipt(admin,emergencyKey,emergencyHash)).rejects.toThrow();await expect(service.emergencyIntake(admin,emergency,emergencyKey)).rejects.toThrow();}finally{await employeeAccess.restoreAccess(root,admin.actorId,'TEST恢复原合成应急身份');}
 const linkKey=randomUUID(),link=ErpEmergencyLinkV1Schema.parse({contractVersion:'1',externalId:`TEST-LINK-${linkKey}`,externalIdempotencyKey:linkKey,erpNodeId:'TEST-NODE'});
 const [linked,linkReplay]=await Promise.all([service.linkEmergency(actor,emergencyResult.value.reworkOrderId,link,linkKey),service.linkEmergency(actor,emergencyResult.value.reworkOrderId,link,linkKey)]);expect(linked.value).toEqual(linkReplay.value);
 const linkHash=fingerprint('erp.rework.link.v1',{reworkOrderId:emergencyResult.value.reworkOrderId,input:link});
 expect(await service.linkReceipt(actor,emergencyResult.value.reworkOrderId,linkKey,linkHash)).toMatchObject({outcome:'confirmed',receipt:linked.value});
 await expect(service.linkReceipt(actor,orderId,linkKey,linkHash)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT',statusCode:409});
 await expect(service.linkEmergency(actor,emergencyResult.value.reworkOrderId,{...link,externalId:'TEST-other-source'},randomUUID())).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT',statusCode:409});
 expect((await db.query('SELECT count(*)::int count FROM erp_rework_links WHERE rework_order_id=$1',[emergencyResult.value.reworkOrderId])).rows[0].count).toBe(1);
 // Explicit fixture states exercise bounded recovery; none skip a business action.
 const pendingKey=randomUUID(),pendingInput={...input,source:{...input.source,externalId:`TEST-pending-${pendingKey}`,externalIdempotencyKey:pendingKey}},pendingHash=fingerprint('erp.rework.intake.v1',pendingInput);await new IdempotencyRepository().begin(db,{scope:'erp.rework.intake.v1',actorKey:actor.actorId,key:pendingKey,requestHash:pendingHash,expiresAt:new Date(Date.now()+86400000)});
 expect(await service.intakeReceipt(actor,pendingKey,pendingHash)).toMatchObject({outcome:'unconfirmed',reason:'in_progress'});
 await db.query("UPDATE idempotency_records SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE scope='erp.rework.intake.v1' AND actor_key=$1 AND idempotency_key=$2",[actor.actorId,key]);
 expect(await service.intakeReceipt(actor,key,hash)).toMatchObject({outcome:'unconfirmed',reason:'missing_or_expired'});
 expect((await db.query('SELECT count(*)::int count FROM erp_rework_intakes WHERE rework_order_id=$1',[orderId])).rows[0].count).toBe(1);
 await db.query("UPDATE idempotency_records SET response='{}'::jsonb WHERE scope='erp.rework.emergency_intake.v1' AND actor_key=$1 AND idempotency_key=$2",[admin.actorId,emergencyKey]);
 await expect(service.emergencyReceipt(admin,emergencyKey,emergencyHash)).rejects.toMatchObject({code:'ERP_RECEIPT_INVALID',statusCode:502});
 const invalidKey=randomUUID();await db.query('UPDATE identity_mappings SET employed=false WHERE user_id=$1',[merchandiser]);
 try{await expect(service.intakeFromErp(actor,{...input,source:{...input.source,externalId:`TEST-invalid-${invalidKey}`,externalIdempotencyKey:invalidKey}},invalidKey)).rejects.toMatchObject({statusCode:404});}finally{await db.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[merchandiser]);}
 // Existing v1/schema mismatch is a separately recorded boundary: a direct
 // intake node is contract-valid but current DB requires it null. Do not relax
 // that business guard here; the existing emergency-link node remains tested.
 const beforeRejectedNode=await snapshot(),nodeKey=randomUUID();await expect(service.intakeFromErp(actor,{...input,source:{...input.source,externalId:`TEST-node-${nodeKey}`,externalIdempotencyKey:nodeKey,erpNodeId:'TEST-NONNULL-NODE'}},nodeKey)).rejects.toMatchObject({statusCode:400});expect(await snapshot()).toEqual(beforeRejectedNode);expect((await db.query('SELECT count(*)::int count FROM rework_orders WHERE external_id=$1',[`TEST-node-${nodeKey}`])).rows[0].count).toBe(0);
 const badFactoryKey=randomUUID();await expect(service.intakeFromErp(actor,{...input,source:{...input.source,externalId:`TEST-invalid-factory-${badFactoryKey}`,externalIdempotencyKey:badFactoryKey},payload:{...input.payload,processingFactory:{type:'supplier',supplierId:randomUUID()}}},badFactoryKey)).rejects.toMatchObject({statusCode:404});
 expect((await db.query('SELECT count(*)::int count FROM rework_orders WHERE external_id LIKE \'TEST-invalid-%\'')).rows[0].count).toBe(0);
 }finally{await db.query('UPDATE app_users SET enabled=$2 WHERE id=$1',[ERP_INTEGRATION_SERVICE_ACTOR_ID,originalPrincipal.enabled]);}

}
