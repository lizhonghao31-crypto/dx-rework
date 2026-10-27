import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DevelopmentWorkspaceQuery} from '../../apps/api/src/production-platform/development-workspace-query.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {createHistoricalPatternFixture} from '../helpers/historical-pattern-fixture.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('authorized time reads, original event history and mixed scenario projections',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 let workerPerson:string;
 const sources:Array<{id:string;at:string;mode:string}>=[];
 beforeAll(async()=>{f=await businessAnchorFixture(url!);workerPerson=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[f.people['pattern-room-worker']!.actorId])).rows[0].person_id;},120000);
 afterAll(async()=>{await f?.dispose();});
 const makeSource=async()=>{
  const designer=f.people['sample-designer']!,identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true);
  const id=(await identity.createSource(designer,{developmentType:'头版',designStyleNo:`TEST-READ-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;
  const file=await f.image(designer),document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST original',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:file,kind:'款图'}]});
  const draft=await forms.save(designer,id,{expectedVersion:0,document},randomUUID());await forms.publish(designer,id,draft.version,randomUUID());return id;
 };
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: native historical fields and attachments use the original terminal audit event, not business cutoff`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const run=<T>(action:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,action):action();
  const id=await run(makeSource);sources.push({id,at,mode});
  const service=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
  const category=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled AND amount IS NOT NULL LIMIT 1")).rows[0];
  const old=await f.image(f.root),next=await f.image(f.root);
  // The private assembler preserves original legacy orders without reopening the closed public create route.
  let order=await run(()=>createHistoricalPatternFixture(service,f.root,{styleNo:'TEST original history',categoryId:category.price_id,priceVersion:category.version,quantity:1,attachmentIds:[old],note:'TEST initial'},randomUUID()));
  order=await run(()=>service.assign(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,personId:workerPerson},randomUUID()));
  const submittedVersion=order.version;
  order=await run(()=>service.updateMaterials(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,styleNo:'TEST later history',attachmentIds:[next],note:'TEST later',reason:'TEST edit'},randomUUID()));
  const saved=await service.get(f.root,order.orderId,{node:'pending_assignment'});
  expect(saved.styleNo).toBe('TEST original history');expect(saved.note).toBe('TEST initial');expect(saved.attachments.map(file=>file.attachmentId)).toEqual([old]);
  expect(saved.historicalView).toMatchObject({missingFacts:false});expect(saved.historicalView?.terminalEventId).toBeTruthy();expect(saved.rounds[0]!.completedAt).toBeNull();expect(saved.rounds[0]!.segments.every(s=>!s.wageEligible)).toBe(true);
  expect(Object.values(saved.actions).every(value=>!value)).toBe(true);expect((await service.get(f.root,order.orderId)).version).toBeGreaterThan(submittedVersion);
  const audits=(await f.db.query("SELECT created_at,after_state FROM operation_events WHERE entity_type='pattern_room_order' AND entity_id=$1 ORDER BY created_at",[order.orderId])).rows;
  expect(audits.length).toBeGreaterThanOrEqual(3);for(const event of audits)expect(Math.abs(event.created_at.getTime()-Date.now())).toBeLessThan(60000);
  if(scene)expect(saved.historicalView!.at).toBe(at);
  await expect(service.get(f.people['worker-b']!,order.orderId,{node:'pending_assignment'})).rejects.toMatchObject({statusCode:403});
 },60000);
 it('retains own clocks across an authorized mixed-scene list, board previews and role scope without ALS',async()=>{
  const query=new DigitalJourneyQuery(f.db),rows=await query.list(f.root,JourneyFilterSchema.parse({search:'TEST-READ-'}),true);
  expect(rows.total).toBe(4);for(const source of sources){const row=rows.items.find(item=>item.sourceId===source.id)!;expect(row).toBeDefined();if(source.mode!=='ordinary')expect(row.asOf).toBe(source.at);else expect(Math.abs(Date.parse(row.asOf!)-Date.now())).toBeLessThan(60000);}
  expect(Math.abs(Date.parse(rows.asOf)-Date.now())).toBeLessThan(60000);
  const board=await new DevelopmentWorkspaceQuery(query).pattern(f.root,{business:'all',scope:'all',state:'all',page:1,search:'TEST-READ-'});
  for(const task of [...board.items,...board.boardPreview??[],...board.risks??[]]){const original=rows.items.find(row=>row.sourceId===task.sourceId)!;if(sources.find(s=>s.id===task.sourceId)?.mode==='ordinary')expect(Math.abs(Date.parse(task.asOf!)-Date.now())).toBeLessThan(60000);else expect(task.asOf).toBe(original.asOf);}
  expect(board.items.length).toBeGreaterThan(0);
 },60000);
 it('isolates an old bad native completion, retains good search results and leaves all original facts unchanged',async()=>{
  const bad=sources.find(s=>s.mode==='past')!,task=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_materials' AND t.route_version=1",[bad.id])).rows[0];
  // Synthetic historical poison, reproducing the former default-wall-time write. No trigger/guard is disabled.
  await f.db.query("UPDATE digital_production_tasks SET state='completed',completed_at=$2,completed_quality='现场登记' WHERE task_id=$1",[task.task_id,new Date(Date.parse(bad.at)+3600000).toISOString()]);
  const snapshot=async()=>JSON.stringify((await f.db.query("SELECT to_jsonb(t) AS value FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY task_id",[bad.id])).rows);
  const before=await snapshot(),query=new DigitalJourneyQuery(f.db),single=await query.read(f.root,bad.id,undefined,true),list=await query.list(f.root,JourneyFilterSchema.parse({scope:'development',search:'TEST-READ-'}),true);
  expect(single.supervision?.assessment).toBe('partially_unavailable');expect(single.supervision?.coverage.some(c=>c.key==='fact_time')).toBe(true);expect(single.supervision?.requestId).toBe(f.root.requestId);
  expect(list.total).toBe(4);expect(list.items.some(item=>item.sourceId===bad.id)).toBe(true);expect(list.supervision?.coverage.find(c=>c.key==='fact_time')?.orders).toBe(1);
  const filtered=await query.list(f.root,JourneyFilterSchema.parse({scope:'development',search:'TEST-READ-',missing:'fact_time'}),true);expect(filtered.total).toBe(1);expect(filtered.items[0]?.sourceId).toBe(bad.id);
  expect(await snapshot()).toBe(before);
  const scenario=(await f.db.query("SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=$1",[bad.id])).rows[0].scenario_id;
  const identity=new DigitalProductionIdentityService(f.db,true),style=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[bad.id])).rows[0].design_style_no;
  const order=await f.runtime.run(scenario,f.root,()=>identity.createOrder(f.people['sample-designer']!,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:beijingCalendarDate(new Date(bad.at)),primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:style,color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),bad.id));
  const ship=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='bulk_ship_sample'",[order.productionOrderId])).rows[0];
  const taskService=new DigitalProductionTaskService(f.db),shipTask=await taskService.read(f.root,ship.task_id),history=await taskService.history(f.root,ship.task_id);
  expect(shipTask).toMatchObject({deadlineMode:'date_target',deadlineExclusive:true,slaHours:null,enteredAt:null});expect(shipTask.dueAt).toBeTruthy();expect(history.revisions.at(-1)).toMatchObject({deadlineMode:'date_target',hasSla:true});
  const sla=new SlaOrderService(f.db),read=await sla.read(f.root,order.productionOrderId);expect(read.status).toBe('planned');if(read.status==='planned')expect(read.nodes.some(n=>n.assessmentIssue)).toBe(true);
  const client=await f.db.connect();try{await client.query('BEGIN');await expect(sla.readWithClient(f.root,order.productionOrderId,client)).rejects.toThrow('Actual SLA event cannot be in the future');await client.query('ROLLBACK');}finally{client.release();}
  const clients=await Promise.all(Array.from({length:10},()=>f.db.connect()));try{const reads=await Promise.all(clients.map(db=>sla.readWithClient(f.root,order.productionOrderId,db,{mode:'read_projection'})));expect(reads.every(r=>r.time.scenarioId===scenario)).toBe(true);}finally{for(const db of clients)db.release();}

 },60000);
 it('reads at full pool capacity without ALS or nested borrowing and preserves scope checks',async()=>{
  const source=sources.find(s=>s.mode==='future')!,query=new DigitalJourneyQuery(f.db);
  const results=await Promise.all(Array.from({length:10},()=>query.read(f.root,source.id,undefined,true)));expect(results).toHaveLength(10);for(const row of results)expect(row.asOf).toBe(source.at);
  const other=sources.find(s=>s.mode==='past')!;const scene=(await f.db.query("SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=$1",[source.id])).rows[0]?.scenario_id;
  if(!scene)throw Error('TEST original scope binding missing');
  await expect(f.runtime.run(scene,f.root,()=>query.read(f.root,other.id,undefined,true))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
 },60000);
 it('detects a no-ALS clock advance after snapshot COMMIT without holding a pool connection for the fresh check',async()=>{
  const source=sources.find(s=>s.mode==='future')!,scenario=(await f.db.query("SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=$1",[source.id])).rows[0].scenario_id;
  const connect=f.db.connect.bind(f.db) as (...args:unknown[])=>unknown;let advanced=false;
  const spy=vi.spyOn(f.db,'connect').mockImplementation(((...args:unknown[])=>{
   const opened=connect(...args);if(args.length)return opened;
   return (opened as Promise<PoolClient>).then(client=>new Proxy(client,{get(target,key){
    if(key==='query')return (...queryArgs:unknown[])=>{
     const result=Reflect.apply(target.query,target,queryArgs);
     if(queryArgs[0]==='COMMIT'&&!advanced){advanced=true;return (result as Promise<unknown>).then(async value=>{await f.advance(scenario,new Date(Date.parse(source.at)+1).toISOString());return value;});}
     return result;
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }}));
  }) as Pool['connect']);
  try{await expect(new DigitalJourneyQuery(f.db).read(f.root,source.id,undefined,true)).rejects.toMatchObject({code:'CONFLICT',statusCode:409});expect(advanced).toBe(true);}finally{spy.mockRestore();}
 },60000);

});
