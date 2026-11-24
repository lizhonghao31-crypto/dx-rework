import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFactRepository,JourneyFactBusy} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
import {JOURNEY_FACT_CALCULATION_VERSION} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {readJourneySelections} from '../../apps/api/src/production-platform/journey-selection-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PERF02 transactional native fact updates',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,repo:JourneyFactRepository,identity:DigitalProductionIdentityService,scene:string;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 const make=()=>identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-UPDATES-'+randomUUID(),orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID());
 const pending=async(id:string)=>(await f.db.query('SELECT transaction_id FROM digital_journey_fact_changes WHERE resource_id=$1',[id])).rows;
 const status=async(id:string)=>{const db=await f.db.connect();try{return await repo.readStoredWithClient(db,{kind:'order',id});}finally{await db.query('ROLLBACK');db.release();}};
 beforeAll(async()=>{f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-08T00:00:00Z');repo=new JourneyFactRepository(f.db);identity=new DigitalProductionIdentityService(f.db,true);});
 beforeEach(async()=>{vi.restoreAllMocks();await f.db.query('DELETE FROM digital_journey_fact_changes');await f.db.query('DELETE FROM digital_journey_fact_retries');});
 afterAll(async()=>{vi.restoreAllMocks();await f?.dispose();});
 it('upgrades only affected old orders, keeps a compatible source readable and preserves dirty writes during reconstruction',async()=>{
  // Keep live-clock records out of the existing fixed-clock integration fixture.
  const f=await businessAnchorFixture(url!),repo=new JourneyFactRepository(f.db),identity=new DigitalProductionIdentityService(f.db,true);
  const make=()=>identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-LABEL-'+randomUUID(),orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID());
  const pending=async(id:string)=>(await f.db.query('SELECT transaction_id FROM digital_journey_fact_changes WHERE resource_id=$1',[id])).rows;
  const status=async(id:string)=>{const db=await f.db.connect();try{return await repo.readStoredWithClient(db,{kind:'order',id});}finally{db.release();}};
  try{
   const style='TEST-LABEL-C-'+randomUUID();
   const a=await make(),b=await make(),d=await make(),source=await identity.createSource(f.root,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const sourceScope={kind:'source' as const,id:source.sourceId},orderScope=(id:string)=>({kind:'order' as const,id});
   const resources=[orderScope(a.productionOrderId),orderScope(b.productionOrderId),sourceScope,orderScope(d.productionOrderId)];
   for(const resource of resources)await repo.buildOne(resource);
   const bBefore=(await status(b.productionOrderId)).model;
   const old=[a.productionOrderId,source.sourceId,d.productionOrderId];
   await f.db.query("UPDATE digital_journey_fact_models SET calculation_version='journey-facts-material-investment-v19' WHERE resource_id=ANY($1::uuid[])",[old]);
   const db=await f.db.connect();try{
    expect(await repo.readStoredWithClient(db,sourceScope)).toMatchObject({status:'ready',model:{orderId:null}});
    const selected=await repo.readSelectionsWithClient(db,resources,new Date().toISOString());
    expect(resources.map(scope=>selected.items.get(scope.kind+':'+scope.id)?.status)).toEqual(['obsolete','ready','ready','obsolete']);
    const sql=await readJourneySelections(f.db,db,f.root,resources.map(scope=>scope.kind==='order'
     ?{source:null,order:{production_order_id:scope.id}}:{order:null,source:{source_id:scope.id}}),JourneyFilterSchema.parse({}),new Date().toISOString());
    expect(sql.items.map(item=>[item.resource.id,item.status]).sort()).toEqual(resources.map((scope,index)=>[scope.id,['obsolete','ready','ready','obsolete'][index]]).sort());
   }finally{db.release();}
   const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'});
   expect(await query.list(f.root,JourneyFilterSchema.parse({scope:'production',search:a.productionOrderId}))).toMatchObject({total:null,summary:null});
   expect((await query.list(f.root,JourneyFilterSchema.parse({scope:'production',search:b.productionOrderId}))).total).toBe(1);
   const updates=new JourneyFactUpdates(f.db,repo);
   await updates.registerBackfill();
   expect(await pending(a.productionOrderId)).toHaveLength(1);expect(await pending(d.productionOrderId)).toHaveLength(1);
   expect(await pending(b.productionOrderId)).toHaveLength(0);expect(await pending(source.sourceId)).toHaveLength(0);
   const original=DigitalJourneyQuery.prototype.buildFactsWithClient;
   let enter!:()=>void,release!:()=>void;
   const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
   const spy=vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient').mockImplementation(async function(...args){
    if(args[1].id===a.productionOrderId){enter();await released;}
    return original.apply(this,args);
   });
   const building=updates.runOnce();await entered;
   try{await f.db.query('UPDATE digital_production_po_sizes SET quantity=11 WHERE line_id=$1',[a.lines[0]!.lineId]);}finally{release();}
   expect(await building).toMatchObject({built:2,failed:0});spy.mockRestore();
   expect(await status(a.productionOrderId)).toMatchObject({status:'pending',model:null});
   expect(await status(d.productionOrderId)).toMatchObject({status:'ready'});
   expect((await status(b.productionOrderId)).model).toEqual(bBefore);
   await f.db.query("UPDATE digital_journey_fact_models SET selection_expires_at=clock_timestamp()-interval '1 second' WHERE resource_id=$1",[source.sourceId]);
   expect(await updates.runOnce()).toMatchObject({built:2,failed:0});
   expect(await pending(a.productionOrderId)).toHaveLength(0);expect(await pending(source.sourceId)).toHaveLength(0);
   expect((await f.db.query('SELECT calculation_version FROM digital_journey_fact_models WHERE resource_id=$1',[source.sourceId])).rows[0]?.calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
   await f.db.query("UPDATE digital_journey_fact_models SET calculation_version='journey-facts-material-investment-v19' WHERE resource_id=$1",[source.sourceId]);
   const linked=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID());
   await identity.attachSource(f.root,linked.productionOrderId,source.sourceId,randomUUID());
   const after=await f.db.connect();try{expect((await repo.readStoredWithClient(after,sourceScope)).model).toBeNull();}finally{after.release();}
  }finally{await f.dispose();}
 });
 it('recovers the original dirty work when a real projection process is killed before or after commit',async()=>{
  const f=await businessAnchorFixture(url!),repo=new JourneyFactRepository(f.db),identity=new DigitalProductionIdentityService(f.db,true);
  const worker=`
   import pg from 'pg';
   import { JourneyFactUpdates } from './apps/api/src/production-platform/journey-fact-updates.ts';
   import { assertTestDatabaseTarget } from './scripts/test-database-safety.mjs';
   process.once('message', async ({url,searchPath,phase})=>{
    try {
     await assertTestDatabaseTarget(url);
     const pool=new pg.Pool({connectionString:url,options:searchPath,max:3,connectionTimeoutMillis:3000});
     const database=new Proxy(pool,{get(target,key){
      if(key==='connect'&&phase!=='normal')return async()=>{
       const client=await target.connect(),query=client.query.bind(client);
       client.query=async(statement,...args)=>{
        if(statement!=='COMMIT')return query(statement,...args);
        if(phase==='before')process.send('before');
        else {await query(statement,...args);process.send('after');}
        await new Promise(()=>{});
       };
       return client;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
     }});
     const result=await new JourneyFactUpdates(database).runOnce();
     await pool.end();
     process.send(result,()=>process.disconnect());
    } catch(error) {process.send({workerError:error?.name,code:error?.code},()=>process.disconnect());process.exitCode=1;}
   });
  `;
  const runWorker=async(phase:'before'|'after'|'normal')=>{
   const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',worker],{stdio:['ignore','ignore','ignore','ipc']});
   const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
   let timeout:ReturnType<typeof setTimeout>|undefined;
   try{
    const message=await new Promise<unknown>((resolve,reject)=>{
     child.once('message',resolve);
     child.once('error',reject);
     void closed.then(result=>reject(new Error('TEST worker exited before the boundary: '+JSON.stringify(result))));
     timeout=setTimeout(()=>reject(new Error('TEST worker did not reach '+phase+' within limit')),15000);
     child.send({url,searchPath:f.db.options.options,phase},error=>{if(error)reject(error);});
    });
    expect(message).toEqual(phase==='normal'?{built:expect.any(Number),retired:0,failed:0,busy:0}:phase);
    if(phase!=='normal'){
     expect(child.kill('SIGKILL')).toBe(true);
     expect(await closed).toEqual({code:null,signal:'SIGKILL'});
    }else expect(await closed).toEqual({code:0,signal:null});
    return message;
   }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
  };
  try{
   const order=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-LABEL-KILL-'+randomUUID(),orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID());
   const scope={kind:'order' as const,id:order.productionOrderId};
   const read=async()=>{const client=await f.db.connect();try{return await repo.readStoredWithClient(client,scope);}finally{client.release();}};
   const model=async()=>(await f.db.query('SELECT source_fingerprint,source_version,calculation_version FROM digital_journey_fact_models WHERE resource_id=$1',[scope.id])).rows[0];
   const dirty=async()=>(await f.db.query('SELECT transaction_id FROM digital_journey_fact_changes WHERE resource_id=$1 ORDER BY transaction_id',[scope.id])).rows;
   const change=(expectedVersion:number)=>identity.correctNumbers(f.root,scope.id,order.lines[0]!.lineId,{expectedVersion,formalPoNo:'TEST-REVISED-'+randomUUID()},randomUUID());
   await repo.buildOne(scope);const initial=await model();
   await change(order.version);const originalDirty=await dirty();expect(originalDirty).toHaveLength(1);
   await runWorker('before');
   expect(await read()).toMatchObject({status:'pending',model:null});expect(await model()).toEqual(initial);expect(await dirty()).toEqual(originalDirty);
   expect(await runWorker('normal')).toMatchObject({built:1});expect((await read()).status).toBe('ready');expect(await dirty()).toEqual([]);
   const beforeCommit=await model();
   await change(order.version+1);expect(await dirty()).toHaveLength(1);
   await runWorker('after');
   const committed=await model();
   expect(committed.calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
   expect(BigInt(committed.source_version)).toBe(BigInt(beforeCommit.source_version)+1n);
   expect((await read()).status).toBe('ready');expect(await dirty()).toEqual([]);
   expect(await runWorker('normal')).toMatchObject({built:0});
   expect(await model()).toEqual(committed);
  }finally{await f.dispose();}
 });
 it('registers native create/correction once per transaction and refuses the old result immediately after save',()=>run(async()=>{
  const order=await make(),scope={kind:'order' as const,id:order.productionOrderId};expect(await pending(scope.id)).toHaveLength(1);
  const first=await repo.buildOne(scope);expect((await status(scope.id)).status).toBe('ready');
  await identity.correctNumbers(f.root,scope.id,order.lines[0]!.lineId,{expectedVersion:order.version,formalPoNo:'TEST-NEW-'+randomUUID()},randomUUID());
  expect(await pending(scope.id)).toHaveLength(1);expect(await status(scope.id)).toMatchObject({status:'pending',model:null});
  const next=await repo.buildOne(scope);expect(BigInt(next.sourceVersion)).toBe(BigInt(first.sourceVersion)+1n);
  expect(await pending(scope.id)).toHaveLength(0);expect((await repo.buildOne(scope)).sourceVersion).toBe(next.sourceVersion);
 }));
 it('rolls back invalidation with business facts and does not invalidate another mother',()=>run(async()=>{
  const a=await make(),b=await make();await repo.buildOne({kind:'order',id:a.productionOrderId});await repo.buildOne({kind:'order',id:b.productionOrderId});
  const db=await f.db.connect();try{await db.query('BEGIN');await db.query('UPDATE digital_production_po_sizes SET quantity=11 WHERE line_id=$1',[a.lines[0]!.lineId]);
   expect((await db.query('SELECT 1 FROM digital_journey_fact_changes WHERE resource_id=$1',[a.productionOrderId])).rowCount).toBe(1);
   expect(await pending(a.productionOrderId)).toHaveLength(0);await db.query('ROLLBACK');}finally{await db.query('ROLLBACK');db.release();}
  expect((await status(a.productionOrderId)).status).toBe('ready');expect((await status(b.productionOrderId)).status).toBe('ready');
 }));
 it('keeps a real modification committed during construction pending and builds it on the next pass',()=>run(async()=>{
  const order=await make(),scope={kind:'order' as const,id:order.productionOrderId};await repo.buildOne(scope);
  await f.db.query('UPDATE digital_production_po_sizes SET quantity=11 WHERE line_id=$1',[order.lines[0]!.lineId]);
  const original=DigitalJourneyQuery.prototype.buildFactsWithClient;let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient').mockImplementationOnce(async function(...args){enter();await released;return original.apply(this,args);});
  const building=repo.buildOne(scope);await entered;
  try{await f.db.query('UPDATE digital_production_po_sizes SET quantity=12 WHERE line_id=$1',[order.lines[0]!.lineId]);}finally{release();}
  const older=await building;expect(older.model.quantities!.lines[0]!.demand).toBe(11);expect(await status(scope.id)).toMatchObject({status:'pending',model:null});
  const newer=await repo.buildOne(scope);expect(newer.model.quantities!.lines[0]!.demand).toBe(12);expect(BigInt(newer.sourceVersion)).toBeGreaterThan(BigInt(older.sourceVersion));
 }));
 it('does not lose a lower transaction ID committed after a later transaction was built',()=>run(async()=>{
  const order=await make(),scope={kind:'order' as const,id:order.productionOrderId};await repo.buildOne(scope);
  const earlier=await f.db.connect();try{await earlier.query('BEGIN');await earlier.query('SELECT txid_current()');
   await f.db.query('UPDATE digital_production_po_sizes SET quantity=13 WHERE line_id=$1',[order.lines[0]!.lineId]);await repo.buildOne(scope);
   await earlier.query('UPDATE digital_production_po_sizes SET quantity=14 WHERE line_id=$1',[order.lines[0]!.lineId]);await earlier.query('COMMIT');
  }catch(e){await earlier.query('ROLLBACK');throw e;}finally{earlier.release();}
  expect(await status(scope.id)).toMatchObject({status:'pending',model:null});expect((await repo.buildOne(scope)).model.quantities!.lines[0]!.demand).toBe(14);
 }));
 it('serializes only builders for the same mother without blocking a native write or another mother',()=>run(async()=>{
  const a=await make(),b=await make(),scope={kind:'order' as const,id:a.productionOrderId};const db=await f.db.connect();
  try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journey-fact:order',scope.id]);
   await expect(repo.buildOne(scope)).rejects.toBeInstanceOf(JourneyFactBusy);
   await f.db.query('UPDATE digital_production_po_sizes SET quantity=15 WHERE line_id=$1',[a.lines[0]!.lineId]);
   expect((await repo.buildOne({kind:'order',id:b.productionOrderId})).model.orderId).toBe(b.productionOrderId);
  }finally{await db.query('ROLLBACK');db.release();}
  expect((await repo.buildOne(scope)).model.quantities!.lines[0]!.demand).toBe(15);
 }));
 it('isolates one build failure, keeps its dirty row and retries that exact mother',()=>run(async()=>{
  const a=await make(),b=await make(),original=DigitalJourneyQuery.prototype.buildFactsWithClient;
  const spy=vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient').mockImplementation(async function(...args){if(args[1].id===a.productionOrderId)throw Error('TEST isolated builder failure');return original.apply(this,args);});
  const updates=new JourneyFactUpdates(f.db,repo),result=await updates.runOnce();expect(result).toMatchObject({failed:1,built:1});
  expect(await pending(a.productionOrderId)).toHaveLength(1);expect(await pending(b.productionOrderId)).toHaveLength(0);expect((await status(b.productionOrderId)).status).toBe('ready');
  expect((await f.db.query('SELECT attempts,error_code FROM digital_journey_fact_retries WHERE resource_id=$1',[a.productionOrderId])).rows[0]).toEqual({attempts:1,error_code:'BUILD_FAILED'});
  const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),filter=JourneyFilterSchema.parse({scope:'production',search:a.productionOrderId});
  expect(await query.list(f.root,filter)).toMatchObject({total:null,summary:null,freshness:{failed:1,pending:0,retryIds:[a.productionOrderId]}});
  expect((await query.list(f.root,{...filter,search:b.productionOrderId})).total).toBe(1);
  const client=await f.db.connect();try{const selection=await repo.readSelectionsWithClient(client,[{kind:'order',id:a.productionOrderId}],(await f.runtime.repository.view(scene)).now);
   expect(selection.items.get('order:'+a.productionOrderId)).toMatchObject({status:'failed',facts:null});}finally{client.release();}
  spy.mockRestore();await f.db.query("UPDATE digital_journey_fact_retries SET retry_after=clock_timestamp()-interval '1 second' WHERE resource_id=$1",[a.productionOrderId]);
  expect(await updates.runOnce()).toMatchObject({built:1,failed:0});expect((await status(a.productionOrderId)).status).toBe('ready');expect(await updates.runOnce()).toMatchObject({built:0,failed:0});
  expect((await query.list(f.root,filter)).total).toBe(1);
 }));
 it('explicitly queues only a failed native mother and clears its backoff without rebuilding in the retry request',()=>run(async()=>{
  const a=await make(),original=DigitalJourneyQuery.prototype.buildFactsWithClient;
  const spy=vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient').mockImplementationOnce(async()=>{throw Error('TEST native failed first build');});
  const updates=new JourneyFactUpdates(f.db,repo);expect(await updates.runOnce()).toMatchObject({failed:1});spy.mockRestore();
  const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),filter=JourneyFilterSchema.parse({scope:'production',search:a.productionOrderId});
  const build=vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient').mockImplementation(original);
  expect(await query.refreshOne(f.root,a.productionOrderId)).toEqual({status:'pending'});expect(build).not.toHaveBeenCalled();
  expect((await f.db.query('SELECT 1 FROM digital_journey_fact_retries WHERE resource_id=$1',[a.productionOrderId])).rowCount).toBe(0);
  expect(await query.list(f.root,filter)).toMatchObject({total:null,freshness:{failed:0,pending:1}});
  expect(await updates.runOnce()).toMatchObject({built:1,failed:0});expect((await query.list(f.root,filter)).total).toBe(1);
 }));
 it('preserves immutable task ownership and rolls a denied rebind back without dirtying either mother',()=>run(async()=>{
  const a=await make(),b=await make();await repo.buildOne({kind:'order',id:a.productionOrderId});await repo.buildOne({kind:'order',id:b.productionOrderId});
  const db=await f.db.connect();try{await db.query('BEGIN');
   await expect(db.query('UPDATE digital_production_task_access SET production_order_id=$2 WHERE production_order_id=$1',[a.productionOrderId,b.productionOrderId])).rejects.toMatchObject({code:'55000'});
  }finally{await db.query('ROLLBACK');db.release();}
  expect(await pending(a.productionOrderId)).toHaveLength(0);expect(await pending(b.productionOrderId)).toHaveLength(0);
  expect((await status(a.productionOrderId)).status).toBe('ready');expect((await status(b.productionOrderId)).status).toBe('ready');
 }));
 it('does not apply an older failure backoff after another builder already consumed its changes',()=>run(async()=>{
  const order=await make(),scope={kind:'order' as const,id:order.productionOrderId};await repo.buildOne(scope);
  await f.db.query('UPDATE digital_production_po_sizes SET quantity=16 WHERE line_id=$1',[order.lines[0]!.lineId]);
  let enter!:()=>void,fail!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
  vi.spyOn(repo,'buildOne').mockImplementationOnce(()=>new Promise((_resolve,reject)=>{enter();fail=()=>reject(Error('TEST delayed failure'));}));
  const older=new JourneyFactUpdates(f.db,repo).runOnce();await entered;
  try{await new JourneyFactRepository(f.db).buildOne(scope);await f.db.query('UPDATE digital_production_po_sizes SET quantity=17 WHERE line_id=$1',[order.lines[0]!.lineId]);}finally{fail();}
  expect(await older).toMatchObject({failed:1});expect((await f.db.query('SELECT 1 FROM digital_journey_fact_retries WHERE resource_id=$1',[scope.id])).rowCount).toBe(0);
  expect(await pending(scope.id)).toHaveLength(1);expect(await status(scope.id)).toMatchObject({status:'pending',model:null});
 }));
 it('registers original order-scoped events even when no technical task exists',()=>run(async()=>{
  const order=await make(),scope={kind:'order' as const,id:order.productionOrderId};await repo.buildOne(scope);
  const db=await f.db.connect();try{await db.query('BEGIN');
   const snapshot=(await db.query('SELECT snapshot_id FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[scope.id])).rows[0]!.snapshot_id;
   await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,time_quality,payload) VALUES($1,NULL,'order',$2,'sla_standard_applied',$3,'现场登记',$4)",[randomUUID(),scope.id,f.root.actorId,JSON.stringify({snapshotId:snapshot,parameterKeys:['warning_ratio'],completedWindows:[]})]);
   expect((await db.query('SELECT 1 FROM digital_journey_fact_changes WHERE resource_id=$1',[scope.id])).rowCount).toBe(1);
  }finally{await db.query('ROLLBACK');db.release();}
  expect(await pending(scope.id)).toHaveLength(0);
 }));
 it('preserves original text-key audit writes without UUID coercion or unrelated invalidation',()=>run(async()=>{
  const order=await make();await repo.buildOne({kind:'order',id:order.productionOrderId});const db=await f.db.connect();
  try{await db.query('BEGIN');for(const entityId of ['0915','','role:owner_group','------------------------------------']){
   const id=await new OperationEventRepository().append(db,f.root,{action:'access.member_module.bind',entityType:'business_module_owner_bindings',entityId,after:{testOnly:true},reason:'TEST original generic text-key audit storage, no binding command'});
   expect((await db.query('SELECT entity_id FROM operation_events WHERE event_id=$1',[id])).rows[0]!.entity_id).toBe(entityId);
  }
  expect((await db.query('SELECT 1 FROM digital_journey_fact_changes')).rowCount).toBe(0);
  }finally{await db.query('ROLLBACK');db.release();}
  expect((await status(order.productionOrderId)).status).toBe('ready');
 }));
 it('tracks original multi-PO preparation, task reassignment, dispatch, effective work and packing families',()=>run(async()=>{
  const ready=await f.reworkReady(),mother=ready.ready.id,scope={kind:'order' as const,id:mother};await repo.buildOne(scope);
  const targets=[['digital_bulk_preparations','preparation_id',ready.ready.preparationId],['digital_production_task_access','production_order_id',mother],['rework_work_tasks','rework_order_id',ready.id],['receiving_batches','receiving_batch_id',(await f.db.query('SELECT source_receiving_batch_id id FROM rework_orders WHERE rework_order_id=$1',[ready.id])).rows[0]!.id]];
  for(const [table,column,id]of targets){const db=await f.db.connect();try{await db.query('BEGIN');
   // Actual row changes, fully rolled back. Null/no-op UPDATE would not exercise
   // the change trigger. jsonb_populate_record exercises the registered native
   // ownership query using each current legal row without bypassing guards.
   const trigger=(await db.query("SELECT encode(tgargs,'escape') args FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='journey_fact_dirty'",[table])).rows[0];expect(trigger,table).toBeTruthy();
   const native=(await db.query(`SELECT to_jsonb(t) item FROM ${table} t WHERE ${column}=$1 LIMIT 1`,[id])).rows[0]!.item;
   const query=String(trigger.args).split('\\000')[0]!.replaceAll('$1','$1::jsonb');const roots=(await db.query(query,[native])).rows;
   const affected=(await db.query('SELECT DISTINCT a.* FROM jsonb_to_recordset($1::jsonb) x(kind text,id uuid) CROSS JOIN LATERAL digital_journey_affected(x.kind,x.id) a',[JSON.stringify(roots)])).rows;
   expect(affected.some(r=>r.resource_kind==='order'&&r.resource_id===mother),table).toBe(true);await db.query('ROLLBACK');
  }finally{await db.query('ROLLBACK');db.release();}}
  expect((await status(mother)).status).toBe('ready');
  const ownTask=ready.state.tasks.find(t=>t.members.some(m=>m.personId===ready.own))!;
  await ready.work.submitReport(ready.worker,ownTask.workTaskId,{expectedOrderVersion:ready.state.orderVersion,actualQuantity:1,completedAt:'2026-11-08T00:00:00.000Z'},randomUUID());
  expect(await pending(mother)).toHaveLength(1);expect(await status(mother)).toMatchObject({status:'pending',model:null});await repo.buildOne(scope);
  const batch=(await f.db.query('SELECT b.* FROM receiving_batches b JOIN rework_orders r ON r.source_receiving_batch_id=b.receiving_batch_id WHERE r.rework_order_id=$1',[ready.id])).rows[0]!;
  await new ReceivingService(f.db).recordPacking({...f.root,authorizationCapability:'receiving:packing_manage'}, {receivingBatchId:batch.receiving_batch_id,expectedVersion:batch.version,expectedPackingRevisionId:null,packingQuantity:1},randomUUID());
  expect(await pending(mother)).toHaveLength(1);const packed=await repo.buildOne(scope);expect(packed.model.quantities!.lines[0]!.packed).toBe(1);
 }));
 it('publishes a new default without rewriting existing frozen native plans',async()=>{
  const order=await run(()=>f.bulkReady('无')),scope={kind:'order' as const,id:order.id},before=await repo.buildOne(scope);
  const snapshots=(await f.db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[order.id])).rows;
  const db=await f.db.connect();try{await db.query('BEGIN');const current=(await new SlaConfigurationRepository(db).current())!,values=structuredClone(current.values);
   values.warning_ratio={kind:'ratio',percent:75};await new SlaConfigurationService().publishNewStandard(db,f.root,{expectedVersion:current.version,values,reason:'TEST new defaults only',requestKey:randomUUID()});await db.query('COMMIT');
  }finally{await db.query('ROLLBACK');db.release();}
  expect((await f.db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[order.id])).rows).toEqual(snapshots);
  expect((await repo.buildOne(scope)).model.sla.plan).toEqual(before.model.sla.plan);
 });
 it('builds scenario facts in the background without inheriting a request actor or wall clock',async()=>{
  const historical=await f.scene('2026-09-01T00:00:00.000Z');
  const ready=await f.runtime.run(historical,f.root,()=>f.bulkReady('无'));
  const scope={kind:'order' as const,id:ready.id};
  const expected=await f.runtime.run(historical,f.root,()=>repo.buildOne(scope));
  // This is a technical explicit rebuild request, not a fabricated business event.
  await f.db.query("INSERT INTO digital_journey_fact_changes(resource_kind,resource_id) VALUES('order',$1)",[scope.id]);
  const result=await new JourneyFactUpdates(f.db,repo).runOnce();expect(result.failed).toBe(0);
  const actual=(await f.db.query('SELECT clock_scenario_id,clock_revision,observed_at,source_fingerprint FROM digital_journey_fact_models WHERE resource_id=$1',[scope.id])).rows[0]!;
  expect(actual.clock_scenario_id).toBe(historical);expect(actual.clock_revision).toBe('1');expect(actual.observed_at.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  expect(actual.source_fingerprint).toBe(expected.sourceFingerprint);expect((await status(scope.id)).status).toBe('ready');
 });
 it('registers native assignee role revocation without changing frozen plan inputs',()=>run(async()=>{
  const order=await f.bulkReady('无'),scope={kind:'order' as const,id:order.id};const first=await repo.buildOne(scope);
  const person=(await f.db.query("SELECT assignee_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_pattern'",[order.id])).rows[0]!.assignee_id;
  await f.db.query("UPDATE app_users SET display_name=display_name||' TEST' WHERE id=$1",[person]);
  await f.db.query('UPDATE identity_mappings SET active=active,employed=employed,last_verified_at=CURRENT_TIMESTAMP WHERE user_id=$1',[person]);
  expect(await pending(order.id)).toHaveLength(0);expect((await status(order.id)).status).toBe('ready');
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='pattern_room_worker' AND revoked_at IS NULL",[person])).rows[0]!.assignment_id;
  await f.access.revokeRole({...f.root,authorizationCapability:'access:admin'},assignment,'TEST native eligibility revocation');
  expect(await pending(order.id)).toHaveLength(1);expect(await status(order.id)).toMatchObject({status:'pending',model:null});
  const updated=await repo.buildOne(scope);expect(updated.model.sla.plan).toEqual(first.model.sla.plan);
  // The model stores frozen plan inputs, never the mutable global defaults.
  expect(first.model.sla.plan).toBeTruthy();expect((await status(order.id)).status).toBe('ready');
 }));
 it('registers clock revisions and retires attached source aliases without deleting native facts',()=>run(async()=>{
  const order=await make(),source=await identity.createSource(f.root,{developmentType:'头版',designStyleNo:order.designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  await repo.buildOne({kind:'source',id:source.sourceId});await repo.buildOne({kind:'order',id:order.productionOrderId});
  await identity.attachSource(f.root,order.productionOrderId,source.sourceId,randomUUID());
  const retired=await repo.buildOne({kind:'source',id:source.sourceId},{retireMissing:true});expect(retired.retired).toBe(true);
  expect((await f.db.query('SELECT 1 FROM digital_production_sources WHERE source_id=$1',[source.sourceId])).rowCount).toBe(1);
  await repo.buildOne({kind:'order',id:order.productionOrderId});await f.advance(scene,'2026-11-08T01:00:00Z');
  expect(await pending(order.productionOrderId)).toHaveLength(1);expect(await status(order.productionOrderId)).toMatchObject({status:'pending',model:null});
 }));
 it('rechecks only the expired ordinary derived object without enqueuing normal compiled date transitions',()=>run(async()=>{
  const a=await make(),b=await make(),scopes=[a,b].map(order=>({kind:'order' as const,id:order.productionOrderId}));
  for(const scope of scopes)await repo.buildOne(scope);
  expect((await f.db.query('SELECT selection_expires_at FROM digital_journey_fact_models')).rows.every(row=>row.selection_expires_at===null)).toBe(true);
  // Deliberately stale derived observation, never a forged native business event.
  await f.db.query("UPDATE digital_journey_fact_models SET clock_scenario_id=NULL,clock_revision=0,selection_expires_at=clock_timestamp()-interval '1 second' WHERE resource_id=$1",[a.productionOrderId]);
  const spy=vi.spyOn(repo,'buildOne'),result=await new JourneyFactUpdates(f.db,repo).runOnce();
  expect(result).toEqual({built:1,retired:0,failed:0,busy:0});expect(spy.mock.calls.map(call=>call[0].id)).toEqual([a.productionOrderId]);
  expect(await pending(a.productionOrderId)).toHaveLength(0);expect(await pending(b.productionOrderId)).toHaveLength(0);
  expect((await status(b.productionOrderId)).status).toBe('ready');
 }));
 it('bounds explicit startup backfill and performs no payload construction during registration',()=>run(async()=>{
  const a=await make(),b=await make();await repo.buildOne({kind:'order',id:a.productionOrderId});await repo.buildOne({kind:'order',id:b.productionOrderId});
  await f.db.query("UPDATE digital_journey_fact_models SET calculation_version='TEST-old' WHERE resource_id=ANY($1::uuid[])",[[a.productionOrderId,b.productionOrderId]]);
  const spy=vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient'),updates=new JourneyFactUpdates(f.db,repo),first=await updates.registerBackfill(null,1);
  expect(first.registered).toBe(1);expect(first.done).toBe(false);expect(spy).not.toHaveBeenCalled();
  expect((await updates.registerBackfill(first.cursor,1)).registered).toBe(1);
  expect(spy).not.toHaveBeenCalled();expect(await pending(a.productionOrderId)).toHaveLength(1);expect(await pending(b.productionOrderId)).toHaveLength(1);
  expect((await f.db.query('SELECT DISTINCT reason FROM digital_journey_fact_changes')).rows).toEqual([{reason:'backfill'}]);
  // Priority applies at bounded dispatch. Two builders can acquire connections
  // and reach their inner projection in either order; that is not queue order.
  const dispatch=vi.spyOn(repo,'buildOne'),current=await make();await updates.runOnce();
  expect(dispatch.mock.calls[0]![0].id).toBe(current.productionOrderId);expect(spy).toHaveBeenCalled();
  expect((await updates.registerBackfill(null,1,true)).registered).toBe(1);
 }));
});
