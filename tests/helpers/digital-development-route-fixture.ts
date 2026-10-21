import {PatternHistoryQuerySchema} from '@dx-rework/contracts/pattern-orders';
import {exerciseDevelopmentTransfer} from './development-transfer-guards.js';
import {fabricDecisionTodos} from "../../apps/api/src/production-platform/development-fabric-cases.js";
import {exerciseMaterialVerification} from "./material-verification-guards.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {DigitalProductionNotificationService} from "../../apps/api/src/production-platform/notification-service.js";
import {exerciseArrangementGuards} from "./development-arrangement-guards.js";
import {arrangeTestRound,arrangementInput} from "./development-arrangement-fixture.js";
import {arrangementTodos} from "../../apps/api/src/production-platform/development-arrangement-todos.js";
import {taskResult} from "./development-task-result-fixture.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {exerciseDevelopmentRounds} from "./digital-development-round-fixture.js";
import {exerciseGarmentCraftRevision} from "./digital-development-craft-revision-fixture.js";
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
export async function exerciseDevelopmentRoute(db:Pool,todos:TodoProjectionService,root:TrustedActorContext,workerId:string,workerPersonId:string,qc:TrustedActorContext,replacementWorkerId:string,legacyMaking?:"tail"|"native",transferOnly:false|true|"authority"=false){
 const native=new PatternRoomOrderService(db,todos,{ordersEnabled:true}),execution=new DevelopmentExecutionService(db,true,native),forms=new DigitalDevelopmentService(db,true,native),identity=new DigitalProductionIdentityService(db,true);
 const checkHistory=!legacyMaking&&!transferOnly;
 const routes=legacyMaking||transferOnly?([['无','免洗']] as const):([['无','免洗'],['印花','内洗'],['绣花','外洗'],['印绣花','免洗']] as const);
 for(const [craft,washing]of routes){
  const sourceStyle=`P07-${randomUUID()}`;
  const source=await identity.createSource(root,{developmentType:'头版',designStyleNo:sourceStyle,temporaryStyleNo:null,customerCode:null},randomUUID());
  const sourceId=source.sourceId,fileId=randomUUID(),mainId=randomUUID(),trimId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'款图.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`p07/${fileId}`,'a'.repeat(64),root.actorId]);
  const material={supplier:'',width:'',weight:'',composition:'',consumption:'',color:'黑',specification:'',quantity:'1',requiredThisRound:true};
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft,washing,materials:[{...material,materialId:mainId,category:'主布',label:'主布',name:'棉',specification:'TEST 40支',requiredThisRound:craft!=='无',available:true,expectedDate:null},{...material,materialId:trimId,category:'辅料',auxiliaryKind:'拉链',label:'拉链',name:'拉链',available:false,expectedDate:'2026-09-30'}],files:[{attachmentId:fileId,kind:'款图'}]});
  const price=(await db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  const patternChoice={categoryId:price.price_id,priceVersion:price.version};
  let sheet;
  if(legacyMaking){
   // Historical fixture bootstrap only: an already published pre-P03 snapshot, not a new-publication bypass.
   delete document.documentFormatVersion;delete document.sizeQuantities;
   const client=await db.connect();try{await client.query('BEGIN');
    const clerkId=(await client.query("SELECT user_id FROM user_role_assignments WHERE role_code='development_clerk' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
    const initial=(await new DigitalProductionTaskService(db).createWithClient(client,root,{resource:{kind:'source',id:sourceId},kind:'development_materials',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerkId}));
    await forms.bindFiles(client,root,sourceId,document);
    await client.query("INSERT INTO digital_development_documents(source_id,version,status,document,published_at,task_id,updated_by) VALUES($1,2,'published',$2,CURRENT_TIMESTAMP,$3,$4)",[sourceId,JSON.stringify(document),initial.taskId,root.actorId]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   sheet=await forms.read(root,sourceId);expect(sheet.document).toEqual(document);
  }else{
   const saved=await forms.save(root,sourceId,{expectedVersion:0,document},randomUUID());
   if(craft==='无'){
    await expect(forms.publish(root,sourceId,saved.version,randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(forms.publish(root,sourceId,saved.version,randomUUID(),{...patternChoice,priceVersion:price.version+1})).rejects.toMatchObject({statusCode:409});
    expect(await forms.read(root,sourceId)).toMatchObject({status:'draft',version:saved.version});
    expect((await db.query('SELECT count(*)::int n FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1',[sourceId])).rows[0].n).toBe(0);
   }
   const publishKey=randomUUID();sheet=await forms.publish(root,sourceId,saved.version,publishKey,patternChoice);
   expect(await forms.publish(root,sourceId,saved.version,publishKey,patternChoice)).toEqual(sheet);
   expect((await db.query('SELECT count(*)::int n FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0].n).toBe(1);
  }
  await expect(execution.dispatch(root,sourceId,{expectedVersion:0,patternWorkerId:workerId,cuttingWorkerId:workerId,sewingWorkerId:workerId},randomUUID())).rejects.toThrow("总委派");
  const linked=await execution.patternOrder(root,sourceId,{categoryId:price.price_id,priceVersion:price.version},randomUUID()) as {orderId:string};
  expect(await digitalTodoTarget(db,{routeName:'pattern_room_order',entityId:linked.orderId,todoId:randomUUID()})).toEqual({kind:'source',id:sourceId});
  const again=await execution.patternOrder(root,sourceId,{categoryId:price.price_id,priceVersion:price.version},randomUUID()) as {orderId:string};expect(again.orderId).toBe(linked.orderId);
  let order=await native.get(root,linked.orderId);
  expect(order.developmentSourceId).toBe(sourceId);expect(order.sizeColor).toBe(legacyMaking?"M":"M 1件");
  expect((await execution.read(root,sourceId)).patternPreparation).toMatchObject({status:'pending_assignment',categorySaved:true,priceSaved:true,workerId:null});
  const clerkId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='development_clerk' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
  const clerk:TrustedActorContext={actorId:clerkId,actorRoles:['development_clerk'],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view','todo:view'],requestId:randomUUID()};
  await expect(execution.arrange(clerk,sourceId,await arrangementInput(db,execution,clerk,sourceId,workerId),randomUUID())).rejects.toThrow('核料尚未通过');
  const task=async(kind:string)=>(await execution.read(root,sourceId)).tasks.filter(item=>item.taskKind===kind).at(-1)!;
  const work=async(kind:string)=>{const current=await task(kind);return execution.complete(root,sourceId,{taskId:current.taskId,note:'完成并交出',attachmentIds:kind==='development_pattern'?[await taskResult(db,execution,root,sourceId,current.taskId,'纸样成果')]:[]},randomUUID());};
  const route=async(kind:string,nextAssigneeId:string|null=null)=>{const current=await task(kind);return execution.route(root,sourceId,{...(kind==='development_sewing'&&current.state==='ready'?{attachmentIds:[await taskResult(db,execution,root,sourceId,current.taskId,'车板成果')]}:{}),craftExecution:kind==='development_craft_dispatch'?'内部':null,taskId:current.taskId,result:'通过',note:'业务验收',nextAssigneeId,sentDate:kind==='development_shipping'?'2026-09-30':null,trackingNo:kind==='development_shipping'?'P07-TEST-001':null},randomUUID());};
  const checkItems=[{materialId:mainId,physical:true,quantity:true,color:true,specification:true},{materialId:trimId,physical:false,quantity:false,color:false,specification:false}];
  const verified=await exerciseMaterialVerification(db,execution,clerk,root,sourceId,sheet.taskId!,checkItems,craft==='无');
  await execution.check(clerk,sourceId,{...verified,result:'通过',note:'拉链未到，由设计师按预计日期跟进',items:checkItems},randomUUID());
  expect((await execution.read(clerk,sourceId)).materialReadiness.find(row=>row.materialId===mainId)).toMatchObject({required:true,verified:true});
  expect((await forms.read(root,sourceId)).document!.materials.find(row=>row.materialId===mainId)!.requiredThisRound).toBe(craft!=='无');
  expect((await arrangementTodos(db,clerk)).filter(todo=>todo.entityId===sourceId)).toHaveLength(1);
  const todoService=new TodoService(db,undefined,undefined,undefined,new DigitalProductionNotificationService(db));
  const visible=await todoService.listForActor({...clerk,authorizationCapability:'todo:view'},{query:sourceStyle,module:'digital_production'});
  expect(visible.todos.filter(todo=>todo.entityId===sourceId)).toHaveLength(1);
  expect(visible.todos.find(todo=>todo.entityId===sourceId)?.route).toMatchObject({routeName:'digital_development_arrangement',developmentRound:1});
  const supervisorId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='pattern_room_supervisor' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
  const supervisor={...root,actorId:supervisorId,actorRoles:['pattern_room_supervisor'],authorizationCapability:'todo:view',authorizationCapabilities:['todo:view']};
  expect((await todoService.listForActor(supervisor,{query:sourceStyle})).todos.filter(todo=>todo.entityId===linked.orderId)).toHaveLength(0);

  const arrangement=await arrangementInput(db,execution,clerk,sourceId,workerId),arrangeKey=randomUUID();
  await execution.arrange(clerk,sourceId,arrangement,arrangeKey);
  await execution.arrange(clerk,sourceId,arrangement,arrangeKey);
  expect((await arrangementTodos(db,clerk)).filter(todo=>todo.entityId===sourceId)).toHaveLength(0);
  expect((await native.get(root,order.orderId)).status).toBe('pending_assignment');
  const initialAssignmentKey=`pattern-room:${order.orderId}:${order.currentRoundId}:assignment`;
  expect((await db.query("SELECT status FROM rework_todos WHERE dedupe_key=$1",[initialAssignmentKey])).rows).toEqual([{status:'pending'}]);
  expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId])).rows[0].n).toBe(0);
  if(craft==='无')await exerciseArrangementGuards(db,execution,clerk,root,sourceId,workerId,qc);
  await work('development_pattern');await work('development_cutting');
  if(craft!=='无'){
   await route('development_craft_dispatch',workerId);
   const kind=craft==='印花'?'development_printing':craft==='绣花'?'development_embroidery':'development_print_embroidery';
   expect((await task(kind)).slaHours).toBe(craft==='印绣花'?168:96);
   await route(kind);await route('development_craft_confirmation');
   expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[order.currentRoundId])).rows[0].n).toBe(0);
  }
  expect(await task('development_sewing_transfer')).toBeUndefined();
  if(craft!=='无'){
    const sewing=await task('development_sewing');
    expect((await db.query("SELECT satisfied,occurred_at FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='handover_received'",[sewing.taskId])).rows[0]).toEqual({satisfied:false,occurred_at:null});
    expect((await db.query("SELECT count(*)::int n FROM digital_production_task_events WHERE task_id=$1 AND event_kind='system_route' AND payload->>'mode'='system_route'",[sewing.taskId])).rows[0].n).toBe(1);
    await new DigitalProductionTaskService(db).handover(root,sewing.taskId,{note:'TEST实际收到裁片'},randomUUID());
    expect((await db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='development_system_route'",[sourceId])).rows[0].n).toBe(1);
  }
  if(craft==='无'){
    const unmapped=(await db.query("SELECT id FROM app_users WHERE display_name='TEST未映射师傅'")).rows[0].id;
    const draft=await arrangementInput(db,execution,clerk,sourceId,workerId),row=draft.entries.find(row=>row.kind==='development_sewing')!;row.assigneeId=unmapped;row.reason='TEST安排有效岗位但缺唯一执行身份';
    await execution.arrange(clerk,sourceId,draft,randomUUID());
  }
  expect(await task('development_sewing')).toMatchObject({state:'pending',enteredAt:null});
  await expect(route('development_sewing')).rejects.toMatchObject({statusCode:409});
  await forms.materialEvent(root,sourceId,trimId,{expectedVersion:sheet.version,expectedMaterialRevision:0,action:'确认代用',expectedDate:null,note:'设计师确认代用'},randomUUID());
  if(craft==='无'){
    expect(await task('development_sewing')).toMatchObject({state:'pending'});
    expect((await task('development_sewing')).unmetConditions?.some(row=>row.condition==='execution_person')).toBe(true);
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId])).rows[0].n).toBe(0);
    const activationInput=await arrangementInput(db,execution,clerk,sourceId,workerId),activationKey=randomUUID();
    await db.query(`CREATE FUNCTION test_reject_assignment_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='completed' AND OLD.status='pending' THEN RAISE EXCEPTION 'TEST assignment closure failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_reject_assignment_completion BEFORE UPDATE ON rework_todos FOR EACH ROW EXECUTE FUNCTION test_reject_assignment_completion()`);
    try {
      await expect(execution.arrange(clerk,sourceId,activationInput,activationKey)).rejects.toThrow();
    } finally {
      await db.query("DROP TRIGGER test_reject_assignment_completion ON rework_todos; DROP FUNCTION test_reject_assignment_completion()");
    }
    expect((await execution.read(clerk,sourceId)).arrangement!.version).toBe(activationInput.expectedVersion);
    expect((await native.get(root,order.orderId)).status).toBe('pending_assignment');
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId])).rows[0].n).toBe(0);
    expect((await db.query("SELECT status FROM rework_todos WHERE dedupe_key=$1",[initialAssignmentKey])).rows).toEqual([{status:'pending'}]);
    await execution.arrange(clerk,sourceId,activationInput,activationKey);
    await execution.arrange(clerk,sourceId,activationInput,activationKey);
    expect((await db.query("SELECT count(*)::int n FROM operation_events WHERE action='todo.complete' AND entity_id=(SELECT todo_id::text FROM rework_todos WHERE dedupe_key=$1)",[initialAssignmentKey])).rows[0].n).toBe(1);
  }
  expect(await task('development_sewing')).toMatchObject({state:'ready',slaHours:24});
  expect((await db.query("SELECT status,completed_at IS NOT NULL AS completed,completed_operation_event_id IS NOT NULL AS audited FROM rework_todos WHERE dedupe_key=$1",[initialAssignmentKey])).rows).toEqual([{status:'completed',completed:true,audited:true}]);
  const sewing=await task('development_sewing'),digitalTasks=new DigitalProductionTaskService(db);
  const executorId=workerId;
  if(craft==='无'){
    await expect(digitalTasks.reassign(root,sewing.taskId,replacementWorkerId,randomUUID())).rejects.toThrow('总委派');
    const change=await arrangementInput(db,execution,clerk,sourceId,workerId);change.entries.find(row=>row.kind==='development_sewing')!.assigneeId=replacementWorkerId;change.entries.find(row=>row.kind==='development_sewing')!.reason='TEST不可覆盖工资执行段';
    await expect(execution.arrange(clerk,sourceId,change,randomUUID())).rejects.toThrow('换人分段');
  }
  if(transferOnly){await exerciseDevelopmentTransfer(db,execution,native,root,clerk,sourceId,order.orderId,workerId,replacementWorkerId,transferOnly==="authority");return;}
  const executor:TrustedActorContext={actorId:executorId,actorRoles:['pattern_room_worker'],authorizationCapability:'pattern_room:orders:complete',authorizationCapabilities:['pattern_room:orders:complete','pattern_room:orders:view','digital_production:view'],requestId:randomUUID()};
  const resultId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-sewing.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[resultId,`r2-pr04/${resultId}`,'c'.repeat(64),executorId]);
  await expect(execution.recordUploadPurpose(qc,sourceId,resultId,'车板成果',sewing.taskId)).rejects.toMatchObject({statusCode:404});
  await expect(execution.authorizeSewingUpload(executor,randomUUID(),sewing.taskId)).rejects.toMatchObject({statusCode:409});
  await execution.recordUploadPurpose(executor,sourceId,resultId,'车板成果',sewing.taskId);
  expect((await db.query('SELECT purpose,task_id FROM digital_development_upload_purposes WHERE attachment_id=$1',[resultId])).rows[0]).toEqual({purpose:'车板成果',task_id:sewing.taskId});
  const pdf=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-not-photo.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[pdf,`test-r2-pdf/${pdf}`,'f'.repeat(64),executorId]);
  await execution.recordUploadPurpose(executor,sourceId,pdf,'车板成果',sewing.taskId);
  await expect(execution.route(executor,sourceId,{attachmentIds:[pdf],taskId:sewing.taskId,result:'通过',note:'PDF不代替完成照片',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null},randomUUID())).rejects.toThrow('实际完成照片');
  const completion={attachmentIds:[resultId],taskId:sewing.taskId,result:'通过' as const,note:'实际任务执行人完工',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null},completionKey=randomUUID();
  await expect(execution.route({...executor,actorId:replacementWorkerId},sourceId,completion,randomUUID())).rejects.toMatchObject({statusCode:404});
  await execution.route(executor,sourceId,completion,completionKey);
  await execution.route(executor,sourceId,completion,completionKey);
  expect(await forms.canDownload(executor,sourceId,resultId)).toBe(true);
  expect((await db.query("SELECT route_version,payload->'attachmentIds' AS files FROM digital_development_route_facts WHERE task_id=$1 AND kind='车板完成'",[sewing.taskId])).rows).toEqual([{route_version:1,files:[resultId]}]);
  await expect(execution.authorizeSewingUpload(executor,sourceId,sewing.taskId)).rejects.toMatchObject({statusCode:409});
  order=await native.get(root,order.orderId);
  expect(order.status).toBe('pending_confirmation');
  expect((await db.query("SELECT count(*)::int n FROM rework_todos WHERE dedupe_key=$1",[`pattern-room:${order.orderId}:${order.currentRoundId}:handoff`])).rows[0].n).toBe(0);
  const segments=(await db.query('SELECT worker_user_id,wage_eligible_at FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId])).rows;
  expect(segments).toHaveLength(1);expect(segments[0]).toMatchObject({worker_user_id:workerId,wage_eligible_at:null});
  expect((await db.query("SELECT actor_id,after_state FROM operation_events WHERE entity_id=$1 AND action='pattern_room.order.work_completed'",[order.orderId])).rows).toMatchObject([{actor_id:executorId,after_state:{value:{developmentTaskId:sewing.taskId,executorUserId:executorId,wageWorkerUserId:workerId}}}]);
  await expect(native.handoff(root,order.orderId,{roundId:order.currentRoundId,version:order.version},randomUUID())).rejects.toMatchObject({statusCode:409});
  if(washing!=='免洗'){expect(await task('development_tail_check')).toBeUndefined();expect(await task('development_washing')).toBeUndefined();await execution.sendWashing(root,sourceId,(await task('development_washing_dispatch')).taskId,'文员实际送洗',randomUUID());expect((await task('development_washing')).slaHours).toBe(24);await route('development_washing');}
  const tail=await task('development_tail_check');expect(tail).toMatchObject({state:'ready',slaHours:4});
  await expect(execution.route(qc,sourceId,{craftExecution:null,taskId:tail.taskId,result:'通过',note:'QC不能办理板房尾查',nextAssigneeId:null,sentDate:null,trackingNo:null},randomUUID())).rejects.toMatchObject({statusCode:404});
  if(legacyMaking){
   if(legacyMaking==='native')await route('development_tail_check');
   const basis=await forms.read(root,sourceId),making={expectedDocumentVersion:basis.version,quantities:[1]};
   const nativeBefore=await native.get(root,order.orderId),nativeRoundCount=nativeBefore.rounds.length;
   if(legacyMaking==='native'){expect(nativeBefore.developmentMakingBasis).toMatchObject({needsUpgrade:true,documentVersion:basis.version,sizes:['M']});expect((await native.get(root,order.orderId,{round:order.currentRoundId,node:'pending_confirmation'})).developmentMakingBasis).toMatchObject({needsUpgrade:true});expect((await native.get(root,order.orderId,{round:order.currentRoundId,node:'pending_assignment'})).developmentMakingBasis).toBeUndefined();}
   const tailInput={craftExecution:null,taskId:tail.taskId,result:'退回' as const,note:'TEST历史单尾查需车板修改',nextAssigneeId:null,sentDate:null,trackingNo:null,returnNodes:['车板' as const],problemCategories:['尺寸' as const]};
   const nativeInput={roundId:nativeBefore.currentRoundId,version:nativeBefore.version,reason:'TEST历史单原执行返工',reasonCategory:'workmanship',developmentNodes:['车板'],developmentProblems:['尺寸'],retainedAttachmentIds:nativeBefore.attachments.filter(file=>file.active&&file.roundId===nativeBefore.currentRoundId).map(file=>file.attachmentId),attachmentIds:[]};
   const submit=(counts?:typeof making,actor=root,key=randomUUID())=>legacyMaking==='tail'?execution.route(actor,sourceId,{...tailInput,...(counts?{making:counts}:{})},key):native.requestRework(actor,order.orderId,{...nativeInput,...(counts?{developmentMaking:counts}:{})},key);
   for(const counts of [undefined,{...making,quantities:[0]},{...making,quantities:[0.5]},{...making,expectedDocumentVersion:basis.version+1}]){
    await expect(submit(counts)).rejects.toMatchObject({statusCode:counts?.expectedDocumentVersion===basis.version+1?409:400});
    expect((await db.query('SELECT count(*)::int n FROM digital_development_rounds WHERE source_id=$1',[sourceId])).rows[0].n).toBe(0);
    expect((await native.get(root,order.orderId)).rounds).toHaveLength(nativeRoundCount);
   }
   await expect(submit(making,clerk)).rejects.toThrow();
   const key=randomUUID();await submit(making,root,key);await submit(making,root,key);
   expect((await forms.read(root,sourceId)).document).toMatchObject({documentFormatVersion:2,sizeQuantities:[1],quantity:1,orderDate:null});
   expect((await forms.read(root,sourceId,undefined,1)).document).toEqual(document);
   expect((await db.query('SELECT count(*)::int n FROM digital_development_rounds WHERE source_id=$1',[sourceId])).rows[0].n).toBe(1);
   expect((await native.get(root,order.orderId)).rounds).toHaveLength(nativeRoundCount+(legacyMaking==='native'?1:0));
   if(legacyMaking==='native'){
    const supervisorId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='pattern_room_supervisor' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
    const supervisor={...root,actorId:supervisorId,actorRoles:['pattern_room_supervisor'],authorizationCapability:'pattern_room:orders:assign',authorizationCapabilities:['pattern_room:orders:view','pattern_room:orders:assign','digital_production:view']};
    await execution.arrange(clerk,sourceId,await arrangementInput(db,execution,clerk,sourceId,workerId),randomUUID());
    const pending=await native.get(root,order.orderId),basis={roundId:pending.currentRoundId,version:pending.version,personId:workerPersonId};
    await expect(native.assign(supervisor,order.orderId,basis,randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(native.assign(clerk,order.orderId,{...basis,amount:'0'},randomUUID())).rejects.toMatchObject({statusCode:403});
    const other=(await db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[replacementWorkerId])).rows[0].person_id;
    await expect(native.assign(supervisor,order.orderId,{...basis,personId:other,amount:'0'},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await native.get(root,order.orderId)).version).toBe(pending.version);
    const assignKey=randomUUID();await native.assign(supervisor,order.orderId,{...basis,amount:'0'},assignKey);await native.assign(supervisor,order.orderId,{...basis,amount:'0'},assignKey);
    const assigned=await native.get(root,order.orderId),segment=assigned.rounds.find(r=>r.roundId===assigned.currentRoundId)!.segments[0]!;
    expect(segment.amount).toMatch(/^0(?:\.0+)?$/);expect(segment.workerUserId).toBe(workerId);expect(assigned.version).toBe(pending.version+1);
    expect((await execution.read(clerk,sourceId)).arrangement!.rows.find(row=>row.kind==='development_sewing')!.assigneeId).toBe(workerId);
    expect((await db.query("SELECT count(*)::int n FROM rework_todos WHERE dedupe_key=$1 AND status='pending'",[`pattern-room:${order.orderId}:${assigned.currentRoundId}:execution:${segment.segmentId}`])).rows[0].n).toBe(0);
   }
   return;
  }
  await route('development_tail_check');
  const final=await task('development_confirmation'),key=randomUUID(),input={craftExecution:null,taskId:final.taskId,result:'通过' as const,note:'最终确认',nextAssigneeId:null,sentDate:null,trackingNo:null};
  if(checkHistory)expect((await native.history(root,PatternHistoryQuerySchema.parse({q:sourceStyle,source:'development_completed'}))).totalCount).toBe(0);
  await execution.route(root,sourceId,input,key);await execution.route(root,sourceId,input,key);
  const history=()=>native.history(root,PatternHistoryQuerySchema.parse({q:sourceStyle,source:'development_completed'}));
  if(checkHistory){const first=await history();expect(first.totalCount).toBe(1);expect(first.items[0]).toMatchObject({nativeRoundId:order.currentRoundId,status:'completed',sourceId,developmentRounds:[1],requiredDate:null});expect(first.items[0]!.completedAt).not.toBeNull();}
  if(checkHistory&&craft==='印花'){
    const financeId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='finance_read' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id,finance={...root,actorId:financeId,actorRoles:['finance_read'],authorizationCapability:'pattern_room:orders:view',authorizationCapabilities:['pattern_room:orders:view']};
    const financial=await native.history(finance,PatternHistoryQuerySchema.parse({q:sourceStyle,source:'development_completed'}));expect(financial.totalCount).toBe(1);expect(financial.items[0]).toMatchObject({sourceId:null,developmentRounds:[],associationWarning:null});expect(JSON.stringify(financial)).not.toContain(sourceId);
    await expect(native.history(qc,PatternHistoryQuerySchema.parse({q:sourceStyle}))).rejects.toMatchObject({statusCode:403});
  }

  expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[order.currentRoundId])).rows[0].n).toBe(1);
  await route('development_shipping');
  expect((await execution.read(root,sourceId)).routeFacts.some(f=>f.kind==='客户样板确认')).toBe(false);
  await execution.customerSample(root,sourceId,{routeVersion:1,note:'客户明确确认本轮样板'},randomUUID());
  expect((await execution.read(root,sourceId)).routeFacts.filter(f=>f.kind==='客户样板确认')).toHaveLength(1);
  if(craft==='绣花'){
   expect((await execution.read(root,sourceId)).tasks.every(t=>['completed','cancelled'].includes(t.state))).toBe(true);
   const reportFile=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-after-completion.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[reportFile,`test-completed/${reportFile}`,'d'.repeat(64),root.actorId]);
   await execution.recordUploadPurpose(root,sourceId,reportFile,'面料报告');
   const report=await execution.report(root,sourceId,{recommendation:'建议停用',note:'TEST完工后发现质量风险',attachmentIds:[reportFile],materialIds:[mainId]},randomUUID()) as {reportId:string};
   const directorId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='production_management' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
   const director={...root,actorId:directorId,actorRoles:['production_management']};
   for(const actor of [root,director])expect((await fabricDecisionTodos(db,actor)).filter(t=>t.todoId===report.reportId)).toMatchObject([{entityType:'digital_development',entityId:sourceId,route:{routeName:'digital_development',entityId:sourceId,todoId:report.reportId}}]);
   expect((await execution.read(director,sourceId)).fabricCases).toMatchObject([{reportId:report.reportId,decisionId:null}]);
   await execution.decideFabric(director,sourceId,{reportId:report.reportId,expectedDecisionId:null,decision:'停止使用',note:'TEST完工后仍须明确决定'},randomUUID());
   expect((await fabricDecisionTodos(db,director)).filter(t=>t.todoId===report.reportId)).toHaveLength(0);
  }
  if(craft==='无')await exerciseDevelopmentRounds(db,execution,root,sourceId,workerId,order.currentRoundId,qc,async()=>{const result=await history();expect(result.totalCount).toBe(1);expect(result.items[0]).toMatchObject({nativeRoundId:order.currentRoundId,developmentRounds:[1]});});
  if(craft==='印花')await exerciseGarmentCraftRevision(db,execution,root,sourceId,workerId,order.currentRoundId,qc);
  if(checkHistory&&craft==='印花'){const result=await history();expect(result.totalCount).toBe(1);expect(result.items[0]).toMatchObject({nativeRoundId:order.currentRoundId,developmentRounds:[1,2]});}
  if(craft==='印绣花'){
    const confirmed=await native.get(root,order.orderId);
    const before={roundId:confirmed.currentRoundId,version:confirmed.version,reason:'车板局部返工',reasonCategory:'other' as const};
    await expect(native.requestRework(root,order.orderId,before,randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(native.requestRework(root,order.orderId,{...before,developmentNodes:['洗水'],developmentProblems:['洗水']},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await native.get(root,order.orderId)).currentRoundId).toBe(confirmed.currentRoundId);
    expect((await forms.read(root,sourceId)).roundNumber).toBe(1);
    const reworkKey=randomUUID(),reworkInput={...before,developmentNodes:['车板'],developmentProblems:['车缝']};
    let rework=await native.requestRework(root,order.orderId,reworkInput,reworkKey);
    expect((await native.requestRework(root,order.orderId,reworkInput,reworkKey)).currentRoundId).toBe(rework.currentRoundId);
    expect((await forms.read(root,sourceId)).roundNumber).toBe(2);
    if(checkHistory&&craft==='印绣花'){const prior=await history();expect(prior.totalCount).toBe(1);expect(prior.items[0]).toMatchObject({nativeRoundId:confirmed.currentRoundId,status:'completed',currentStatus:'pending_assignment',developmentRounds:[1]});}
    const nativeAssignments=(await todoService.listForActor(supervisor,{query:sourceStyle})).todos.filter(todo=>todo.entityId===order.orderId&&todo.category==='pattern_room_assignment');
    expect(nativeAssignments).toHaveLength(1);
    expect(nativeAssignments[0]!.route).toMatchObject({roundId:rework.currentRoundId});
    expect((await db.query('SELECT route_nodes,inherited FROM digital_development_rounds WHERE source_id=$1',[sourceId])).rows).toMatchObject([{route_nodes:['development_sewing_transfer','development_sewing','development_tail_check','development_confirmation','development_shipping'],inherited:{development_pattern:{roundNumber:1}}}]);
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_rounds WHERE order_id=$1',[order.orderId])).rows[0].n).toBe(2);
    await arrangeTestRound(db,execution,root,sourceId,workerId);
    await route('development_sewing_transfer');
    expect(await task('development_sewing')).toMatchObject({state:'pending',enteredAt:null});
    await expect(route('development_sewing')).rejects.toMatchObject({statusCode:409});
    rework=await native.assign(root,rework.orderId,{roundId:rework.currentRoundId,version:rework.version,personId:workerPersonId,amount:'10.00'},randomUUID());
    await route('development_sewing');
    rework=await native.get(root,rework.orderId);
    await expect(native.handoff(root,rework.orderId,{roundId:rework.currentRoundId,version:rework.version},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[rework.currentRoundId])).rows[0].n).toBe(0);
    expect((await native.get(root,rework.orderId)).status).toBe('pending_confirmation');
    await route('development_tail_check');
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[rework.currentRoundId])).rows[0].n).toBe(0);
    await route('development_confirmation');
    expect((await db.query('SELECT amount::numeric(12,2)::text,wage_eligible_at IS NOT NULL AS eligible FROM pattern_room_segments WHERE round_id=$1',[rework.currentRoundId])).rows).toEqual([{amount:'10.00',eligible:true}]);
    if(checkHistory&&craft==='印绣花'){const result=await history();expect(result.totalCount).toBe(2);expect(new Set(result.items.map(row=>row.recordKey)).size).toBe(2);expect(result.items.map(row=>row.developmentRounds).sort()).toEqual([[1],[2]]);}
    expect((await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[order.currentRoundId])).rows[0].n).toBe(1);
  }

 }
}
