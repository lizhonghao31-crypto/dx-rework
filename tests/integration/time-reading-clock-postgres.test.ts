import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {DigitalAnalysisQuery} from '../../apps/api/src/production-platform/reporting-query.js';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
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
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {installAcceptanceClockReader} from '../../apps/api/src/acceptance-clock/business-time.js';
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
 const makeSource=async(prefix='TEST-READ',materialId?:string)=>{
  const designer=f.people['sample-designer']!,identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true);
  const id=(await identity.createSource(designer,{developmentType:'头版',designStyleNo:`${prefix}-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;
  const materials=materialId?[{materialId,category:'主布',label:'主布',name:'棉',supplier:'TEST',width:'',weight:'',composition:'',consumption:'',color:'黑',specification:'TEST40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}]:[];
  const file=await f.image(designer),document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST original',craft:'无',washing:'免洗',materials,files:[{attachmentId:file,kind:'款图'}]});
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
 },testExecutionConfig.correctnessTimeoutMs);
 it('retains own clocks across an authorized mixed-scene list, board previews and role scope without ALS',async()=>{
  const query=new DigitalJourneyQuery(f.db),rows=await query.list(f.root,JourneyFilterSchema.parse({search:'TEST-READ-'}),true);
  expect(rows.total).toBe(4);for(const source of sources){const row=rows.items.find(item=>item.sourceId===source.id)!;expect(row).toBeDefined();if(source.mode!=='ordinary')expect(row.asOf).toBe(source.at);else expect(Math.abs(Date.parse(row.asOf!)-Date.now())).toBeLessThan(60000);}
  expect(Math.abs(Date.parse(rows.asOf)-Date.now())).toBeLessThan(60000);
  const board=await new DevelopmentWorkspaceQuery(query).pattern(f.root,{business:'all',scope:'all',state:'all',page:1,search:'TEST-READ-'});
  for(const task of [...board.items,...board.boardPreview??[],...board.risks??[]]){const original=rows.items.find(row=>row.sourceId===task.sourceId)!;if(sources.find(s=>s.id===task.sourceId)?.mode==='ordinary')expect(Math.abs(Date.parse(task.asOf!)-Date.now())).toBeLessThan(60000);else expect(task.asOf).toBe(original.asOf);}
  expect(board.items.length).toBeGreaterThan(0);
 },testExecutionConfig.correctnessTimeoutMs);
 it('analysis filters, KPIs and export keep real report audit but use each authorized original task clock',async()=>{
  const service=new DigitalAnalysisQuery(f.db),filters=DigitalAnalysisFilterSchema.parse({from:'2026-01-01',to:'2027-12-31',scope:'snapshot',node:'development_materials'});
  const rows=await service.list(f.root,filters);expect(rows.total).toBe(4);expect(Math.abs(Date.parse(rows.asOf)-Date.now())).toBeLessThan(60000);
  for(const row of rows.rows){const source=sources.find(s=>s.id===row.sourceId)!;expect(row.businessTime).toBeDefined();if(source.mode!=='ordinary'){expect(row.businessTime?.now).toBe(source.at);expect(row.registrationDelaySeconds).toBeNull();}else expect(Math.abs(Date.parse(row.businessTime!.now)-Date.now())).toBeLessThan(60000);}
  expect((await service.list(f.root,{...filters,metric:'overdue'})).total).toBe(0);expect(rows.overview?.snapshot.overdue).toBe(0);
  const workbook=await service.export(f.root,filters);expect(workbook.toString('utf8')).toContain('业务观察时刻');for(const source of sources.filter(s=>s.mode!=='ordinary'))expect(workbook.toString('utf8')).toContain(source.at);
  const audit=(await f.db.query("SELECT created_at FROM audit_events WHERE action='digital.analysis.exported' ORDER BY created_at DESC LIMIT 1")).rows[0];expect(Math.abs(audit.created_at.getTime()-Date.now())).toBeLessThan(60000);
  await expect(service.list(f.people['worker-b']!,filters)).rejects.toMatchObject({statusCode:403});expect((await service.list(f.people['pattern-room-worker']!,filters)).total).toBe(0);
 },testExecutionConfig.correctnessTimeoutMs);
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

 },testExecutionConfig.correctnessTimeoutMs);
 it('keeps historical SLA presence aligned with the exact adopted duration without restarting task clocks',async()=>{
  const id=await makeSource('TEST-HISTORY'),tasks=new DigitalProductionTaskService(f.db);
  const original=(await f.db.query(`SELECT r.*,p.sla_seconds AS legacy_seconds FROM digital_production_tasks t
   JOIN digital_production_task_access a USING(task_id) JOIN digital_production_deadline_revisions r USING(task_id)
   JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version
   WHERE a.source_id=$1 AND a.task_kind='development_materials' ORDER BY r.revision_id DESC LIMIT 1`,[id])).rows[0];
  expect(Number(original.legacy_seconds)).toBeGreaterThan(0);
  const cases=[{basis:null,mode:'duration',hours:Number(original.legacy_seconds)/3600,hasSla:true},
   {basis:{seconds:3600,enteredAt:null,basis:['TEST historical adopted duration']},mode:'duration',hours:1,hasSla:true},
   {basis:{seconds:null,enteredAt:null,basis:['TEST historical explicitly unlimited']},mode:'duration',hours:null,hasSla:false},
   {basis:{seconds:0,enteredAt:null,basis:['TEST explicit zero-duration event']},mode:'duration',hours:0,hasSla:true}];
  for(const item of cases){
   // A declared historical read fixture, not a new real occurrence or a
   // company-policy change. No actual task/event/PO facts are overwritten.
   await f.db.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by,sla_basis,deadline_kind)
    VALUES($1,$2,$3,NULL,NULL,NULL,'correction',$4,$5,$6,$7)`,[original.task_id,original.policy_node_key,original.policy_version,original.event_id,f.root.actorId,item.basis?JSON.stringify(item.basis):null,item.mode]);
   const snapshot=async()=>JSON.stringify({tasks:(await f.db.query('SELECT to_jsonb(t) AS row FROM digital_production_tasks t WHERE task_id=$1',[original.task_id])).rows,events:(await f.db.query('SELECT to_jsonb(e) AS row FROM digital_production_task_events e WHERE task_id=$1 ORDER BY recorded_at,event_id',[original.task_id])).rows,revisions:(await f.db.query('SELECT to_jsonb(r) AS row FROM digital_production_deadline_revisions r WHERE task_id=$1 ORDER BY revision_id',[original.task_id])).rows});
   const before=await snapshot(),read=await tasks.read(f.root,original.task_id),history=await tasks.history(f.root,original.task_id);
   expect(read.slaHours).toBe(item.hours);expect(history.revisions.at(-1)).toMatchObject({hasSla:item.hasSla,deadlineMode:item.mode});
   expect(await snapshot()).toBe(before);
  }
  await expect(tasks.history(f.people['worker-b']!,original.task_id)).rejects.toMatchObject({statusCode:404});
 },testExecutionConfig.correctnessTimeoutMs);
 it('reads at full pool capacity without ALS or nested borrowing and preserves scope checks',async()=>{
  const source=sources.find(s=>s.mode==='future')!,query=new DigitalJourneyQuery(f.db);
  const results=await Promise.all(Array.from({length:10},()=>query.read(f.root,source.id,undefined,true)));expect(results).toHaveLength(10);for(const row of results)expect(row.asOf).toBe(source.at);
  const analysis=await Promise.all(Array.from({length:10},()=>new DigitalAnalysisQuery(f.db).list(f.root,DigitalAnalysisFilterSchema.parse({from:'2026-01-01',to:'2027-12-31',scope:'snapshot'}))));expect(analysis).toHaveLength(10);
  const other=sources.find(s=>s.mode==='past')!;const scene=(await f.db.query("SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=$1",[source.id])).rows[0]?.scenario_id;
  if(!scene)throw Error('TEST original scope binding missing');
  await expect(f.runtime.run(scene,f.root,()=>query.read(f.root,other.id,undefined,true))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
 },testExecutionConfig.correctnessTimeoutMs);
 it('detects a no-ALS clock advance after snapshot COMMIT without holding a pool connection for the fresh check',async()=>{
  const source=sources.find(s=>s.mode==='future')!,scenario=(await f.db.query("SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=$1",[source.id])).rows[0].scenario_id;
  for(const reader of ['journey','analysis'] as const){
  const connect=f.db.connect.bind(f.db) as (...args:unknown[])=>unknown;let advanced=false;
  const spy=vi.spyOn(f.db,'connect').mockImplementation(((...args:unknown[])=>{
   const opened=connect(...args);if(args.length)return opened;
   return (opened as Promise<PoolClient>).then(client=>new Proxy(client,{get(target,key){
    if(key==='query')return (...queryArgs:unknown[])=>{
     const result=Reflect.apply(target.query,target,queryArgs);
     if(queryArgs[0]==='COMMIT'&&!advanced){advanced=true;return (result as Promise<unknown>).then(async value=>{await f.advance(scenario,new Date(Date.parse(source.at)+(reader==='journey'?1:2)).toISOString());return value;});}
     return result;
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }}));
  }) as Pool['connect']);
  try{await expect(reader==='journey'?new DigitalJourneyQuery(f.db).read(f.root,source.id,undefined,true):new DigitalAnalysisQuery(f.db).list(f.root,DigitalAnalysisFilterSchema.parse({from:'2026-01-01',to:'2027-12-31',scope:'snapshot'}))).rejects.toMatchObject({code:'CONFLICT',statusCode:409});expect(advanced).toBe(true);}finally{spy.mockRestore();}
  }
 },testExecutionConfig.correctnessTimeoutMs);

 it('summary and detail keep identical duration dueAt boundaries in lists, risks and KPI filters',async()=>{
  const scene=await f.scene('2026-10-20T09:00:00.000Z'),id=await f.runtime.run(scene,f.root,makeSource),row=(await f.db.query("SELECT t.task_id,t.node_key,r.due_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true WHERE a.source_id=$1 AND a.task_kind='development_materials'",[id])).rows[0];
  const style=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[id])).rows[0].design_style_no;
  const query=new DigitalJourneyQuery(f.db),workspace=new DevelopmentWorkspaceQuery(query),service=new DigitalProductionTaskService(f.db);
  for(const offset of [-1,0,1]){
   await f.advance(scene,new Date(row.due_at.getTime()+offset).toISOString());
   const task=await service.read(f.root,row.task_id),detail=await query.read(f.root,id),node=detail.stages.flatMap(s=>s.nodes).find(n=>n.instanceId===row.task_id)!;
   expect(task.deadlineExclusive).toBe(false);expect(node.risks.includes('overdue')).toBe(offset>0);
   const board=await workspace.pattern(f.root,{business:'all',scope:'all',state:'all',page:1,search:style,group:'materials'});
   expect(board.items.find(t=>t.node.instanceId===row.task_id)!.node.risks.includes('overdue')).toBe(offset>0);expect(board.riskCounts.materials.overdue).toBe(offset>0?1:0);
   const hits=await query.list(f.root,JourneyFilterSchema.parse({search:style,node:'development_materials',risk:'overdue',kpi:'overdue'}),true);expect(hits.total).toBe(offset>0?1:0);
  }
 },testExecutionConfig.correctnessTimeoutMs);

 it('analysis date-target filters honor the exclusive Beijing date end without requiring a fake duration start',async()=>{
  const scene=await f.scene('2026-10-20T09:00:00.000Z'),order=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));
  const raw=(await f.db.query("SELECT t.task_id,r.due_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true WHERE a.production_order_id=$1 AND a.task_kind='bulk_ship_sample'",[order.id])).rows[0];
  const service=new DigitalAnalysisQuery(f.db),filters=DigitalAnalysisFilterSchema.parse({from:'2026-01-01',to:'2027-12-31',scope:'snapshot',node:'bulk_ship_sample',metric:'overdue'});
  for(const offset of [-1,0,1]){await f.advance(scene,new Date(raw.due_at.getTime()+offset).toISOString());const result=await service.list(f.root,filters),row=result.rows.find(r=>r.taskId===raw.task_id);expect(Boolean(row)).toBe(offset>=0);if(row){expect(row.enteredAt).toBeNull();expect(row.deadlineMode).toBe('date_target');expect(row.missingTime).toBe(false);expect(row.slaIncluded).toBe(false);}}
 },testExecutionConfig.correctnessTimeoutMs);

 it('two consecutive native reworks retain the selected round historical fields and attachment at its closing event',async()=>{
  const scene=await f.scene('2026-10-20T09:00:00.000Z'),service=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true}),run=<T>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
  const category=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled AND amount IS NOT NULL LIMIT 1")).rows[0],file=await f.image(f.root);
  let order=await run(()=>createHistoricalPatternFixture(service,f.root,{styleNo:'TEST repeated rework history',categoryId:category.price_id,priceVersion:category.version,quantity:1,attachmentIds:[file],note:'TEST original historical facts'},randomUUID()));
  order=await run(()=>service.assign(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,personId:workerPerson},randomUUID()));
  order=await run(()=>service.complete(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId},randomUUID()));
  order=await run(()=>service.requestRework(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,reason:'TEST first rework',reasonCategory:'workmanship',attachmentIds:[]},randomUUID()));
  const selectedRound=order.currentRoundId;
  order=await run(()=>service.assign(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,personId:workerPerson,amount:'1'},randomUUID()));
  order=await run(()=>service.complete(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId},randomUUID()));
  order=await run(()=>service.requestRework(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,reason:'TEST second rework',reasonCategory:'workmanship',attachmentIds:[]},randomUUID()));
  const history=await service.get(f.root,order.orderId,{round:selectedRound,node:'pending_confirmation'});
  expect(history.historicalView?.missingFacts).toBe(false);expect(history.historicalView?.terminalEventId).toBeTruthy();expect(history.styleNo).toBe('TEST repeated rework history');expect(history.attachments.map(a=>a.attachmentId)).toEqual([file]);expect(history.rounds[0]!.segments).toHaveLength(1);expect(Object.values(history.actions).every(v=>!v)).toBe(true);
 },testExecutionConfig.correctnessTimeoutMs);

 it('native blocked waiting and derived totals/export stop at its own business observation and actual unblock',async()=>{
  const scene=await f.scene('2026-10-20T09:00:00.000Z'),source=await f.runtime.run(scene,f.root,makeSource),id=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_materials'",[source])).rows[0].task_id;
  const tasks=new DigitalProductionTaskService(f.db),analysis=new DigitalAnalysisQuery(f.db),filters=DigitalAnalysisFilterSchema.parse({from:'2026-01-01',to:'2027-12-31',scope:'snapshot',node:'development_materials',metric:'waiting'});
  await f.runtime.run(scene,f.root,()=>tasks.feedback(f.root,id,'TEST actual blocked wait',true,randomUUID()));await f.advance(scene,'2026-10-20T10:00:00.000Z');
  const first=await analysis.list(f.root,filters),row=first.rows.find(r=>r.taskId===id)!;expect(row.waitingSeconds).toBe(3600);expect(first.summary.waitingSeconds).toBe(3600);expect(row.registrationDelaySeconds).toBeNull();
  const block=row.events.find(e=>e.kind==='blocked')!;expect(block.at).toBe('2026-10-20T09:00:00.000Z');expect(Math.abs(Date.parse(block.recordedAt)-Date.now())).toBeLessThan(60000);
  const workbook=await analysis.export(f.root,filters);expect(workbook.toString('utf8')).toContain('<v>3600</v>');
  await f.runtime.run(scene,f.root,()=>tasks.feedback(f.root,id,'TEST actual wait ended',false,randomUUID()));await f.advance(scene,'2026-10-20T10:30:00.000Z');
  expect((await analysis.list(f.root,filters)).rows.find(r=>r.taskId===id)?.waitingSeconds).toBe(3600);
 },testExecutionConfig.correctnessTimeoutMs);

 it('counts actual native material completion only at and after A in detail and authorized list',async()=>{
  const scopeStart='2026-12-10T00:00:00.000Z',actual='2026-12-10T04:00:00.000Z',scene=await f.scene(scopeStart),materialId=randomUUID();
  const id=await f.runtime.run(scene,f.root,()=>makeSource('TEST-OBSERVED-COMPLETION',materialId));
  const execution=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!;
  let taskId:string|undefined;
  await f.advance(scene,actual);
  await f.runtime.run(scene,f.root,async()=>{
   const view=await execution.read(clerk,id),verification=view.materialVerification!,checks={materialId,physical:true,quantity:true,color:true,specification:true};
   taskId=view.tasks.find(task=>task.taskKind==='development_materials')!.taskId;
   await execution.saveMaterials(clerk,id,{taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:[{...checks,usage:'use',note:'',confirmedWith:''}]},randomUUID());
   await execution.check(clerk,id,{taskId,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST 实物核配',items:[checks]},randomUUID());
  });
  const snapshot=async()=>JSON.stringify((await f.db.query('SELECT state,completed_at,completed_quality FROM digital_production_tasks WHERE task_id=$1',[taskId])).rows);
  const original=await snapshot();expect(JSON.parse(original)).toEqual([{state:'completed',completed_at:actual,completed_quality:'现场登记'}]);
  // Read the same persisted action at three observations. The isolated clock
  // reader controls observations only, without rewinding the native scene.
  const readPool={connect:f.db.connect.bind(f.db),query:f.db.query.bind(f.db)} as unknown as Pool;
  let observed='';
  installAcceptanceClockReader(readPool,{read:async scope=>scope.id===id?{now:observed,scenarioId:scene,revision:2}:null,nativeScenario:async()=>null});
  const query=new DigitalJourneyQuery(readPool),repository=new JourneyFactRepository(readPool),resource={kind:'source' as const,id};
  for(const [at,count] of [['2026-12-10T03:00:00.000Z',0],[actual,1],['2026-12-10T05:00:00.000Z',1]] as const){
   observed=at;
   const native=await query.read(f.root,id,undefined,true);
   const task=native.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===taskId)!;
   expect(task.state).toBe('completed');
   expect(native.supervision!.nodes.find(timing=>timing.id===`development_materials:task:${taskId}`)).toMatchObject({actualEnd:count?actual:null});
   const style=native.designStyleNo;
   const indexed=(await repository.buildOne(resource)).model.requirements.find(row=>row.key==='development_materials');
   expect(indexed?.completed).toBe(Boolean(count));
   if(!count){const cached=(await f.db.query('SELECT selection_expires_at FROM digital_journey_fact_models WHERE resource_kind=\'source\' AND resource_id=$1',[id])).rows[0];expect(cached.selection_expires_at.toISOString()).toBe(actual);}
   const items=await query.list(f.root,JourneyFilterSchema.parse({search:style,scope:'development'}),true);
   expect(items.items.map(item=>item.sourceId)).toEqual([id]);
   for(const view of [native,items.items[0]!]){
    expect(view.asOf).toBe(at);
    expect(view.businessProgress!.requirements.find(row=>row.id==='development_materials:whole')).toMatchObject({applicability:'applicable',completed:Boolean(count),instanceIds:[taskId]});
    expect(view.visualProgress!.stages.find(row=>row.key==='development')?.completed).toBe(count*2);
    expect(view.display!.stages.find(row=>row.key==='development')!.completed).toBe(count*2);
   }
  }
  expect(await snapshot()).toBe(original);
 },testExecutionConfig.correctnessTimeoutMs);
});
