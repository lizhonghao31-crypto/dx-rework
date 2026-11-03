import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {businessAnchorFixture} from './business-anchor-fixture.js';
import {ProductionOrderRootRepository} from '../../apps/api/src/production-platform/order-root-repository.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {BulkPreshrinkCorrectionService,SCOPED_PRESHRINK_CORRECTION_ORDER} from '../../apps/api/src/production-platform/bulk-preshrink-correction-service.js';
import * as requirements from '../../apps/api/src/production-platform/bulk-preshrink-requirement.js';
import {productionReadiness} from '../../apps/api/src/production-platform/production-readiness-repository.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';

/** Owned isolated schema only. Native commands create all facts; only the old choice bug is replayed. */
export async function bulkPreshrinkCorrectionFixture(url:string,choice:'需要预缩'|'无需预缩'='无需预缩'){
 const f=await businessAnchorFixture(url);
 try{
  const create=ProductionOrderRootRepository.prototype.create;
  const fixedId=vi.spyOn(ProductionOrderRootRepository.prototype,'create').mockImplementationOnce(function(this:ProductionOrderRootRepository,actor:string){
   return create.call(this,actor,SCOPED_PRESHRINK_CORRECTION_ORDER);
  });
  let ready:Awaited<ReturnType<typeof f.bulkReady>>;
  try{ready=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true});}finally{fixedId.mockRestore();}
  const id=ready.id,bulk=new BulkPreparationService(f.db),instruction=new ProductionInstructionService(f.db,true),primary=f.people.merchandiser!;
  const order=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[id])).rows[0];
  const original=(await f.db.query('SELECT document FROM digital_instruction_versions WHERE production_order_id=$1 AND version=1',[id])).rows[0].document;
  for(const expectedVersion of [1,2])await instruction.save(primary,id,{expectedVersion,orderVersion:order.version,sourceRound:1,document:{...original,preshrink:choice}},randomUUID());
  const readiness=await productionReadiness(f.db,id),resolve=requirements.resolveBulkPreshrinkRequirement;
  // Reproduce the former writer: parallel preparation used '需要预缩' despite published '无需预缩'.
  // No SQL guard is disabled and no existing immutable record is changed.
  const legacyWriter=vi.spyOn(requirements,'resolveBulkPreshrinkRequirement').mockImplementation((prep,document)=>!prep&&document?.preshrink==='无需预缩'?'需要预缩':resolve(prep,document));
  try{await instruction.publish(primary,id,{expectedVersion:3,orderVersion:order.version,expectedReadinessRevision:readiness.revision},randomUUID());}finally{legacyWriter.mockRestore();}
  let sheet=await bulk.read(f.root,id);
  await bulk.dispatch(f.people['development-clerk']!,id,{expectedVersion:sheet.dispatch.version,patternWorkerId:f.people['pattern-room-worker']!.actorId,deliverPattern:true},randomUUID());
  sheet=await bulk.read(f.root,id);
  const preparationId=sheet.preparationId!,pattern=f.people['pattern-room-worker']!,lines=(await f.db.query('SELECT line_id,color FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[id])).rows;
  const complete=async(kind:'纸样完成'|'唛架完成',expectedVersion:number,lineIds:string[],whole:boolean)=>bulk.complete(pattern,id,{preparationId,kind,expectedReadinessRevision:(await productionReadiness(f.db,id)).revision,
   range:{expectedVersion,lineIds,complete:whole,pendingMaterialIds:[],note:whole?'TEST 原全色完成':'TEST 原黑色局部完成',evidenceIds:[]}},randomUUID());
  await complete('纸样完成',0,[lines[0]!.line_id],false);
  await complete('纸样完成',1,lines.map(row=>row.line_id as string),true);
  await complete('唛架完成',0,lines.map(row=>row.line_id as string),true);
  sheet=await bulk.read(f.root,id);
  const target={preparationId,preshrinkTaskId:sheet.tasks.find(task=>task.taskKind==='warehouse_preshrink')!.taskId};
  const service=new BulkPreshrinkCorrectionService(f.db,new RootAuthority(f.db,'anchor-test','uat-root'));
  return {...f,ready,id,bulk,instruction,service,target,patternId:sheet.tasks.find(task=>task.taskKind==='bulk_pattern')!.taskId};
 }catch(error){await f.dispose();throw error;}
}
