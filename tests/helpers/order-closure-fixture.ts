import { PoCustomerDateService } from "../../apps/api/src/production-platform/po-customer-date-service.js";
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {randomUUID} from 'node:crypto';
import {expect,vi} from 'vitest';
import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
export async function exerciseOrderClosure(db:Pool,sourcing:SourcingService,id:string,cuts:string[],actors:{root:TrustedActorContext;primary:TrustedActorContext;manager:TrustedActorContext;warehouse:TrustedActorContext;qc:TrustedActorContext},special:boolean){
 const {root,primary,manager,warehouse,qc}=actors,receiving=new ReceivingService(db),closure=new OrderClosureService(db),identity=new DigitalProductionIdentityService(db,true,sourcing);
 for(const actor of [root,manager]){
  if(!(await db.query('SELECT 1 FROM identity_mappings WHERE user_id=$1',[actor.actorId])).rowCount)await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),actor.actorId]);
  await db.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');try{for(const role of actor.actorRoles.filter(r=>r!=='root_superuser'))await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) SELECT $1,$2,$3,$2,'TEST P14' WHERE NOT EXISTS(SELECT 1 FROM user_role_assignments WHERE user_id=$2 AND role_code=$3 AND revoked_at IS NULL)",[randomUUID(),actor.actorId,role]);}finally{await db.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
 }
 await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) SELECT true,$1,i.provider_user_id,i.corp_id FROM identity_mappings i WHERE i.user_id=$1 AND i.active LIMIT 1 ON CONFLICT DO NOTHING",[root.actorId]);
 const photo=async()=>{const image=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P14.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/P14/${image}`,'e'.repeat(64),warehouse.actorId]);return image;};
 const receiver={...warehouse,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
 let order=await identity.read(primary,id);
 for(let i=0;i<order.lines.length;i++){order=await identity.correctNumbers(primary,id,order.lines[i]!.lineId,{expectedVersion:order.version,formalStyleNo:`TEST-P14-${randomUUID().slice(0,8)}-${i}`},randomUUID());}
 const stale=await closure.read(primary,id);expect(stale.stage).toBe('等待回货与装箱');
 const created=[];
 for(let i=0;i<cuts.length;i++){
  const qty=special?50:stale.lines[i]!.orderedQuantity;
  const first=await receiving.create(receiver,{cuttingOrderId:cuts[i],documentQuantity:qty,actualQuantity:qty-10,defectiveQuantity:0,attachmentIds:[await photo()]},randomUUID());
  const repeat=await receiving.createRepeated(receiver,{cuttingOrderId:cuts[i],receivingBatchId:first.value.receivingBatchId,source:'jiashun',actualQuantity:10,defectiveQuantity:0},randomUUID());created.push({first:first.value,repeat:repeat.value});
  const board=(await receiving.board('2000-01-01','2999-12-31',order.lines[i]!.formalStyleNo!)).rows[0]!;
  const current=await closure.read(primary,id);expect(current.lines[i]).toMatchObject({actualQuantity:board.cumulativeActualQuantity,receiptCount:2});
  const journey=await new DigitalJourneyQuery(db).read(root,id),nodes=journey.stages.flatMap(stage=>stage.nodes);
  expect(journey.lines.map(line=>line.id)).toEqual(order.lines.map(line=>line.lineId));
  if(i===0)expect(nodes.find(node=>node.key==='receipts')?.state).toBe('active');
  expect(journey.links.some(link=>link.domain==='receiving'&&link.id===first.value.receiptId&&link.lineId===order.lines[i]!.lineId)).toBe(true);
  expect((await db.query("SELECT count(*)::int n FROM digital_production_child_lines WHERE module='receiving' AND production_order_id=$1 AND line_id=$2",[id,order.lines[i]!.lineId])).rows[0].n).toBe(2);
  await receiving.recordPacking({...root,authorizationCapability:'receiving:packing_manage'}, {receivingBatchId:board.receivingBatchId,expectedVersion:board.version,expectedPackingRevisionId:null,packingQuantity:qty},randomUUID());
 }
 if(!special){
  const complete=await closure.read(manager,id);expect(complete.stage).toBe('本期装箱完成');
  const journey=await new DigitalJourneyQuery(db).read(root,id),nodes=journey.stages.flatMap(stage=>stage.nodes);
  expect(nodes.find(node=>node.key==='receipts')?.state).toBe('completed');expect(nodes.find(node=>node.key==='packing')?.state).toBe('completed');
  expect(journey.progress.bulk?.completed).toBe(journey.progress.bulk?.applicable);
  expect(complete.canClose).toBe(false);expect((await closure.read(root,id)).canClose).toBe(false);
  for(const actor of [manager,root])await expect(closure.close(actor,id,{reason:'TEST正常完成不得特殊结案',expectedRevision:complete.revision},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await db.query('SELECT count(*)::int n FROM digital_order_closures WHERE production_order_id=$1',[id])).rows[0].n).toBe(0);
  const source=complete.lines[0]!,target=complete.lines[1]!;
  const native=(await receiving.board('2000-01-01','2999-12-31',order.lines[0]!.formalStyleNo!)).rows.find(r=>r.receivingBatchId===source.receivingBatchId)!;
  await expect(receiving.correctBatch({...root,authorizationCapability:'receiving:correct'},source.receivingBatchId!,{expectedVersion:native.version,styleNo:order.lines[1]!.formalStyleNo!,documentQuantity:source.documentQuantity,actualQuantity:source.actualQuantity,defectiveQuantity:source.defectiveQuantity})).rejects.toMatchObject({code:'55000'});
  const unchanged=await closure.read(manager,id);expect(unchanged.lines).toEqual(complete.lines);expect(unchanged.stage).toBe('本期装箱完成');
  expect((await db.query('SELECT DISTINCT cutting_order_id FROM receiving_receipts WHERE receiving_batch_id=$1',[target.receivingBatchId])).rows).toEqual([{cutting_order_id:target.cuttingId}]);
  return;
 }
 const rework=new ReworkInitiationService(db,'corp');const draft=await rework.createDraft({...qc,authorizationCapability:'rework:initiate',authorizationCapabilities:['rework:initiate']},{receivingBatchId:created[0]!.first.receivingBatchId,problemPart:'TEST领口',problemDescription:'TEST成衣检查问题',reworkQuantity:2},randomUUID());
 expect((await db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='rework' AND child_id=$1",[draft.value.reworkOrderId])).rows[0].production_order_id).toBe(id);
 let sheet=await closure.read(primary,id);expect((await closure.read(root,id)).canClose).toBe(true);expect(sheet.lines[0]!.reworks[0]).toMatchObject({reworkId:draft.value.reworkOrderId,wageItemCount:0});expect(sheet.outstanding.some(x=>x.includes('未到足量'))).toBe(true);
 for(const actor of [primary,warehouse,qc])await expect(closure.close(actor,id,{reason:'TEST无权结案',expectedRevision:sheet.revision},randomUUID())).rejects.toMatchObject({statusCode:403});
 await expect(closure.close(manager,id,{reason:'TEST过期资料',expectedRevision:stale.revision},randomUUID())).rejects.toMatchObject({statusCode:409});
 const before=JSON.stringify(sheet.lines),key=randomUUID(),input={reason:'TEST客户取消余量，保留原QC问题继续处理',expectedRevision:sheet.revision};
 let concurrent:Awaited<ReturnType<typeof closure.close>>[];
 if(process.env.TEST_DATABASE_URL==='postgres://in-memory-only'){
  // PGlite serializes connections; the multi-connection barrier runs in real PG Gate.
  concurrent=await Promise.all([closure.close(manager,id,input,key),closure.close(manager,id,input,key)]);
 }else{
  let resume!:()=>void,ready!:()=>void,paused=false;
  const held=new Promise<void>(resolve=>{resume=resolve;}),snapshotReady=new Promise<void>(resolve=>{ready=resolve;});
  const originalRead=closure.read.bind(closure),readSpy=vi.spyOn(closure,'read').mockImplementation(async(...args)=>{const value=await originalRead(...args);if(args[2]&&!paused){paused=true;ready();await held;}return value;});
  const closing=closure.close(manager,id,input,key),repeated=closure.close(manager,id,input,key);
  let correction:ReturnType<typeof receiving.correctReceipt>|undefined,newRework:ReturnType<typeof rework.createDraft>|undefined;
  try{
   await Promise.race([snapshotReady,closing.then(()=>{throw new Error('closure did not expose its snapshot boundary');})]);
   const board=(await receiving.board('2000-01-01','2999-12-31',order.lines[0]!.formalStyleNo!)).rows[0]!;
   correction=receiving.correctReceipt({...root,authorizationCapability:'receiving:correct'},created[0]!.repeat.receiptId,{expectedVersion:board.version,source:'jiashun',documentQuantity:50,actualQuantity:11,defectiveQuantity:0});
   newRework=rework.createDraft({...qc,authorizationCapability:'rework:initiate',authorizationCapabilities:['rework:initiate']},{receivingBatchId:created[1]!.first.receivingBatchId,problemPart:'TEST并发',problemDescription:'TEST结案后新增原返工',reworkQuantity:1},randomUUID());
   // Observe both real writers blocked on the native table barrier, not a timer guess.
   await vi.waitFor(async()=>{const locks=(await db.query("SELECT DISTINCT relation::regclass::text relation FROM pg_locks WHERE NOT granted AND mode='RowExclusiveLock' AND relation IN ('receiving_receipt_corrections'::regclass,'rework_orders'::regclass)")).rows;expect(locks).toHaveLength(2);},{timeout:5000,interval:10});
   resume();concurrent=[await closing,await repeated];expect(concurrent[0]!.closed!.outstanding).toEqual(sheet.outstanding);
   await Promise.all([correction,newRework]);
   const fresh=await closure.read(primary,id);expect(fresh.lines[0]!.actualQuantity).toBe(51);expect(fresh.lines[1]!.reworks).toHaveLength(1);expect(fresh.closed).toEqual(concurrent[0]!.closed);
  }finally{resume();readSpy.mockRestore();await Promise.allSettled([closing,repeated,...(correction?[correction]:[]),...(newRework?[newRework]:[])]);}
 }
 sheet=concurrent[0]!;expect(concurrent[1]!.closed).toEqual(sheet.closed);expect(sheet.stage).toBe('特殊结案');expect(sheet.lines).toEqual(JSON.parse(before));expect(sheet.closed!.outstanding.some(x=>x.includes('未完成'))).toBe(true);expect(sheet.shipmentStatus).toBe('未知');expect(sheet.customerReceiptStatus).toBe('未知');expect((await closure.close(manager,id,input,key)).closed).toEqual(sheet.closed);
 const dates=new PoCustomerDateService(db),closedDates=await dates.read(primary,id);
 expect(closedDates.canRequestDate).toBe(false);
 const liveVersion=(await db.query("SELECT version FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0].version;
 await expect(dates.request(primary,id,{orderVersion:liveVersion,reason:"TEST结案不可新增交期申请",changes:[{lineId:closedDates.customerPoDates[0]!.lineId,expectedVersion:closedDates.customerPoDates[0]!.version,date:"2026-12-30"}]},randomUUID())).rejects.toMatchObject({statusCode:409});
 const journey=await new DigitalJourneyQuery(db).read(primary,id);
 const nodes=journey.stages.flatMap(stage=>stage.nodes);
 expect(nodes.find(node=>node.key==='special_closure')).toMatchObject({state:'completed',operator:{id:manager.actorId,name:sheet.closed!.closedBy},actualAt:sheet.closed!.closedAt});
 expect(nodes.find(node=>node.key==='cutting_gate')).toMatchObject({state:'completed',blockers:[]});
 expect(nodes.find(node=>node.key==='bulk_cutting'&&node.current)?.state).toBe('completed');
 expect(nodes.find(node=>node.key==='packing')?.state).toBe('active');
 expect(nodes.find(node=>node.key==='receipts')?.state).toBe('active');
 expect((await closure.read(primary,id)).closed).toEqual(sheet.closed);
 expect((await db.query('SELECT status FROM rework_orders WHERE rework_order_id=$1',[draft.value.reworkOrderId])).rows[0].status).toBe('draft');
 const flow=new FactoryFlowService(db),factory=await flow.read(primary,id);await expect(flow.followup(primary,id,{expectedRevision:factory.revision,kind:'工厂到料',occurredAt:null,note:'TEST结案后不得继续生产待办',trackingNumber:''},randomUUID())).rejects.toMatchObject({statusCode:409});
 const board=(await receiving.board('2000-01-01','2999-12-31',order.lines[0]!.formalStyleNo!)).rows[0]!;
 await expect(receiving.correctReceipt({...warehouse,authorizationCapability:'receiving:correct'},created[0]!.repeat.receiptId,{expectedVersion:board.version,source:'jiashun',documentQuantity:50,actualQuantity:12,defectiveQuantity:0})).rejects.toMatchObject({statusCode:403});
 await receiving.correctReceipt({...root,authorizationCapability:'receiving:correct'},created[0]!.repeat.receiptId,{expectedVersion:board.version,source:'jiashun',documentQuantity:50,actualQuantity:12,defectiveQuantity:0});
 const corrected=await closure.read(primary,id);expect(corrected.lines[0]!.actualQuantity).toBe(52);expect(corrected.closed).toEqual(sheet.closed);expect(corrected.lines[0]!.receipts[1]!.actualQuantity).toBe(12);
 expect((await db.query("SELECT count(*)::int n FROM digital_order_closures WHERE production_order_id=$1",[id])).rows[0].n).toBe(1);
 await expect(db.query("UPDATE digital_order_closures SET reason='TEST抹除' WHERE production_order_id=$1",[id])).rejects.toThrow();
}
