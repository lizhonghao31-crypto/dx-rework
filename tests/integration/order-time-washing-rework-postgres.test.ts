import {failedFrameworkWashingFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {preparedStoredRewash} from '../../apps/api/src/production-platform/order-time-washing-rework.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import type {BulkWashingCommand} from '@dx-rework/contracts/bulk-washing';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('native manager rewash arrangement and immutable P, R/D and history',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);
  await prepareRewashSettings(f); });
 afterAll(async()=>{await f?.dispose();});
 it.each(['after_receipt','factory'] as const)('freezes %s new work before logistics and preserves identities across replay and later arrangements',async mode=>{
  const {scene,orderId,lineId,inspectionId,requests,washing,repo,resource,command,operation}=await failedFrameworkWashingFixture(f,mode);
  let intentId='',startId='',completionId='',key='',firstResponse:unknown,firstBody:Record<string,unknown>,originalPlanId='';
  let originalTargets:unknown,newWorkIds:string[]=[],revision=0;
  await f.runtime.run(scene,f.root,async()=>{
   const before=(await repo.current(resource()))!;originalPlanId=before.id;originalTargets=structuredClone(before.input.frameworkPlans);revision=before.revision;
   const choices=await requests.check(f.root,operation);const choice=choices.rewashing!.find(row=>row.inspectionId===inspectionId)!;
   expect(choice).toMatchObject({availableQuantity:1,lineId});intentId=randomUUID();
   const rewashing=[{intentId,lineId,scopeId:choice.scopeId,quantityVersion:choice.quantityVersion,inspectionId,quantity:1}];
   await expect(washing.record(f.root,orderId,{...await command(),kind:mode==='factory'?'factory_start':'send',quantity:1,reworkOfInspectionId:inspectionId} as BulkWashingCommand,randomUUID())).rejects.toMatchObject({statusCode:409});
   const checked=await requests.check(f.root,operation,{},[],rewashing);
   expect(checked.feasibility,JSON.stringify(checked.coverage)).not.toBe('unknown');
   firstBody={resource:resource(),fingerprint:checked.fingerprint,overrides:{},rewashing,acceptLate:true};const keys=[randomUUID(),randomUUID()];
   await expect(requests.arrange(f.people['embroidery-washing-merchandiser']!,firstBody,randomUUID())).rejects.toMatchObject({statusCode:403});
   const auditCount=async()=>Number((await f.db.query("SELECT count(*) FROM audit_events WHERE entity_id=$1 AND action='order_time_arranged'",[orderId])).rows[0].count);
   const beforeFailure=await auditCount(),fault=vi.spyOn(OrderTimePlanRepository.prototype,'confirm').mockRejectedValueOnce(Error('TEST failure after native arrangement audit'));
   try{await expect(requests.arrange(f.root,firstBody,keys[0]!)).rejects.toThrow('TEST failure after native arrangement audit');}finally{fault.mockRestore();}
   expect(await auditCount()).toBe(beforeFailure);expect((await repo.current(resource()))!.id).toBe(originalPlanId);
   const competing=await Promise.allSettled(keys.map(key=>requests.arrange(f.root,firstBody,key)));
   const outcomes=competing.map(row=>row.status==='fulfilled'?{status:row.status}:{status:row.status,code:row.reason?.code,message:row.reason?.message});
   expect(competing.filter(row=>row.status==='fulfilled'),JSON.stringify(outcomes)).toHaveLength(1);
   expect(competing.find(row=>row.status==='rejected')).toMatchObject({reason:{code:'ORDER_TIME_STALE'}});
   const winner=competing.findIndex(row=>row.status==='fulfilled'),result=competing[winner]!;key=keys[winner]!;
   if(result.status!=='fulfilled')throw Error('TEST original transaction had no winner');
   // Compare the complete JSON/API receipt: PostgreSQL jsonb and the original
   // HTTP serializer both represent JavaScript's -0 margin as JSON zero.
   expect(result.value).toMatchObject({saved:true,planRevision:revision+1});
   firstResponse=JSON.parse(JSON.stringify(result.value));expect(await requests.arrange(f.root,firstBody,key)).toEqual(firstResponse);
   await expect(requests.arrange(f.root,{...firstBody,acceptLate:false},key)).rejects.toMatchObject({statusCode:409});
   const saved=(await repo.current(resource()))!;expect(saved.revision).toBe(revision+1);expect(saved.input.rewashing).toHaveLength(1);
   const row=saved.input.rewashing![0]!,prepared=preparedStoredRewash(row);newWorkIds=prepared.work.map(work=>work.id);
   expect(row).toMatchObject({intentId,inspectionId,introducedAt:'2026-11-17T08:00:00.000Z'});expect(row.introducedEventRef).toMatch(/^audit_events:/);
   const targets=Object.values(saved.input.frameworkPlans!)[0]!.arranged;
   expect(newWorkIds.map(id=>targets.find(target=>target.id===id)!.end.at)).toEqual(['2026-11-17T09:00:00.000Z','2026-11-17T10:00:00.000Z']);
   const prior=Object.values(before.input.frameworkPlans!)[0]!;for(const target of prior.arranged)expect(targets.find(row=>row.id===target.id)).toEqual(target);
   expect((await repo.current(resource()))!.input.work.filter(work=>newWorkIds.includes(work.id))).toHaveLength(2);
   expect((await washing.read(f.root,orderId)).scopes[0]!.facts.find(fact=>fact.id===inspectionId)).toMatchObject({qualifiedQuantity:1,voided:false});
  });
  await f.advance(scene,'2026-11-17T08:10:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const input={...await command(),occurredAt:'2026-11-17T08:10:00.000Z',quantity:1,reworkOfInspectionId:inspectionId,rewashWorkId:intentId};
   const start=await washing.record(f.root,orderId,{...input,kind:mode==='factory'?'factory_start':'send'} as BulkWashingCommand,randomUUID());startId=start.eventId;
   const scope=(await washing.read(f.root,orderId)).scopes[0]!;
   expect(scope.windows.find(window=>window.id===startId)).toMatchObject({startedAt:'2026-11-17T08:10:00.000Z',dueAt:'2026-11-17T09:10:00.000Z'});
   const saved=(await repo.current(resource()))!;expect(Object.values(saved.input.frameworkPlans!)[0]!.arranged.find(target=>target.id===newWorkIds[0])!.end.at).toBe('2026-11-17T09:00:00.000Z');
   expect((await f.db.query('SELECT input_snapshot FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[originalPlanId])).rows[0].input_snapshot.frameworkPlans).toEqual(originalTargets);
   const before=(await repo.current(resource()))!,checked=await requests.check(f.root,{kind:'arrangement',resource:resource()});
   await requests.arrange(f.root,{resource:resource(),fingerprint:checked.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const later=(await repo.current(resource()))!;expect(later.revision).toBe(before.revision+1);
   expect(later.input.rewashing).toEqual(before.input.rewashing);
   expect(later.input.work.filter(work=>newWorkIds.includes(work.id))).toEqual(before.input.work.filter(work=>newWorkIds.includes(work.id)));
   for(const id of newWorkIds)expect(Object.values(later.input.frameworkPlans!)[0]!.arranged.find(target=>target.id===id)).toEqual(Object.values(before.input.frameworkPlans!)[0]!.arranged.find(target=>target.id===id));
   expect(await requests.arrange(f.root,firstBody,key)).toEqual(firstResponse);
   expect((await repo.current(resource()))!.id).toBe(later.id);
  });
  await f.advance(scene,'2026-11-17T09:05:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const input={...await command(),occurredAt:'2026-11-17T09:05:00.000Z',quantity:1};
   completionId=(await washing.record(f.root,orderId,mode==='factory'?{...input,kind:'factory_complete',startId}:{...input,kind:'return',sendId:startId},randomUUID())).eventId;
  });
  await f.advance(scene,'2026-11-17T09:20:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const before=(await repo.current(resource()))!;
   await washing.record(f.root,orderId,{...await command(),occurredAt:'2026-11-17T09:20:00.000Z',kind:'inspection',completionId,quantity:1,qualifiedQuantity:1},randomUUID());
   const scope=(await washing.read(f.root,orderId)).scopes[0]!;
   expect(scope.ledger).toMatchObject({qualified:2,remaining:0,complete:true});
   expect(scope.facts.find(fact=>fact.id===inspectionId)).toMatchObject({qualifiedQuantity:1,voided:false});
   const detail=await new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true);
   const nodes=detail.stages.flatMap(stage=>stage.nodes),rewash=nodes.find(node=>node.instanceId.endsWith(':'+newWorkIds[0]))!,inspection=nodes.find(node=>node.instanceId.endsWith(':'+newWorkIds[1]))!;
   expect(rewash).toMatchObject({state:'completed',actualAt:'2026-11-17T09:05:00.000Z',countsInProgress:false,planningOnly:true});
   expect(inspection).toMatchObject({state:'completed',actualAt:'2026-11-17T09:20:00.000Z',countsInProgress:false,planningOnly:true});
   const afterRead=(await repo.current(resource()))!,frozen=(value:typeof before)=>Object.values(value.input.frameworkPlans!)[0]!.arranged.find(target=>target.id===newWorkIds[0]);
   expect(rewash.fixedTargets![0]!.progress.currentTarget!.at,JSON.stringify({asOf:detail.asOf,before:{id:before.id,target:frozen(before)},after:{id:afterRead.id,target:frozen(afterRead)},progress:rewash.fixedTargets![0]!.progress,windows:rewash.nativeWindows})).toBe('2026-11-17T09:00:00.000Z');
   expect(rewash.fixedTargets![0]!.progress.ownSla.deadlineAt).toBe('2026-11-17T09:10:00.000Z');
   expect((await repo.current(resource()))!.id).toBe(before.id);
   expect((await f.db.query('SELECT input_snapshot FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[originalPlanId])).rows[0].input_snapshot.frameworkPlans).toEqual(originalTargets);
  });
  expect(originalTargets).toBeDefined();
 });
 it('keeps original v1 snapshots valid and rejects unversioned, empty, disguised or source-scoped rewash input in PostgreSQL',async()=>{
  const original=(await f.db.query("SELECT * FROM digital_order_time_plan_versions WHERE input_snapshot->>'version'='order-time-input-rewash-v1' ORDER BY recorded_at LIMIT 1")).rows[0]!;
  const legacy=(await f.db.query("SELECT input_snapshot FROM digital_order_time_plan_versions WHERE input_snapshot->>'version'='order-time-input-v1' ORDER BY recorded_at LIMIT 1")).rows[0]!;
  const source=(await f.db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[original.production_order_id])).rows[0].source_id;
  const client=await f.db.connect();
  try{
   await client.query('BEGIN');
   const insert=async(input:unknown,kind='order')=>client.query(`INSERT INTO digital_order_time_plan_versions(plan_version_id,resource_kind,source_id,production_order_id,revision,input_snapshot,fixed_targets,identity_hash,change_kind,source_event_ref,business_time,created_by,request_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'arrangement',$9,$10,$11,$12)`,[randomUUID(),kind,kind==='source'?source:null,kind==='order'?original.production_order_id:null,original.revision+100000,JSON.stringify(input),JSON.stringify(original.fixed_targets),original.identity_hash,original.source_event_ref,JSON.stringify(original.business_time),original.created_by,'TEST-format-'+randomUUID()]);
   // SQL format-boundary probes are rolled back; they are not approved plans.
   for(const input of [legacy.input_snapshot,original.input_snapshot]){
    await client.query('SAVEPOINT format_probe');await insert(input);await client.query('ROLLBACK TO SAVEPOINT format_probe');await client.query('RELEASE SAVEPOINT format_probe');
   }
   for(const [input,kind] of [[{...original.input_snapshot,version:'unknown'},'order'],[{...original.input_snapshot,rewashing:[]},'order'],[{...original.input_snapshot,version:'order-time-input-v1'},'order'],[original.input_snapshot,'source']] as const){
    await client.query('SAVEPOINT format_probe');await expect(insert(input,kind)).rejects.toMatchObject({code:'23514'});await client.query('ROLLBACK TO SAVEPOINT format_probe');await client.query('RELEASE SAVEPOINT format_probe');
   }
  }finally{await client.query('ROLLBACK');client.release();}
  expect((await f.db.query('SELECT input_snapshot FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[original.plan_version_id])).rows[0].input_snapshot).toEqual(original.input_snapshot);
 });
});
