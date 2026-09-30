import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {exerciseDevelopmentRounds} from "./digital-development-round-fixture.js";
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {expect} from 'vitest';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {digitalTodoTarget} from '../../apps/api/src/production-platform/notification-policy.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
export async function exerciseDevelopmentRoute(db:Pool,todos:TodoProjectionService,root:TrustedActorContext,workerId:string,workerPersonId:string,qc:TrustedActorContext,replacementWorkerId:string){
 const native=new PatternRoomOrderService(db,todos,{ordersEnabled:true}),execution=new DevelopmentExecutionService(db,true,native),forms=new DigitalDevelopmentService(db,true),identity=new DigitalProductionIdentityService(db,true);
 for(const [craft,washing]of [['无','免洗'],['印花','内洗'],['绣花','外洗'],['印绣花','免洗']] as const){
  const source=await identity.createSource(root,{developmentType:'头版',designStyleNo:`P07-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID());
  const sourceId=source.sourceId,fileId=randomUUID(),mainId=randomUUID(),trimId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'款图.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`p07/${fileId}`,'a'.repeat(64),root.actorId]);
  const material={supplier:'',width:'',weight:'',composition:'',consumption:'',color:'黑',specification:'',quantity:'1',requiredThisRound:true};
  const document=DevelopmentDocumentSchema.parse({template:'上衣',quantity:1,sampleSize:'M',orderDate:'2026-09-30',returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft,washing,materials:[{...material,materialId:mainId,category:'主布',label:'主布',name:'棉',available:true,expectedDate:null},{...material,materialId:trimId,category:'辅料',label:'拉链',name:'拉链',available:false,expectedDate:'2026-09-30'}],files:[{attachmentId:fileId,kind:'款图'}]});
  const saved=await forms.save(root,sourceId,{expectedVersion:0,document},randomUUID()),sheet=await forms.publish(root,sourceId,saved.version,randomUUID());
  await execution.dispatch(root,sourceId,{expectedVersion:0,patternWorkerId:workerId,cuttingWorkerId:workerId,sewingWorkerId:workerId},randomUUID());
  const price=(await db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  const linked=await execution.patternOrder(root,sourceId,{categoryId:price.price_id,priceVersion:price.version},randomUUID()) as {orderId:string};
  expect(await digitalTodoTarget(db,{routeName:'pattern_room_order',entityId:linked.orderId,todoId:randomUUID()})).toEqual({kind:'source',id:sourceId});
  const again=await execution.patternOrder(root,sourceId,{categoryId:price.price_id,priceVersion:price.version},randomUUID()) as {orderId:string};expect(again.orderId).toBe(linked.orderId);
  let order=await native.get(root,linked.orderId);order=await native.assign(root,order.orderId,{roundId:order.currentRoundId,version:order.version,personId:workerPersonId},randomUUID());
  const boardId=randomUUID();
  if(craft!=='无'){
    await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'工艺板.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[boardId,`p07/${boardId}`,'b'.repeat(64),root.actorId]);
    await execution.recordUploadPurpose(root,sourceId,boardId,'工艺开发板');
  }
  const task=async(kind:string)=>(await execution.read(root,sourceId)).tasks.find(item=>item.taskKind===kind)!;
  const work=async(kind:string)=>execution.complete(root,sourceId,{taskId:(await task(kind)).taskId,note:'完成并交出',attachmentIds:kind==='development_pattern'&&craft!=='无'?[boardId]:[]},randomUUID());
  const route=async(kind:string,nextAssigneeId:string|null=null)=>{const current=await task(kind);return execution.route(root,sourceId,{craftExecution:kind==='development_craft_dispatch'?'内部':null,taskId:current.taskId,result:'通过',note:'业务验收',nextAssigneeId,sentDate:kind==='development_shipping'?'2026-09-30':null,trackingNo:kind==='development_shipping'?'P07-TEST-001':null},randomUUID());};
  await execution.check(root,sourceId,{taskId:sheet.taskId!,result:'通过',note:'核配',items:[{materialId:mainId,physical:true,quantity:true,color:true,specification:true}]},randomUUID());
  await work('development_pattern');await work('development_cutting');
  if(craft!=='无'){
   await route('development_craft_dispatch',workerId);
   const kind=craft==='印花'?'development_printing':craft==='绣花'?'development_embroidery':'development_print_embroidery';
   expect((await task(kind)).slaHours).toBe(craft==='印绣花'?168:96);
   await route(kind);await route('development_craft_confirmation');
   expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[order.currentRoundId])).rows[0].n).toBe(0);
  }
  if(craft!=='无')await route('development_sewing_transfer');
  else expect(await task('development_sewing_transfer')).toBeUndefined();
  expect(await task('development_sewing')).toMatchObject({state:'pending',enteredAt:null});
  await expect(route('development_sewing')).rejects.toMatchObject({statusCode:409});
  await forms.materialEvent(root,sourceId,trimId,{expectedVersion:sheet.version,expectedMaterialRevision:0,action:'确认代用',expectedDate:null,note:'设计师确认代用'},randomUUID());
  expect(await task('development_sewing')).toMatchObject({state:'ready',slaHours:24});
  const sewing=await task('development_sewing'),digitalTasks=new DigitalProductionTaskService(db);
  const executorId=craft==='无'?replacementWorkerId:workerId;
  if(craft==='无')await digitalTasks.reassign(root,sewing.taskId,executorId,randomUUID());
  const executor:TrustedActorContext={actorId:executorId,actorRoles:['pattern_room_worker'],authorizationCapability:'pattern_room:orders:complete',authorizationCapabilities:['pattern_room:orders:complete','pattern_room:orders:view','digital_production:view'],requestId:randomUUID()};
  const completion={taskId:sewing.taskId,result:'通过' as const,note:'实际任务执行人完工',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null},completionKey=randomUUID();
  if(craft==='无'){
    await expect(native.complete(executor,order.orderId,{roundId:order.currentRoundId,version:order.version},randomUUID())).rejects.toMatchObject({statusCode:404});
    await expect(execution.route({...executor,actorId:workerId},sourceId,completion,randomUUID())).rejects.toMatchObject({statusCode:404});
    const client=await db.connect();try{
      await client.query('BEGIN');
      await expect(native.inTransaction(client).completeDevelopment(executor,randomUUID(),sewing.taskId,order.orderId,{roundId:order.currentRoundId,version:order.version})).rejects.toMatchObject({statusCode:403});
      await client.query('ROLLBACK');
    }finally{client.release();}
  }
  await execution.route(executor,sourceId,completion,completionKey);
  await execution.route(executor,sourceId,completion,completionKey);
  order=await native.get(root,order.orderId);
  expect(order.status).toBe('pending_confirmation');
  const segments=(await db.query('SELECT worker_user_id,wage_eligible_at FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId])).rows;
  expect(segments).toHaveLength(1);expect(segments[0]).toMatchObject({worker_user_id:workerId,wage_eligible_at:null});
  expect((await db.query("SELECT actor_id,after_state FROM operation_events WHERE entity_id=$1 AND action='pattern_room.order.work_completed'",[order.orderId])).rows).toMatchObject([{actor_id:executorId,after_state:{value:{developmentTaskId:sewing.taskId,executorUserId:executorId,wageWorkerUserId:workerId}}}]);
  await expect(native.handoff(root,order.orderId,{roundId:order.currentRoundId,version:order.version},randomUUID())).rejects.toMatchObject({statusCode:409});
  if(washing!=='免洗'){expect(await task('development_tail_check')).toBeUndefined();expect(await task('development_washing')).toBeUndefined();await execution.sendWashing(root,sourceId,(await task('development_washing_dispatch')).taskId,'文员实际送洗',randomUUID());expect((await task('development_washing')).slaHours).toBe(24);await route('development_washing');}
  const tail=await task('development_tail_check');expect(tail).toMatchObject({state:'ready',slaHours:4});
  await expect(execution.route(qc,sourceId,{craftExecution:null,taskId:tail.taskId,result:'通过',note:'QC不能办理板房尾查',nextAssigneeId:null,sentDate:null,trackingNo:null},randomUUID())).rejects.toMatchObject({statusCode:404});
  await route('development_tail_check');
  const final=await task('development_confirmation'),key=randomUUID(),input={craftExecution:null,taskId:final.taskId,result:'通过' as const,note:'最终确认',nextAssigneeId:null,sentDate:null,trackingNo:null};
  await execution.route(root,sourceId,input,key);await execution.route(root,sourceId,input,key);
  expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[order.currentRoundId])).rows[0].n).toBe(1);
  await route('development_shipping');
  expect((await execution.read(root,sourceId)).routeFacts.some(f=>f.kind==='客户样板确认')).toBe(false);
  await execution.customerSample(root,sourceId,{routeVersion:1,note:'客户明确确认本轮样板'},randomUUID());
  expect((await execution.read(root,sourceId)).routeFacts.filter(f=>f.kind==='客户样板确认')).toHaveLength(1);
  if(craft==='无')await exerciseDevelopmentRounds(db,execution,root,sourceId,workerId,order.currentRoundId,qc);
  if(craft==='印绣花'){
    const confirmed=await native.get(root,order.orderId);
    let rework=await native.requestRework(root,order.orderId,{roundId:confirmed.currentRoundId,version:confirmed.version,reason:'复核旧开发确认不可释放新工资轮',reasonCategory:'other'},randomUUID());
    rework=await native.assign(root,rework.orderId,{roundId:rework.currentRoundId,version:rework.version,personId:workerPersonId,amount:'10.00'},randomUUID());
    rework=await native.complete(root,rework.orderId,{roundId:rework.currentRoundId,version:rework.version},randomUUID());
    await expect(native.handoff(root,rework.orderId,{roundId:rework.currentRoundId,version:rework.version},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[rework.currentRoundId])).rows[0].n).toBe(0);
    expect((await native.get(root,rework.orderId)).status).toBe('pending_confirmation');
  }

 }
}
