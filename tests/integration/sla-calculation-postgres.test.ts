import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {SlaCalculationService} from '../../apps/api/src/production-platform/sla-calculation-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DevelopmentTechnicalSettingsService} from '../../apps/api/src/production-platform/development-technical-settings.js';
import {registerDigitalTaskRoutes} from '../../apps/api/src/production-platform/task-routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {DevelopmentDocumentSchema} from '../../packages/contracts/src/digital-development.js';
import {DigitalOrderCreateSchema} from '../../packages/contracts/src/digital-production.js';
import type {SlaCalculationConditions,SlaCalculationPreviewInput} from '../../packages/contracts/src/sla-calculation.js';
import {addCalculationMinutes} from '../../packages/domain/src/sla-calculation.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('M01 calculation native read-only service and original HTTP contracts',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,service:SlaCalculationService,identity:DigitalProductionIdentityService,forms:DigitalDevelopmentService,scene:string,sourceA:string,sourceB:string,orderId:string,pmc:TrustedActorContext,assignmentId:string;
 let createSource:(craft?:'无'|'印花'|'绣花'|'印绣花')=>Promise<string>;
 const app=Fastify(),conditions:SlaCalculationConditions={craft:'none',craftExecution:'internal',pattern:'internal',washing:'none',preshrink:'yes',preparation:'adopted',developmentMode:'normal',rework:'no'};
 const reference=(value='2026-11-02T00:00:00Z')=>({precision:'instant' as const,value,source:'TEST explicit example reference'});
 const example=(range:'development'|'preparation'|'bulk_craft'|'contract'='development'):SlaCalculationPreviewInput=>({selection:{mode:'example',range,conditions,references:{development_published:reference(),instruction_published:reference(),whole_fabric_arrived:reference(),cut_craft_dispatched:reference(),sourcing_decided:reference(),contract_pdf_ready:reference()}}});
 const instance=(id=sourceA):SlaCalculationPreviewInput=>({selection:{mode:'instance',range:'development',kind:'source',id}});
 const run=<T,>(fn:()=>Promise<T>)=>f.runtime.run(scene,f.root,fn);
 const count=async()=>Object.fromEntries(await Promise.all(['digital_sla_configurations','digital_sla_order_snapshots','digital_sla_plans','digital_development_sla_plans','digital_development_cycle_standards','digital_production_tasks','digital_production_task_events','digital_production_commands','digital_preparation_windows','audit_events','operation_events','rework_todos'].map(async table=>[table,Number((await f.db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)])));
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);service=new SlaCalculationService(f.db);identity=new DigitalProductionIdentityService(f.db,true);forms=new DigitalDevelopmentService(f.db,true);
  scene=await f.scene('2026-11-02T00:00:00Z');
  await run(async()=>{
   const designer=f.people['sample-designer']!;
   createSource=async(craft:'无'|'印花'|'绣花'|'印绣花'='无')=>{
    const created=await identity.createSource(designer,{developmentType:'头版',designStyleNo:`TEST-M01-CALC-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
    const image=await f.image(designer);
    const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['48']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST calculation native publication',craft,washing:'免洗',materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:image,kind:'款图'}]});
    const saved=await forms.save(designer,created.sourceId,{expectedVersion:0,document},randomUUID());await forms.publish(designer,created.sourceId,saved.version,randomUUID());return created.sourceId;
   };
   sourceA=await createSource();sourceB=await createSource();
   const row=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[sourceA])).rows[0];
   orderId=(await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:row.design_style_no,orderDate:'2026-11-02',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:`TEST-CALC-${randomUUID()}`,color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),sourceA)).productionOrderId;
  });
  const userId=randomUUID();await f.db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST dedicated calculation PMC',true)",[userId]);await f.db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','anchor-test',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),userId,`TEST-calc-${userId}`]);
  const root={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin','master_data:manage']};assignmentId=(await f.access.assignRole(root,{userId,roleCode:'pmc',reason:'TEST dedicated calculation role, no standard account changed'})).assignmentId;
  pmc={actorId:userId,actorRoles:['pmc'],authorizationCapability:'digital_production:tasks',authorizationCapabilities:['digital_production:tasks','digital_production:view'],requestId:randomUUID()};
  app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({error:{code:e.code,message:e.message}});});
  registerDigitalTaskRoutes(app,{service:identity,creationEnabled:true,root:new RootAuthority(f.db,'anchor-test','uat-root'),authenticate:async token=>{
   if(!token)throw new ApplicationError('UNAUTHORIZED','TEST 请登录',401);
   const rows=(await f.db.query('SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL',[token])).rows;
   if(!rows.length)throw new ApplicationError('NO_BUSINESS_ROLE','TEST 未分配岗位',403);
   const roles=rows.map(r=>r.role_code);return {id:token,displayName:'TEST calculation HTTP',businessRoles:roles,capabilities:['digital_production:view','digital_production:tasks']};
  }},new DigitalProductionTaskService(f.db));await app.ready();
 },120000);
 afterAll(async()=>{await app.close();await f?.dispose();});

 it('compares the new calendar with original PostgreSQL 0207 helper across Sunday, leap day, year and millisecond boundaries',async()=>{
  for(const start of ['2026-11-06T00:00:00+08:00','2026-11-06T10:00:00+08:00','2026-11-07T23:59:59.997+08:00','2026-11-08T00:00:00+08:00','2026-11-08T23:59:59.999+08:00','2026-11-09T00:00:00+08:00','2026-12-31T23:59:59.997+08:00','2028-02-29T10:00:00+08:00']){
   const expected=(await f.db.query('SELECT sourcing_contract_return_add_hours($1::timestamptz,48) AS at',[start])).rows[0].at.toISOString();expect(addCalculationMinutes(start,2880,'beijing_sunday_excluded')).toBe(expected);
  }
 });
 it('serves complete R1 as a read-only example with a distinct calculation receipt and stable digest',async()=>{
  const before=await count(),a=await service.preview(f.root,example()),b=await service.preview(f.root,example());expect(a.current.overall.spanMs).toBe(80.5*3600000);expect(a.contextDigest).toBe(b.contextDigest);expect(a.calculationReceipt.purpose).toBe('read_only_calculation');expect(a.calculationReceipt.resultDigest).toMatch(/^[0-9a-f]{64}$/);expect(await count()).toEqual(before);
 });
 it('R2-03: whole instance keeps every original fragment, frozen source and unknown wait in one read-only snapshot',async()=>run(async()=>{
  const before=await count(),input:SlaCalculationPreviewInput={selection:{mode:'instance',range:'whole',kind:'order',id:orderId}},result=await service.preview(f.root,input);
  expect(result.context.identity.orderId).toBe(orderId);expect(result.current.rangeLabel).toBe('适用全流程');expect(result.current.stages.map(s=>s.stage)).toEqual([1,2,3,4,5,6,7]);expect(result.current.overall.spanMs).toBeNull();expect(result.current.rows.some(n=>n.id.startsWith('development/'))).toBe(true);expect(result.current.rows.some(n=>n.id.startsWith('delivery/'))).toBe(true);expect(result.context.bindings.whole).toHaveProperty('preparation');expect(await count()).toEqual(before);
  await expect(service.preview(f.root,{selection:{mode:'instance',range:'whole',kind:'source',id:sourceA}})).rejects.toMatchObject({statusCode:400});expect(await count()).toEqual(before);
 }));
 it('R2-03: a legacy mother without a development source retains all other native ranges and never invents a development freeze',async()=>run(async()=>{
  const made=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-WHOLE-LEGACY-${randomUUID()}`,orderDate:'2026-11-02',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-LEGACY-PO',color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:1}]}]}),randomUUID()),before=await count();
  const result=await service.preview(f.root,{selection:{mode:'instance',range:'whole',kind:'order',id:made.productionOrderId}});
  expect(result.context.identity.sourceId).toBeNull();expect(result.context.bindings.whole).toMatchObject({development:{development:{status:'source_unavailable'}}});expect(result.current.stages.map(s=>s.stage)).toEqual([1,2,3,4,5,6,7]);expect(result.current.overall.spanMs).toBeNull();expect(result.current.rows.some(n=>n.id.startsWith('preparation/'))).toBe(true);expect(result.context.limitations.join(' ')).toContain('没有关联开发来源');expect(await count()).toEqual(before);
 }));
 it('recomputes R2 draft 60→48→48h on the server, keeping every tied determining path',async()=>{
  const first=await service.preview(f.root,example('preparation')),values=structuredClone(first.context.unified.values);values.warehouse_preshrink={kind:'duration',minutes:1440};
  const input={...example('preparation'),unified:{expectedVersion:first.context.unified.version,values}},equal=await service.preview(f.root,input);expect(equal.current.overall.spanMs).toBe(60*3600000);expect(equal.draft.overall.spanMs).toBe(48*3600000);expect(equal.draft.overall.determiningNodes).toContain('bulk_pattern');expect(equal.draft.overall.determiningNodes).toContain('warehouse_preshrink');
  values.warehouse_preshrink={kind:'duration',minutes:720};const last=await service.preview(f.root,input);expect(last.draft.overall.spanMs).toBe(48*3600000);expect(last.draft.overall.determiningNodes).toEqual(['bulk_pattern']);
 });
 it('reads native source/round/frozen inputs without assigning a missing-material wait zero hours',async()=>run(async()=>{
  const before=await count(),result=await service.preview(f.root,instance());expect(result.context.identity).toMatchObject({sourceId:sourceA,round:1});expect(result.context.graph.observationMode).toBe('instance');expect(result.context.bindings.development).toMatchObject({sourceId:sourceA,round:1});expect(result.current.overall.spanMs).toBeNull();expect(result.current.overall.missing.join(' ')).toContain('条件');expect(await count()).toEqual(before);
 }));
 it('A→B→A returns the correct exact source context and rejects another source round',async()=>run(async()=>{
  const a=await service.preview(f.root,instance(sourceA)),b=await service.preview(f.root,instance(sourceB)),again=await service.preview(f.root,instance(sourceA));expect(a.contextDigest).not.toBe(b.contextDigest);expect(again.contextDigest).toBe(a.contextDigest);expect(again.context.identity.sourceId).toBe(sourceA);expect(a.context.identity.orderId).toBe(orderId);expect(a.context.bindings.motherOrders).toEqual([{production_order_id:orderId,source_id:sourceA}]);expect(b.context.identity.orderId).toBeNull();
  await expect(service.preview(f.root,{selection:{...instance().selection,round:99}})).rejects.toMatchObject({statusCode:404});
 }));
 it.each([['绣花','development_embroidery',5760],['印绣花','development_print_embroidery',10080],['印花','development_printing',5760]] as const)('adapts native %s publication and original external paper requests without an unsupported whole route',(craft,key,minutes)=>run(async()=>{
  const sourceId=await createSource(craft),execution=new DevelopmentExecutionService(f.db,true);await execution.externalPattern(f.root,sourceId,{action:'request',roundNumber:1,note:'TEST original external paper request'},randomUUID());const before=await count(),result=await service.preview(f.root,instance(sourceId));expect(result.current.rows.find(n=>n.id===key)!.minutes).toBe(minutes);expect(result.current.rows.some(n=>n.id.startsWith('external-pattern:')&&n.independent)).toBe(true);expect(result.context.bindings.development).toMatchObject({sourceId,round:1});expect(result.context.limitations.join(' ')).not.toContain('unsupported');expect(await count()).toEqual(before);
 }));
 it('native order preparation preserves adoption and independent dual windows with specific missing anchors',async()=>run(async()=>{
  const result=await service.preview(f.root,{selection:{mode:'instance',range:'preparation',kind:'order',id:orderId}});expect(result.context.identity.orderId).toBe(orderId);expect(result.current.rows.find(n=>n.id==='preparation_draft')).toMatchObject({minutes:1440,independent:true});expect(result.current.rows.find(n=>n.id==='preparation_final')).toMatchObject({minutes:1440,independent:true});expect(result.current.rows.some(n=>n.id==='production_sheet')).toBe(false);expect(result.current.overall.status).toBe('partial');expect(result.context.bindings.preparation).toHaveProperty('adoption');
 }));
 it('revalidates native material facts, preserving the old digest only until a real scoped event changes',async()=>run(async()=>{
  const selection={mode:'instance' as const,range:'preparation' as const,kind:'order' as const,id:orderId},before=await service.preview(f.root,{selection});
  const readiness=new ProductionReadinessService(f.db),resource={kind:'order' as const,id:orderId},state=await readiness.read(f.root,resource);
  await readiness.assign(f.root,resource,{expectedVersion:state.responsibility.version,warehouseWorkerId:f.people.warehouse!.actorId,colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST native material scope for calculation'},randomUUID());
  const prior=(await readiness.read(f.root,resource)).facts.find(f=>f.kind==='fabric_receipt'&&f.scopeRef==='whole');
  await readiness.record(f.people.warehouse!,resource,{kind:'fabric_receipt',scopeRef:'whole',expectedVersion:prior?.version??0,state:'ready',occurredAt:'2026-11-02T00:00:00Z',note:'TEST explicit real command, no test SLA event copy',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  const counts=await count(),after=await service.preview(f.root,{selection,checkContextDigest:before.contextDigest});expect(after.contextChanged).toBe(true);expect(after.contextDigest).not.toBe(before.contextDigest);expect(after.current.rows.find(n=>n.id==='preparation_draft')!.start.at).toBe('2026-11-02T00:00:00.000Z');expect(after.current.rows.find(n=>n.id==='preparation_final')!.start.at).toBeNull();expect(await count()).toEqual(counts);
 }));
 it('requires exact owned PO/batch scope and does not promote a source to a mother order',async()=>run(async()=>{
  await expect(service.preview(f.root,{selection:{mode:'instance',range:'delivery',kind:'order',id:orderId,poLineId:randomUUID()}})).rejects.toMatchObject({statusCode:404});
  await expect(service.preview(f.root,{selection:{mode:'instance',range:'bulk_craft',kind:'order',id:orderId,batchId:randomUUID()}})).rejects.toMatchObject({statusCode:404});
  await expect(service.preview(f.root,{selection:{mode:'instance',range:'preparation',kind:'source',id:sourceA}})).rejects.toMatchObject({statusCode:400});
 }));
 it.each([['印花','bulk_printing',96],['绣花','bulk_embroidery',96],['印绣花','bulk_print_embroidery',168]] as const)('binds native two-PO %s batch scope and keeps actual QC/contract absence explicit',(craft,key,hours)=>run(async()=>{
  const ready=await f.bulkReady(craft,undefined,2),cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of (await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY cutting_order_id',[ready.caseId])).rows)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db);let state=await flow.read(f.root,ready.id);const lineId=state.batchTotals![0]!.lineId;state=await flow.logistics(f.root,ready.id,{expectedRevision:state.revision,kind:'工艺发出',occurredAt:'2026-11-02T00:00:00Z',supplier:'TEST native batch factory',note:'TEST scoped send',lines:[{lineId,quantity:10}]},randomUUID());const send=state.pendingSends![0]!.factId;
  const selected={mode:'instance' as const,range:'bulk_craft' as const,kind:'order' as const,id:ready.id,batchId:send},before=await count(),result=await service.preview(f.root,{selection:selected});
  expect(result.current.rows.find(n=>n.id.endsWith('/'+key))!.minutes).toBe(hours*60);expect(result.current.rows.find(n=>n.id.endsWith('/bulk_qc'))).toMatchObject({basis:'standard',start:{at:new Date(Date.parse('2026-11-02T00:00:00Z')+hours*3600000).toISOString()}});expect(result.current.rows.find(n=>n.id.endsWith('/warehouse_dispatch'))!.end.at).toBeNull();expect(result.context.bindings.batchScope).toHaveProperty('snapshotId');expect(await count()).toEqual(before);
  const all=await service.preview(f.root,{selection:{mode:'instance',range:'bulk_craft',kind:'order',id:ready.id}});expect(all.current.rows.some(n=>n.id==='uncovered_craft_scope')).toBe(true);
  const one=await service.preview(f.root,{selection:{mode:'instance',range:'bulk_craft',kind:'order',id:ready.id,poLineId:lineId}});expect(one.current.rows.some(n=>n.id==='uncovered_craft_scope')).toBe(false);
  const whole=await service.preview(f.root,{selection:{mode:'instance',range:'whole',kind:'order',id:ready.id,poLineId:lineId}});
  for(const native of one.current.rows.filter(row=>row.id.endsWith('/'+key)||row.id.endsWith('/bulk_qc'))){const projected=whole.current.rows.find(row=>row.id==='bulk_craft/'+native.id)!;expect(projected.start).toEqual(native.start);expect(projected.end).toEqual(native.end);expect(projected.minutes).toBe(native.minutes);}
  expect(await count()).toEqual(before);
  const contractState=(await f.db.query('SELECT * FROM sourcing_contract_return_business_state($1)',[ready.caseId])).rows[0],contract=await service.preview(f.root,{selection:{mode:'instance',kind:'order',id:ready.id,range:'contract'}});expect(contract.context.bindings.contractHistory).toEqual(expect.arrayContaining([expect.objectContaining({child_id:ready.caseId,contract_return_monitor_enabled:contractState.contract_return_monitor_enabled})]));expect(contract.current.rows).toHaveLength(1);if(!contractState.contract_return_monitor_enabled)expect(contract.current.rows[0]!.applicable).toBe('no');
  state=await flow.logistics(f.root,ready.id,{expectedRevision:state.revision,kind:'工艺回仓',sendFactId:send,occurredAt:'2026-11-02T00:00:00Z',supplier:'TEST native batch factory',note:'TEST effective original return',lines:[{lineId,quantity:10}]},randomUUID());const returned=state.facts.at(-1)!.factId;
  state=await flow.qc(f.root,ready.id,{expectedRevision:state.revision,returnFactId:returned,checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}],note:'TEST original QC complete'},randomUUID());
  const completed=await service.preview(f.root,{selection:selected});expect(completed.current.rows.find(n=>n.id.endsWith('/bulk_qc'))).toMatchObject({basis:'actual',end:{at:'2026-11-02T00:00:00.000Z'}});expect(completed.current.rows.some(n=>n.label.includes('待回'))).toBe(false);
 }));
 it('R2-03: whole flow reads native partial and complete ship sample facts for the exact selected PO',async()=>run(async()=>{
  const ready=await f.bulkReady('无',undefined,2),flow=new FactoryFlowService(f.db);let state=await flow.read(f.root,ready.id);const [a,b]=state.lines.map(line=>line.lineId);
  state=await flow.followup(f.root,ready.id,{expectedRevision:state.revision,kind:'船样寄出',lineIds:[a!],occurredAt:'2026-11-02T00:00:00Z',trackingNumber:'TEST-R2-SAMPLE-A',note:'TEST original partial PO sample'},randomUUID());
  const before=await count(),selection={mode:'instance' as const,range:'whole' as const,kind:'order' as const,id:ready.id},all=await service.preview(f.root,{selection}),one=await service.preview(f.root,{selection:{...selection,poLineId:a}});
  expect(all.current.rows.find(n=>n.id===`ship_sample:${a}`)).toMatchObject({basis:'actual',end:{at:'2026-11-02T00:00:00.000Z'}});expect(all.current.rows.find(n=>n.id===`ship_sample:${b}`)!.end.at).toBeNull();expect(all.current.rows.some(n=>n.id==='ship_sample')).toBe(false);expect(one.current.rows.filter(n=>n.id.startsWith('ship_sample:')).map(n=>n.id)).toEqual([`ship_sample:${a}`]);expect(one.current.rows.find(n=>n.id.startsWith('ship_sample:'))!.end).toEqual(all.current.rows.find(n=>n.id===`ship_sample:${a}`)!.end);expect(await count()).toEqual(before);
  await flow.followup(f.root,ready.id,{expectedRevision:state.revision,kind:'船样寄出',lineIds:[b!],occurredAt:'2026-11-02T00:00:00Z',trackingNumber:'TEST-R2-SAMPLE-B',note:'TEST original remaining PO sample'},randomUUID());
  const completed=await service.preview(f.root,{selection});expect(completed.current.rows.filter(n=>n.id.startsWith('ship_sample:')).every(n=>n.basis==='actual'&&n.end.at==='2026-11-02T00:00:00.000Z')).toBe(true);
 }));
 it('R2-03: whole flow preserves separately frozen source and production buffers without a draft edit',async()=>{
  const settings=new DigitalProductionTaskService(f.db),initial=await settings.slaSettings(f.root),publish=async(minutes:number)=>{const current=await settings.slaSettings(f.root),input={expectedVersion:current.version,values:{...current.values,stage_buffer:{kind:'buffer' as const,minutes}},reason:'TEST separate source/order frozen buffer'},preview=await settings.previewSlaSettings(f.root,input);await settings.publishSlaSettings(f.root,{...input,previewToken:preview.token},randomUUID());};
  try{
   await publish(6);const ownScene=await f.scene('2026-11-02T00:00:00Z'),ownRun=<T,>(fn:()=>Promise<T>)=>f.runtime.run(ownScene,f.root,fn),sourceId=await ownRun(()=>createSource()),source=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0];await publish(180);
   const made=await ownRun(()=>identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:source.design_style_no,orderDate:'2026-11-02',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-BUFFER-PO',color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:1}]}]}),randomUUID(),sourceId));
   const application=new SlaOrderApplicationService(f.db),selection={orderId:made.productionOrderId,configurationVersion:(await settings.slaSettings(f.root)).version,parameterKeys:['stage_buffer'],reason:'TEST explicit order-only newer buffer application'},preview=await ownRun(()=>application.preview(f.root,selection));await ownRun(()=>application.apply(f.root,{...selection,previewToken:preview.token},randomUUID()));
   const result=await ownRun(()=>service.preview(f.root,{selection:{mode:'instance',range:'whole',kind:'order',id:made.productionOrderId}}));
   expect(result.context.graph.nodes.find(n=>n.id==='development/development_pattern')!.stageBufferMinutes).toBe(6);expect(result.context.graph.nodes.find(n=>n.id==='bulk_cutting')!.stageBufferMinutes).toBe(180);expect(result.context.graph.nodes.find(n=>n.id==='preparation/bulk_pattern')!.stageBufferMinutes).toBe(180);expect(result.draft).toEqual(result.current);
  }finally{const current=await settings.slaSettings(f.root);if(JSON.stringify(current.values)!==JSON.stringify(initial.values)){const input={expectedVersion:current.version,values:initial.values,reason:'TEST restore initial defaults after distinct frozen buffer scene'},preview=await settings.previewSlaSettings(f.root,input);await settings.publishSlaSettings(f.root,{...input,previewToken:preview.token},randomUUID());}}
 });
 it('fresh settings authority allows PMC read while worker/designer/system-admin remain denied',async()=>{
  expect((await service.preview(pmc,example())).current.overall.spanMs).toBe(80.5*3600000);
  for(const key of ['pattern-room-worker','sample-designer','system-admin'])await expect(service.preview(f.people[key]!,example())).rejects.toMatchObject({statusCode:403});
 });
 it('original HTTP rejects anonymous requests, client facts and extended StandardDraft fields',async()=>{
  const endpoint='/digital-production/sla-settings/calculation-preview',headers={cookie:`dx_rework_session=${f.root.actorId}`};expect((await app.inject({method:'POST',url:endpoint,payload:example()})).statusCode).toBe(401);
  const ok=await app.inject({method:'POST',url:endpoint,headers,payload:example()});expect(ok.statusCode,ok.body).toBe(200);
  for(const extra of [{actorId:f.root.actorId},{graph:{}},{totalHours:0},{previewToken:'forged'}])expect((await app.inject({method:'POST',url:endpoint,headers,payload:{...example(),...extra}})).statusCode).toBe(400);
  const result=ok.json(),standard={expectedVersion:result.context.unified.version,values:result.context.unified.values,reason:'TEST explicit draft only'};
  const invalidValues=structuredClone(result.context.unified.values);invalidValues.development_pattern={kind:'duration',minutes:''};const invalid=await app.inject({method:'POST',url:endpoint,headers,payload:{...example(),unified:{expectedVersion:result.context.unified.version,values:invalidValues}}});expect(invalid.statusCode).toBe(400);expect(invalid.json().error.message).toContain('开发纸样');
  for(const extra of [{route:'development'},{anchor:'2026-11-02'},{calculationReceipt:result.calculationReceipt}])expect((await app.inject({method:'POST',url:'/digital-production/sla-settings/preview',headers,payload:{...standard,...extra}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/digital-production/sla-settings/publish',headers:{...headers,'idempotency-key':randomUUID()},payload:{...standard,previewToken:result.calculationReceipt.contextDigest}})).statusCode).toBe(400);
 });
 it('retains original legal preview/publish contract and rejects calculation receipts at the in-flight apply entrance',async()=>{
  const headers={cookie:`dx_rework_session=${f.root.actorId}`},read=await service.preview(f.root,example()),values=structuredClone(read.context.unified.values);values.development_pattern={kind:'duration',minutes:2160};
  const standard={expectedVersion:read.context.unified.version,values,reason:'TEST original preview compatibility; no publication'};
  const preview=await app.inject({method:'POST',url:'/digital-production/sla-settings/preview',headers,payload:standard});expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const apply=await app.inject({method:'POST',url:'/digital-production/sla-settings/orders/apply',headers:{...headers,'idempotency-key':randomUUID()},payload:{orderId,configurationVersion:read.context.unified.version,parameterKeys:['development_pattern'],reason:'TEST forged calculation application',previewToken:read.calculationReceipt.contextDigest}});expect(apply.statusCode).toBe(400);
  const pmcPreview=await app.inject({method:'POST',url:'/digital-production/sla-settings/preview',headers:{cookie:`dx_rework_session=${pmc.actorId}`},payload:standard});expect(pmcPreview.statusCode).toBe(403);
  const before=await count(),key=randomUUID(),publishInput={...standard,previewToken:preview.json().token},published=await app.inject({method:'POST',url:'/digital-production/sla-settings/publish',headers:{...headers,'idempotency-key':key},payload:publishInput});expect(published.statusCode,published.body).toBe(200);expect(published.json()).toMatchObject({version:read.context.unified.version+1,scope:'new_orders',existingOrdersChanged:0});const retry=await app.inject({method:'POST',url:'/digital-production/sla-settings/publish',headers:{...headers,'idempotency-key':key},payload:publishInput});expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual(published.json());const after=await count();expect(after.digital_sla_configurations).toBe(before.digital_sla_configurations+1);expect(after.digital_sla_order_snapshots).toBe(before.digital_sla_order_snapshots);expect(after.digital_production_tasks).toBe(before.digital_production_tasks);const frozen=await run(()=>service.preview(f.root,instance()));expect(frozen.current.rows.find(n=>n.id==='development_pattern')!.minutes).toBe(2880);
 });
 it('a stale unified version is rejected without publishing, mutating an order or silently accepting stale draft values',async()=>{
  const read=await service.preview(f.root,example()),before=await count();await expect(service.preview(f.root,{...example(),unified:{expectedVersion:read.context.unified.version+1,values:read.context.unified.values}})).rejects.toMatchObject({statusCode:409});expect(await count()).toEqual(before);
 });
 it('independent version publication invalidates calculation context but leaves existing source freeze and unified policy intact',async()=>{
  const before=await service.preview(f.root,example()),technical=new DevelopmentTechnicalSettingsService(f.db,true,'TEST-calculation-cycle-secret'),read=await technical.read(f.root),values={...read.values,normalDays:read.values.normalDays+1},input={expectedVersion:read.version,values,reason:'TEST isolated independent version change'};
  const preview=await technical.preview(f.root,input);await technical.publish(f.root,{...input,previewToken:preview.token},randomUUID());
  const after=await service.preview(f.root,{...example(),checkContextDigest:before.contextDigest});expect(after.contextChanged).toBe(true);expect(after.context.development.version).toBe(read.version+1);expect(after.context.unified).toEqual(before.context.unified);
  await expect(service.preview(f.root,{...example(),development:{expectedVersion:read.version,values}})).rejects.toMatchObject({statusCode:409});
  const saved=await run(()=>service.preview(f.root,instance()));expect(saved.current.rows.find(n=>n.id==='development_cycle')!.minutes).toBe(7*1440);
 });
 it('reports an instance-frozen included-window conflict as field-specific HTTP 400 without blocking a legal new-order standard',async()=>{
  const settings=new DigitalProductionTaskService(f.db),publish=async(values:Awaited<ReturnType<typeof settings.slaSettings>>['values'],reason:string)=>{
   const current=await settings.slaSettings(f.root),input={expectedVersion:current.version,values,reason},preview=await settings.previewSlaSettings(f.root,input);
   return settings.publishSlaSettings(f.root,{...input,previewToken:preview.token},randomUUID());
  };
  const initial=await settings.slaSettings(f.root),frozenValues=structuredClone(initial.values);
  frozenValues.development_craft_dispatch={kind:'included',minutes:60};frozenValues.development_craft_return={kind:'included',minutes:60};
  await publish(frozenValues,'TEST new sources freeze two native sixty-minute included targets');
  const sourceId=await createSource('印花'),currentValues=structuredClone(frozenValues);
  currentValues.development_craft_dispatch={kind:'included',minutes:30};currentValues.development_craft_return={kind:'included',minutes:30};
  await publish(currentValues,'TEST current new-order targets differ from the already frozen source');
  const current=await settings.slaSettings(f.root),values=structuredClone(current.values);values.development_printing={kind:'duration',minutes:90};
  const before=await count(),response=await app.inject({method:'POST',url:'/digital-production/sla-settings/calculation-preview',headers:{cookie:`dx_rework_session=${f.root.actorId}`},payload:{selection:instance(sourceId).selection,unified:{expectedVersion:current.version,values}}});
  expect(response.statusCode,response.body).toBe(400);expect(response.json().error.message).toContain('development_printing.minutes');expect(response.json().error.message).toContain('内含目标');expect(await count()).toEqual(before);
  await expect(publish(values,'TEST ninety minutes remains legal for new sources with two thirty-minute targets')).resolves.toMatchObject({version:current.version+1,existingOrdersChanged:0});
  const source=await service.preview(f.root,instance(sourceId));expect(source.current.rows.find(n=>n.id==='development_craft_dispatch')!.minutes).toBe(60);expect(source.current.rows.find(n=>n.id==='development_printing')!.minutes).toBe(frozenValues.development_printing.minutes);
 });
 it('same valid actor/session cannot retain settings context after its dedicated PMC role is revoked',async()=>{
  const original=await service.preview(pmc,example()),root={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']};await f.access.revokeRole(root,assignmentId,'TEST dedicated role revocation; no Lab identity switch');
  await expect(service.preview(pmc,{...example(),checkContextDigest:original.contextDigest})).rejects.toMatchObject({statusCode:403});
 });
});
