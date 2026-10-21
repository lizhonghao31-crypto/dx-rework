// Historical data initialization in an owned TEST schema only. No retired service or adapter.
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {Pool} from 'pg';
import {OperationEventRepository,type TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {ReworkBusinessDetailService} from '../../apps/api/src/rework/rework-business-detail-service.js';
export async function exerciseLegacyErpHistory(db:Pool,merchandiser:string,reader:TrustedActorContext,denied:TrustedActorContext){
 const orderId=randomUUID(),key=randomUUID(),externalId=`TEST-HISTORICAL-${key}`,legacyActor={actorId:'00000000-0000-4000-8000-000000000016',actorRoles:['integration_service'],authorizationCapability:'erp:integrate',requestId:randomUUID()};
 const source={sourceSystem:'erp',externalId,externalIdempotencyKey:key,erpNodeId:null};
 const c=await db.connect();
 try{await c.query('BEGIN');const eventId=await new OperationEventRepository().append(c,legacyActor,{action:'rework.submit',entityType:'rework_order',entityId:orderId,after:{reworkOrderId:orderId,reworkNo:`RW-TEST-${key}`,status:'pending_process_configuration',styleNo:'TEST旧来源历史单',orderNo:null,merchandiserUserId:merchandiser,processingFactory:{type:'own_factory'},problemPart:'TEST部位',problemDescription:'TEST历史事实',reworkQuantity:12,version:1,sourceSystem:'erp'}});
  await c.query("SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true),set_config('dx_rework.erp_intake_event_id',$1,true),set_config('dx_rework.erp_intake_request_id',$2,true)",[eventId,legacyActor.requestId]);
  await c.query("INSERT INTO rework_orders(rework_order_id,rework_no,status,source_system,external_id,external_idempotency_key,style_no,merchandiser_user_id,processing_factory_type,problem_part,problem_description,rework_quantity,created_by,updated_by,submitted_at) VALUES($1,$2,'pending_process_configuration','erp',$3,$4,'TEST旧来源历史单',$5,'own_factory','TEST部位','TEST历史事实',12,$6,$6,CURRENT_TIMESTAMP)",[orderId,`RW-TEST-${key}`,externalId,key,merchandiser,legacyActor.actorId]);
  await c.query("INSERT INTO erp_rework_intakes(rework_order_id,contract_version,intake_mode,source_snapshot,received_by,operation_event_id,request_id) VALUES($1,'1','erp',$2,$3,$4,$5)",[orderId,{contractVersion:'1',source},legacyActor.actorId,eventId,legacyActor.requestId]);await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 const snapshot=async()=>({order:(await db.query('SELECT * FROM rework_orders WHERE rework_order_id=$1',[orderId])).rows,intake:(await db.query('SELECT * FROM erp_rework_intakes WHERE rework_order_id=$1',[orderId])).rows,audit:(await db.query("SELECT * FROM operation_events WHERE entity_type='rework_order' AND entity_id=$1 ORDER BY event_id",[orderId])).rows});
 const before=await snapshot(),service=new ReworkBusinessDetailService(db),detail=await service.get(reader,orderId);expect(detail).toMatchObject({reworkOrderId:orderId,styleNo:'TEST旧来源历史单',canReadBusinessDetails:true});await expect(service.get(denied,orderId)).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);expect(before.order[0]).toMatchObject({source_system:'erp',external_id:externalId,external_idempotency_key:key});expect(before.intake).toHaveLength(1);expect(before.audit).toHaveLength(1);
}
