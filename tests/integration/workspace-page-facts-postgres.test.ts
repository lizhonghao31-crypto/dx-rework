import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DevelopmentWorkspaceQuery} from '../../apps/api/src/production-platform/development-workspace-query.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {DevelopmentWorkspaceFilterSchema,PatternWorkspaceFilterSchema} from '@dx-rework/contracts/digital-development-workspace';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PERF07 native page-selected workspace reads',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string,repo:JourneyFactRepository,legacy:DevelopmentWorkspaceQuery,indexed:DevelopmentWorkspaceQuery;
 const ids:string[]=[],run=<T,>(fn:()=>Promise<T>)=>f.runtime.run(scene,f.root,fn);
 const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,value)=>key==='asOf'?undefined:value));
 const difference=(a:unknown,b:unknown,path='result'):string|null=>{
  if(a===b)return null;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return path+': '+JSON.stringify(a)+' != '+JSON.stringify(b);
  const left=a as Record<string,unknown>,right=b as Record<string,unknown>,keys=[...new Set([...Object.keys(left),...Object.keys(right)])];
  for(const key of keys){if(!Object.hasOwn(left,key)||!Object.hasOwn(right,key))return path+'.'+key+': missing property';const diff=difference(left[key],right[key],path+'.'+key);if(diff)return diff;}return null;
 };

 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-08T00:00:00.000Z');repo=new JourneyFactRepository(f.db);
  legacy=new DevelopmentWorkspaceQuery(new DigitalJourneyQuery(f.db));indexed=new DevelopmentWorkspaceQuery(new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}));
  await run(async()=>{
   const identity=new DigitalProductionIdentityService(f.db,true),tasks=new DigitalProductionTaskService(f.db);
   for(let i=0;i<31;i++){
    const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-PERF07-'+String(i).padStart(2,'0'),temporaryStyleNo:null,customerCode:'PD'},randomUUID());ids.push(source.sourceId);
    if(i<3){const db=await f.db.connect();try{await db.query('BEGIN');await tasks.createWithClient(db,f.root,{resource:{kind:'source',id:source.sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:f.people['pattern-room-worker']!.actorId});await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
    if(i===4){const designer=f.people['sample-designer']!,forms=new DigitalDevelopmentService(f.db,true),document={...initialDevelopmentDocument(),quantity:1,sizes:['M'],sizeQuantities:[1],sampleSize:'M',orderDate:null,measurements:[],craft:'无' as const,washing:'免洗' as const,materials:[],files:[{attachmentId:await f.image(designer),kind:'款图' as const}]};const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document},randomUUID());await forms.publish(designer,source.sourceId,saved.version,randomUUID());}
    await repo.buildOne({kind:'source',id:source.sourceId});
   }
  });
 },testExecutionConfig.correctnessTimeoutMs);
 afterAll(async()=>{await f?.dispose();});
 it('keeps all31 designer totals and facets while enriching only the selected15',()=>run(async()=>{
  for(const page of [1,2,3]){
   const filter=DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PERF07-',page}),expected=await legacy.designer(f.root,filter),read=vi.spyOn(DigitalProductionTaskService.prototype,'read');
   let actual;try{actual=await indexed.designer(f.root,filter);expect(read.mock.calls.length).toBeLessThanOrEqual(actual.items.length*2);}finally{read.mockRestore();}
   expect(difference(normalize(actual),normalize(expected))).toBeNull();expect(actual.total).toBe(31);expect(actual.items.length).toBe(page===3?1:15);
  }
 }));
 it('preserves real native tasks, owner and lane filters without hydrating unrelated mothers',()=>run(async()=>{
  for(const actor of [f.root,f.people['pattern-room-worker']!])for(const patch of [{},{lane:'pattern' as const},{search:'TEST-PERF07-00'},{search:'not-found'}]){
   const filter=PatternWorkspaceFilterSchema.parse({scope:actor===f.root?'all':'mine',state:'all',...patch}),expected=await legacy.pattern(actor,filter),actual=await indexed.pattern(actor,filter);
   expect(difference(normalize(actual),normalize(expected))).toBeNull();
  }
 }));
 it('keeps available sources usable with unknown totals while one source updates, then recovers after that source rebuild',()=>run(async()=>{
  await f.db.query("INSERT INTO digital_journey_fact_changes(resource_kind,resource_id,reason) VALUES('source',$1,'backfill') ON CONFLICT DO NOTHING",[ids[0]]);
  const filter=DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PERF07-00'});
  expect(await indexed.designer(f.root,filter)).toMatchObject({total:null,counts:null,freshness:{pending:1,failed:0},items:[]});
  const available=await indexed.designer(f.root,DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PERF07-'}));expect(available.total).toBeNull();expect(available.items).toHaveLength(15);expect(available.items.some(item=>item.journey.id===ids[0])).toBe(false);
  const board=await indexed.pattern(f.root,PatternWorkspaceFilterSchema.parse({scope:'all',state:'all',group:'pattern'}));expect(board).toMatchObject({total:null,counts:null,freshness:{pending:1}});expect(board.items).toHaveLength(2);
  await repo.buildOne({kind:'source',id:ids[0]!});expect((await indexed.designer(f.root,filter)).total).toBe(1);
 }));
 it('keeps an authorized published root in designer business counts while its journey index is pending',()=>run(async()=>{
  const target=ids[4]!,resource={kind:'source' as const,id:target};
  const workbench=new DevelopmentWorkspaceQuery(new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),undefined,new ProductionReadinessService(f.db));
  const filter=DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PERF07-04',layout:'workbench',businessView:'pure'});
  const read=()=>workbench.designer(f.people['sample-designer']!,filter);
  const counts={pure:1,preorder:0,ordered:0,handover:0};
  expect(await read()).toMatchObject({businessCounts:counts,items:[{journey:{sourceId:target},business:{kind:'pure'}}]});
  await f.db.query("INSERT INTO digital_journey_fact_changes(resource_kind,resource_id,reason) VALUES('source',$1,'backfill') ON CONFLICT DO NOTHING",[target]);
  try{expect(await read()).toMatchObject({businessCounts:counts,freshness:{pending:1,failed:0},items:[]});}
  finally{await repo.buildOne(resource);}
  expect(await read()).toMatchObject({businessCounts:counts,items:[{journey:{sourceId:target},business:{kind:'pure'}}]});
 }));
 it('rolls back a single selected SQL failure and keeps other selected mothers available',()=>run(async()=>{
  const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),native=Reflect.get(query,'project') as (...args:unknown[])=>Promise<OrderJourney|null>;
  const project=vi.spyOn(query as unknown as {project:typeof native},'project').mockImplementation(async(...args)=>{
   const candidate=args[2] as {source?:{source_id:string}};
   if(candidate.source?.source_id===ids.at(-1))await(args[0] as PoolClient).query('SELECT 1/0');
   return native.apply(query,args);
  });
  try{const value=await new DevelopmentWorkspaceQuery(query).designer(f.root,DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PERF07-'}));
   expect(value.total).toBe(31);expect(value.counts).not.toBeNull();expect(value.freshness).toBeUndefined();expect(value.detailFailures).toEqual([{journeyId:ids.at(-1),designStyleNo:'TEST-PERF07-30'}]);expect(value.items).toHaveLength(14);expect(value.items.some(item=>item.journey.id===ids.at(-1))).toBe(false);
  }finally{project.mockRestore();}
 }));

 it('does not transfer unused node collections for an ordered designer row',()=>run(async()=>{
  const style='TEST-PERF07-ORDER-'+randomUUID(),created=await new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-08',lines:[{formalPoNo:'TEST-PO',color:'TEST黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:5}]}]}),randomUUID());
  await repo.buildOne({kind:'order',id:created.productionOrderId});
  const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'});
  expect(await query.workspace(f.root,JourneyFilterSchema.parse({search:style}),undefined,facts=>{
   expect(facts).toHaveLength(1);expect(facts[0]!.orderId).toBe(created.productionOrderId);expect(facts[0]!.nodes).toEqual([]);
   return {ids:[],finish:()=>true};
  })).toBe(true);
  const filter=DevelopmentWorkspaceFilterSchema.parse({search:style,view:'ordered'});expect(difference(normalize(await indexed.designer(f.root,filter)),normalize(await legacy.designer(f.root,filter)))).toBeNull();
 }));

 it('keeps reliable counts and page2 when one selected designer detail fails',()=>run(async()=>{
  const filter=DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PERF07-',page:2}),expected=await legacy.designer(f.root,filter),target=expected.items[0]!.journey.id;
  const nativeQuery=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),native=Reflect.get(nativeQuery,'project') as (...args:unknown[])=>Promise<OrderJourney|null>;
  const spy=vi.spyOn(nativeQuery as unknown as {project:typeof native},'project').mockImplementation(async(...args)=>{if((args[2] as {source?:{source_id:string}}).source?.source_id===target)await(args[0] as PoolClient).query('SELECT 1/0');return native.apply(nativeQuery,args);});
  try{const actual=await new DevelopmentWorkspaceQuery(nativeQuery).designer(f.root,filter);expect(actual).toMatchObject({page:2,total:expected.total,counts:expected.counts});expect(actual.freshness).toBeUndefined();expect(actual.detailFailures?.map(item=>item.journeyId)).toEqual([target]);expect(actual.items.map(item=>item.journey.id)).toEqual(expected.items.filter(item=>item.journey.id!==target).map(item=>item.journey.id));}finally{spy.mockRestore();}
 }));

 it('preserves the authorized workbench row identity and its exact selected position after native detail SQL fails',()=>run(async()=>{
  const nativeQuery=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),native=Reflect.get(nativeQuery,'project') as (...args:unknown[])=>Promise<OrderJourney|null>;
  const workbench=new DevelopmentWorkspaceQuery(nativeQuery,undefined,new ProductionReadinessService(f.db));
  const filter=DevelopmentWorkspaceFilterSchema.parse({layout:'workbench',businessView:'pure',search:'TEST-PERF07-04'}),target=ids[4]!;
  const before=await workbench.designer(f.root,filter);expect(before).toMatchObject({total:1,items:[{journey:{id:target}}]});
  const project=vi.spyOn(nativeQuery as unknown as {project:typeof native},'project').mockImplementation(async(...args)=>{
   if((args[2] as {source?:{source_id:string}}).source?.source_id===target)await(args[0] as PoolClient).query('SELECT 1/0');return native.apply(nativeQuery,args);
  });
  try{const read=await workbench.designer(f.root,filter);
   expect(read).toMatchObject({page:1,total:1,businessCounts:before.businessCounts,counts:before.counts,items:[],
    detailFailures:[{journeyId:target,designStyleNo:'TEST-PERF07-04'}],unavailableRows:[{position:0,journeyId:target,sourceId:target,orderId:null,designStyleNo:'TEST-PERF07-04',businessKind:'pure'}]});
   expect(read.freshness).toBeUndefined();expect(Object.keys(read.unavailableRows![0]!)).not.toContain('stages');
  }finally{project.mockRestore();}
  expect((await workbench.designer(f.root,filter)).items[0]?.journey.id).toBe(target);
 }));

 it('keeps reliable counts and page2 when one selected pattern detail fails',()=>run(async()=>{
  const tasks=new DigitalProductionTaskService(f.db);
  for(const sourceId of ids.slice(3,18)){const db=await f.db.connect();try{await db.query('BEGIN');await tasks.createWithClient(db,f.root,{resource:{kind:'source',id:sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:f.people['pattern-room-worker']!.actorId});await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}await repo.buildOne({kind:'source',id:sourceId});}
  const filter=PatternWorkspaceFilterSchema.parse({scope:'all',state:'all',group:'pattern',page:2}),expected=await legacy.pattern(f.root,filter),target=expected.items[0]!.journeyId;
  const nativeQuery=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),native=Reflect.get(nativeQuery,'project') as (...args:unknown[])=>Promise<OrderJourney|null>;
  const spy=vi.spyOn(nativeQuery as unknown as {project:typeof native},'project').mockImplementation(async(...args)=>{if((args[2] as {source?:{source_id:string}}).source?.source_id===target)await(args[0] as PoolClient).query('SELECT 1/0');return native.apply(nativeQuery,args);});
  try{const actual=await new DevelopmentWorkspaceQuery(nativeQuery).pattern(f.root,filter);expect(actual).toMatchObject({page:2,total:expected.total,counts:expected.counts,riskCounts:expected.riskCounts,archiveTotal:expected.archiveTotal});expect(actual.freshness).toBeUndefined();expect(actual.detailFailures?.map(item=>item.journeyId)).toEqual([target]);expect(actual.items.map(item=>item.node.instanceId)).toEqual(expected.items.filter(item=>item.journeyId!==target).map(item=>item.node.instanceId));}finally{spy.mockRestore();}
 }));

 it('requires an actual pure-development clock without poisoning a different authorized business category',async()=>{
  await prepareRewashSettings(f);
  return run(async()=>{
  const designer=f.people['sample-designer']!,style='TEST-PERF07-MANAGED-PURE',
   identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true);
  const {sourceId:target}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const document={...initialDevelopmentDocument(),quantity:1,sizes:['M'],sizeQuantities:[1],sampleSize:'M',orderDate:null,measurements:[],craft:'无' as const,washing:'免洗' as const,materials:[],files:[{attachmentId:await f.image(designer),kind:'款图' as const}]};
  const saved=await forms.save(designer,target,{expectedVersion:0,document},randomUUID());
  expect(await forms.publish(designer,target,saved.version,randomUUID())).toMatchObject({status:'published'});
  await repo.buildOne({kind:'source',id:target});
  const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),workbench=new DevelopmentWorkspaceQuery(query,undefined,new ProductionReadinessService(f.db));
  const pure=DevelopmentWorkspaceFilterSchema.parse({layout:'workbench',businessView:'pure',search:style});
  const ordered=DevelopmentWorkspaceFilterSchema.parse({layout:'workbench',businessView:'ordered',search:'TEST-PERF07-'});
  const before=await workbench.designer(f.root,ordered);expect(before.total).toBe(1);
  expect((await workbench.designer(f.root,pure)).total).toBe(1);
  const original=(await f.db.query('SELECT created_business_time FROM digital_order_time_subjects WHERE source_id=$1',[target])).rows[0]!.created_business_time;
  await f.db.query("UPDATE digital_order_time_subjects SET created_business_time='{}' WHERE source_id=$1",[target]);
  try{
   expect(await workbench.designer(f.root,pure)).toMatchObject({total:null,businessCounts:{pure:1},items:[],freshness:{failed:1}});
   const unaffected=await workbench.designer(f.root,ordered);expect(unaffected.total).toBe(before.total);
   expect(unaffected.items.map(row=>row.journey.id)).toEqual(before.items.map(row=>row.journey.id));expect(unaffected.freshness).toBeUndefined();
  }finally{await f.db.query('UPDATE digital_order_time_subjects SET created_business_time=$2 WHERE source_id=$1',[target,original]);}
  expect((await workbench.designer(f.root,pure)).total).toBe(1);
  });
 });

});
