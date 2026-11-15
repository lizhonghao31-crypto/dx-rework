import {readSeriesPlanFacts} from '../../apps/api/src/production-platform/series-plan-facts.js';
import {technicalDocumentFingerprint} from '../../apps/api/src/production-platform/development-technical-repository.js';
import {QuotationConfirmationSchema} from '@dx-rework/contracts/digital-quotation';
import {calculateBudget} from '@dx-rework/contracts/digital-budget';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {nodeMaterialsFixture} from '../helpers/node-materials-fixture.js';
import Fastify from 'fastify';
import PDFDocument from 'pdfkit';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {AcceptanceObjectStorage,registerAcceptanceStorageRoutes} from '../../apps/api/src/tools/acceptance-storage.js';
import {registerDevelopmentRoutes} from '../../apps/api/src/production-platform/development-routes.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {registerDevelopmentExecutionRoutes} from '../../apps/api/src/production-platform/development-execution-routes.js';
import {readDevelopmentRevisionPlan} from '../../apps/api/src/production-platform/development-round-plan.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {developmentSlaPlan} from '../../apps/api/src/production-platform/development-sla-enrollment.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {SlaCalculationService} from '../../apps/api/src/production-platform/sla-calculation-service.js';
import {ContextBusinessClock,businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {randomUUID,createHash} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import type {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {RootAwareTodoProjectionService} from '../../apps/api/src/todos/root-aware-projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import type {TechnicalArtifactBody,SaveTechnicalArtifact,RecordFinalComment} from '@dx-rework/contracts/digital-development-technical';
import {DEVELOPMENT_ARRANGEABLE_KINDS} from '@dx-rework/contracts/development-arrangement';
import {nativeTaskReadiness} from '../../apps/api/src/production-platform/task-readiness-facts.js';
import {ManagementReportingService} from '../../apps/api/src/reporting/management-reporting-service.js';
import {ReportQuerySchema} from '@dx-rework/contracts/reporting';
import {arrangeTestRound} from '../helpers/development-arrangement-fixture.js';
import {developmentNativeRound} from '../../apps/api/src/production-platform/development-native-round.js';

// This fixture exercises the real Acceptance business clock and original UAT
// initializer, so use the existing clock-test database rather than the CI app DB.
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('approved development technical evidence on complete native schema',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,identity:DigitalProductionIdentityService,forms:DigitalDevelopmentService,execution:DevelopmentExecutionService,technical:DevelopmentTechnicalService,tasks:DigitalProductionTaskService;
 let native:PatternRoomOrderService;
 let category:{categoryId:string;priceVersion:number};
 const person=(key:string)=>f.people[key]??(()=>{throw Error(`Missing native fixture role ${key}`);})();
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);
  for(const p of Object.values(f.people)){
   const rows=(await f.db.query('SELECT DISTINCT c.capability FROM user_role_assignments a JOIN role_capabilities c USING(role_code) WHERE a.user_id=$1 AND a.revoked_at IS NULL',[p.actorId])).rows;
   p.authorizationCapabilities=[...new Set([...(p.authorizationCapabilities??[]),...rows.map(r=>r.capability as string)])];
  }
  native=new PatternRoomOrderService(f.db,new RootAwareTodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
  identity=new DigitalProductionIdentityService(f.db,true);forms=new DigitalDevelopmentService(f.db,true,native);
  execution=new DevelopmentExecutionService(f.db,true,native,'TEST-technical-preview-secret-not-live');technical=execution.technicalEvidenceService();tasks=new DigitalProductionTaskService(f.db);
  const prices=new PatternRoomPriceService(f.db),option=(await prices.options(f.root))[0]!;
  const quote=await prices.quote(f.root,'category',option.priceId),changed=await prices.change(f.root,'category',option.priceId,{version:quote.version,amount:'10.000',enabled:true,reason:'TEST isolated technical sample'},randomUUID());
  category={categoryId:changed.priceId,priceVersion:changed.version};
 });
 afterAll(async()=>{await f?.dispose();});
 const prepare=async(craft:'无'|'印花'='无',options:{automatic?:boolean;missingAccessory?:boolean;assignSewing?:boolean;withoutNative?:boolean}={})=>{
  const designer=person('sample-designer'),worker=person('pattern-room-worker'),materialId=randomUUID();
  const created=await identity.createSource(designer,{developmentType:'头版',designStyleNo:`TEST-TECH-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const sourceId=created.sourceId,photo=await f.image(designer);
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:1,sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],
   interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST technical garment',craft,washing:'免洗',
   materials:[{materialId,category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'TEST40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
  const accessoryId=options.missingAccessory?randomUUID():null;
  if(accessoryId)document.materials.push({...document.materials[0]!,materialId:accessoryId,category:'辅料',label:'TEST必要纽扣',name:'纽扣',available:false,expectedDate:'2027-01-01'});
  if(options.automatic){document.quotationMode='automatic_v1';document.materials=document.materials.map(m=>({...m,pricingUnit:m.category==='辅料'?'件':'米',unitPrice:m.category==='辅料'?'2':'20'}));}
  const saved=await forms.save(designer,sourceId,{expectedVersion:0,document},randomUUID());
  if(options.withoutNative)await new DigitalDevelopmentService(f.db,true).publish(designer,sourceId,saved.version,randomUUID());
  else await forms.publish(designer,sourceId,saved.version,randomUUID(),category);
  const fixed=await execution.read(f.root,sourceId);
  if(!fixed.fixedCutting?.valid)await execution.configureFixedCutting(f.root,sourceId,{expectedVersion:fixed.fixedCutting?.version??0,assigneeId:worker.actorId,reason:'TEST fixed cutter'},randomUUID());
  const checkedState=await execution.read(f.root,sourceId),check=checkedState.tasks.find(t=>t.taskKind==='development_materials')!;
  const savedVerification=await execution.saveMaterials(f.root,sourceId,{taskId:check.taskId,expectedVersion:checkedState.materialVerification!.version,expectedDocumentVersion:checkedState.sheet.version,
   entries:[{materialId,usage:'use',physical:true,quantity:true,color:true,specification:true,note:'TEST真实使用',confirmedWith:''},...(accessoryId?[{materialId:accessoryId,usage:'use' as const,physical:false,quantity:true,color:true,specification:true,note:'TEST必要辅料待到，原规则允许先纸样裁板',confirmedWith:'TEST设计师确认'}]:[])],note:'TEST actual clerk verification',result:'通过'},randomUUID());
  await execution.check(f.root,sourceId,{taskId:check.taskId,result:'通过',note:'TEST actual material verification',expectedVerificationVersion:savedVerification.version,items:[{materialId,physical:true,quantity:true,color:true,specification:true},...(accessoryId?[{materialId:accessoryId,physical:false,quantity:true,color:true,specification:true}]:[])]},randomUUID());
  const state=await execution.read(f.root,sourceId),arrangement=state.arrangement!;
  await execution.arrange(f.root,sourceId,{roundNumber:1,expectedDocumentVersion:state.sheet.version,expectedVersion:arrangement.version,management:'keep',managementReason:'',entries:arrangement.rows.filter(r=>(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(r.kind)).map(r=>({kind:r.kind as typeof DEVELOPMENT_ARRANGEABLE_KINDS[number],assigneeId:r.kind==='development_sewing'&&options.assignSewing===false?null:r.editable&&r.requiredRole==='pattern_room_worker'?worker.actorId:r.editable&&r.requiredRole==='pattern_room_tail_inspector'?Object.values(f.people).find(p=>p.actorRoles.includes('pattern_room_tail_inspector'))!.actorId:r.assigneeId,expectedTask:r.taskId?{taskId:r.taskId,state:r.state!,assigneeId:r.assigneeId}:null,reason:'TEST explicit current worker'}))},randomUUID());
  const paper=(await execution.read(worker,sourceId)).tasks.find(t=>t.taskKind==='development_pattern')!;
  return {sourceId,materialId,accessoryId,designer,worker,paper,checkTaskId:check.taskId,publishedAt:(await forms.read(f.root,sourceId)).publishedAt,documentVersion:(await forms.read(worker,sourceId)).version};
 };
 const plot=async(p:Awaited<ReturnType<typeof prepare>>,taskId=p.paper.taskId)=>{
  const bytes=Buffer.from('IN;SP1;PU0,0;PD100,100;PU;SP0;'),sha256=createHash('sha256').update(bytes).digest('hex');
  const intent=await f.attachments.createTechnicalPlotUploadIntent(p.worker,p.sourceId,taskId,{filename:'TEST-paper.plt',mimeType:'application/octet-stream',sizeBytes:bytes.length,sha256});
  await execution.recordUploadPurpose(p.worker,p.sourceId,intent.attachmentId,'纸样成果',taskId);
  await f.storage.writeImmutable(intent.objectKey,bytes,{mimeType:'application/octet-stream',sha256});
  await f.attachments.finalize(p.worker,intent.attachmentId);return intent.attachmentId;
 };
 const artifact=async(p:Awaited<ReturnType<typeof prepare>>,overrides:Partial<SaveTechnicalArtifact>={})=>{
  const body:TechnicalArtifactBody={pltAttachmentIds:[await plot(p,overrides.taskId)],consumptionRows:[{materialId:p.materialId,unit:'米',consumption:'1.250000'}],baseSizeTable:{unit:'cm',baseSize:'M',sizes:['M'],measurements:[{pointId:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['48']}],gradingNote:'TEST explicit grading note',templateRef:null},note:'TEST三件套',basedOnFinalComment:null};
  return technical.saveArtifact(p.worker,p.sourceId,{taskId:p.paper.taskId,expectedDocumentVersion:p.documentVersion,expectedVersion:0,scopeRef:'整款',action:'publish',body,...overrides},randomUUID());
 };
 const comment=(version=0,isFinal=true):RecordFinalComment=>({roundNumber:1,scopeRef:'整款',expectedVersion:version,isFinal,decision:'approved',text:'TEST客户最终批复，技术仍须核对或沿用',evidenceRefs:[],evidenceNote:'TEST客户邮件文字记录，非报价确认',occurredAt:null});

 it('PR03 assembles exact native materials, formal consumption, IE and assigned craft; freezes confirmed budgets across later source changes',async()=>{
  const p=await prepare('印花',{automatic:true,missingAccessory:true}),resource={kind:'source' as const,id:p.sourceId},quotes=new DigitalQuotationService(f.db,true);
  let q=await quotes.read(p.designer,resource);
  expect(q.automatic).toBe(true);expect(q.complete).toBe(false);
  expect(q.document!.rows).toHaveLength(4);
  const ie=q.document!.rows.find(r=>r.name==='IE加工单价')!,craft=q.document!.rows.find(r=>r.name==='印花')!;
  q=await quotes.save(p.designer,resource,{expectedVersion:q.version,document:q.document!,assignments:q.assignments.map(a=>a.rowId===ie.rowId?{...a,priceAssigneeId:person('ie').actorId}:a)},randomUUID());
  const own=await quotes.read(p.worker,resource);expect(own.document).toBeNull();expect(own.rows.find(r=>r.rowId===p.materialId)!.unitPrice).toBeNull();expect(own.rows.find(r=>r.rowId===craft.rowId)!.canEditPrice).toBe(true);
  expect((await forms.read(p.worker,p.sourceId)).document!.materials.every(m=>m.unitPrice===undefined)).toBe(true);
  q=await quotes.fillRow(p.worker,resource,p.materialId,{expectedVersion:q.version,consumption:'1.5'},randomUUID());
  q=await quotes.fillRow(p.worker,resource,p.accessoryId!,{expectedVersion:q.version,consumption:'1'},randomUUID());
  q=await quotes.fillRow(person('ie'),resource,ie.rowId,{expectedVersion:q.version,unitPrice:'10'},randomUUID());
  q=await quotes.fillRow(p.worker,resource,craft.rowId,{expectedVersion:q.version,unitPrice:'3'},randomUUID());
  q=await quotes.read(p.designer,resource);expect(q.complete).toBe(true);expect(calculateBudget(q.document!).cost).toBe('45');
  await expect(quotes.fillRow(person('ie'),resource,ie.rowId,{expectedVersion:q.version,consumption:'2'},randomUUID())).rejects.toMatchObject({statusCode:403});
  const confirmation=QuotationConfirmationSchema.parse({expectedVersion:q.version,customerCode:'PD',customerConfirmedTotal:'45',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST independently confirmed 45, not assumed from cost',confirmedAt:businessNow().toISOString()});
  const confirmedVersion=q.version;
  const simultaneous=await Promise.allSettled([quotes.confirm(p.designer,resource,confirmation,randomUUID()),quotes.confirm(p.designer,resource,confirmation,randomUUID())]);
  expect(simultaneous.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await f.db.query('SELECT version FROM digital_quotation_versions WHERE quote_id=$1',[q.quoteId])).rows).toHaveLength(1);
  const order=await identity.createOrder(p.designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:(await forms.read(p.designer,p.sourceId)).designStyleNo,temporaryStyleNo:null,orderDate:'2026-10-20',lines:[{color:'黑',sizes:[{size:'M',quantity:10}],deliveryDate:'2027-03-01'}]}),randomUUID(),p.sourceId);
  const budgets=new DigitalBudgetService(f.db,true),originalBudget=await budgets.read(f.root,order.productionOrderId);
  expect(originalBudget.comparison?.budgetComparableTotal).toBe('45');
  q=await quotes.read(p.designer,resource);const priceKey=randomUUID(),priceInput={expectedVersion:q.version,unitPrice:'22'};
  q=await quotes.fillRow(p.designer,resource,p.materialId,priceInput,priceKey);
  const version=q.version;expect(calculateBudget(q.document!).cost).toBe('48');
  await quotes.fillRow(p.designer,resource,p.materialId,priceInput,priceKey);expect((await quotes.read(p.designer,resource)).version).toBe(version);
  await expect(quotes.confirm(p.designer,resource,{...confirmation,expectedVersion:confirmedVersion},randomUUID())).rejects.toMatchObject({statusCode:409});
  const body:TechnicalArtifactBody={pltAttachmentIds:[await plot(p)],consumptionRows:[{materialId:p.materialId,unit:'米',consumption:'1.6'},{materialId:p.accessoryId!,unit:'件',consumption:'1'}],baseSizeTable:{unit:'cm',baseSize:'M',sizes:['M'],measurements:[{pointId:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['48']}],gradingNote:'TEST',templateRef:null},note:'TEST source version',basedOnFinalComment:null};
  await artifact(p,{body});q=await quotes.read(p.designer,resource);expect(calculateBudget(q.document!).cost).toBe('50.2');
  q=await quotes.fillRow(p.worker,resource,craft.rowId,{expectedVersion:q.version,unitPrice:'5'},randomUUID());
  q=await quotes.read(p.designer,resource);expect(calculateBudget(q.document!).cost).toBe('52.2');
  const preserved=await quotes.read(p.designer,resource,undefined,confirmedVersion);expect(calculateBudget(preserved.document!).cost).toBe('45');
  expect((await budgets.read(f.root,order.productionOrderId)).document).toEqual(originalBudget.document);
  q=await quotes.fillRow(p.worker,resource,craft.rowId,{expectedVersion:q.version,unitPrice:''},randomUUID());
  expect(q.complete).toBe(false);await expect(quotes.confirm(p.designer,resource,{...confirmation,expectedVersion:q.version},randomUUID())).rejects.toMatchObject({statusCode:409});
  q=await quotes.fillRow(p.worker,resource,craft.rowId,{expectedVersion:q.version,unitPrice:'0'},randomUUID());
  q=await quotes.read(p.designer,resource);expect(q.complete).toBe(true);expect(calculateBudget(q.document!).cost).toBe('47.2');
  const before=q.version;await quotes.read(p.designer,resource);expect((await quotes.read(p.designer,resource)).version).toBe(before);
 });

 it('PR03 rejects cross-source/stale inputs, withdraws superseded formal consumption and keeps unpublished artifact drafts out',async()=>{
  const p=await prepare('无',{automatic:true}),resource={kind:'source' as const,id:p.sourceId},quotes=new DigitalQuotationService(f.db,true);
  const v1=await artifact(p);let q=await quotes.read(p.designer,resource);
  expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.consumption).toBe('1.250000');
  const price=q.version;
  const body:TechnicalArtifactBody={pltAttachmentIds:[await plot(p)],consumptionRows:[{materialId:p.materialId,unit:'码',consumption:'1.25'}],baseSizeTable:{unit:'cm',baseSize:'M',sizes:['M'],measurements:[{pointId:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['48']}],gradingNote:'TEST',templateRef:null},note:'TEST consumption withdrawn',basedOnFinalComment:null};
  await artifact(p,{expectedVersion:v1.version,action:'save',body});
  expect((await quotes.read(p.designer,resource)).version).toBe(price);
  await artifact(p,{expectedVersion:v1.version+1,body});q=await quotes.read(p.designer,resource);
  expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.consumption).toBe('');expect(q.complete).toBe(false);
  await expect(quotes.fillRow(p.worker,resource,p.materialId,{expectedVersion:price,consumption:'2'},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(quotes.fillRow(person('ie'),resource,p.materialId,{expectedVersion:q.version,unitPrice:'1'},randomUUID())).rejects.toMatchObject({statusCode:404});
  const other=await prepare('无',{automatic:true});
  await expect(quotes.fillRow(p.worker,resource,other.materialId,{expectedVersion:q.version,consumption:'1'},randomUUID())).rejects.toMatchObject({statusCode:404});
 });

 it('PR03 follows saved source price/reordering/withdrawal exactly once, without matching by name',async()=>{
  const p=await prepare('无',{automatic:true,missingAccessory:true}),original=(await forms.read(p.designer,p.sourceId)).document!;
  const source=await identity.createSource(p.designer,{developmentType:'头版',designStyleNo:'TEST-QUOTE-SOURCE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const resource={kind:'source' as const,id:source.sourceId},quotes=new DigitalQuotationService(f.db,true);
  let saved=await forms.save(p.designer,source.sourceId,{expectedVersion:0,document:{...original,orderDate:null,files:[]}},randomUUID());
  let q=await quotes.read(p.designer,resource);
  q=await quotes.save(p.designer,resource,{expectedVersion:q.version,document:q.document!,assignments:q.assignments.map(a=>a.priceRole==='ie_reviewer'?{...a,priceAssigneeId:person('ie').actorId}:{...a,technicalAssigneeId:p.worker.actorId})},randomUUID());
  q=await quotes.fillRow(p.worker,resource,p.materialId,{expectedVersion:q.version,consumption:'1.5'},randomUUID());
  q=await quotes.fillRow(p.worker,resource,p.accessoryId!,{expectedVersion:q.version,consumption:'1'},randomUUID());
  const ie=q.rows.find(r=>r.assignment.priceRole==='ie_reviewer')??(await quotes.read(p.designer,resource)).rows.find(r=>r.assignment.priceRole==='ie_reviewer')!;
  q=await quotes.fillRow(person('ie'),resource,ie.rowId,{expectedVersion:q.version,unitPrice:'10'},randomUUID());
  const before=await quotes.read(p.designer,resource);expect(calculateBudget(before.document!).cost).toBe('42');
  const current=(await forms.read(p.designer,source.sourceId)).document!,key=randomUUID();
  const changed={expectedVersion:saved.version,document:{...current,materials:[...current.materials].reverse().map(m=>m.materialId===p.materialId?{...m,unitPrice:'22'}:m)}};
  saved=await forms.save(p.designer,source.sourceId,changed,key);q=await quotes.read(p.designer,resource);
  expect(calculateBudget(q.document!).cost).toBe('45');expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.consumption).toBe('1.5');
  const version=q.version;await forms.save(p.designer,source.sourceId,changed,key);expect((await quotes.read(p.designer,resource)).version).toBe(version);
  await expect(forms.save(p.designer,source.sourceId,{...changed,expectedVersion:saved.version-1},randomUUID())).rejects.toMatchObject({statusCode:409});
  saved=await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document:{...changed.document,materials:changed.document.materials.map(m=>m.materialId===p.materialId?{...m,unitPrice:''}:m)}},randomUUID());
  q=await quotes.read(p.designer,resource);expect(q.complete).toBe(false);expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.unitPrice).toBe('');
  await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document:{...changed.document,materials:changed.document.materials.map(m=>m.materialId===p.materialId?{...m,unitPrice:'0'}:m)}},randomUUID());
  q=await quotes.read(p.designer,resource);expect(q.complete).toBe(true);expect(calculateBudget(q.document!).cost).toBe('12');
 });

 it('quotation dependencies preserve unrelated prices and consumption across legacy upgrade, craft additions/removals and quantity edits',async()=>{
  const p=await prepare('无',{automatic:true}),original=(await forms.read(p.designer,p.sourceId)).document!;
  const source=await identity.createSource(p.designer,{developmentType:'头版',designStyleNo:'TEST-QUOTE-DEPS-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const resource={kind:'source' as const,id:source.sourceId},quotes=new DigitalQuotationService(f.db,true);
  let document={...original,orderDate:null,files:[]},saved=await forms.save(p.designer,source.sourceId,{expectedVersion:0,document},randomUUID());
  let q=await quotes.read(p.designer,resource);
  q=await quotes.save(p.designer,resource,{expectedVersion:q.version,document:q.document!,assignments:q.assignments.map(a=>a.priceRole==='ie_reviewer'?{...a,priceAssigneeId:person('ie').actorId}:{...a,technicalAssigneeId:p.worker.actorId})},randomUUID());
  q=await quotes.fillRow(p.worker,resource,p.materialId,{expectedVersion:q.version,consumption:'1.5'},randomUUID());
  q=await quotes.read(p.designer,resource);
  const ie=q.rows.find(r=>r.assignment.priceRole==='ie_reviewer')!;
  q=await quotes.fillRow(person('ie'),resource,ie.rowId,{expectedVersion:q.version,unitPrice:'10'},randomUUID());
  // Recreate the genuinely deployed v1 provenance, not an invented new basis.
  const row=(await f.db.query('SELECT assembly,assignments FROM digital_quotation_documents WHERE source_id=$1',[source.sourceId])).rows[0];
  const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  for(const [id,ref] of Object.entries(row.assembly.rows) as Array<[string,{kind:string;sourceRef:string;basis:string;dependencyVersion?:number}]>){
   delete ref.dependencyVersion;
   const assigned=row.assignments.find((a:{rowId:string})=>a.rowId===id);
   ref.basis=ref.kind==='material'?hash([1,id,document.materials[0]!.name,document.materials[0]!.specification,'米',technicalDocumentFingerprint(document),assigned.technicalAssigneeId])
    :hash([1,ref.sourceRef,technicalDocumentFingerprint(document),null,assigned.priceAssigneeId]);
  }
  await f.db.query('UPDATE digital_quotation_documents SET assembly=$2 WHERE source_id=$1',[source.sourceId,JSON.stringify(row.assembly)]);
  document={...document,craft:'印花'};
  saved=await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document},randomUUID());
  q=await quotes.read(p.designer,resource);
  expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.consumption).toBe('1.5');
  expect(q.document!.rows.find(r=>r.rowId===ie.rowId)!.unitPrice).toBe('10');
  const printing=q.document!.rows.find(r=>r.name==='印花')!;expect(printing.unitPrice).toBe('');
  // Supply the existing native assignment fixture; quote commands cannot assign crafts.
  await f.db.query(`INSERT INTO digital_development_round_arrangements(source_id,round_number,version,entries,manager_id,changed_by,document_version)
   VALUES($1,1,1,$2,$3,$3,$4)`,[source.sourceId,JSON.stringify({development_printing:p.worker.actorId}),f.root.actorId,saved.version]);
  saved=await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document},randomUUID());
  q=await quotes.read(p.designer,resource);
  q=await quotes.fillRow(p.worker,resource,printing.rowId,{expectedVersion:q.version,unitPrice:'5'},randomUUID());
  q=await quotes.fillRow(p.worker,resource,p.materialId,{expectedVersion:q.version,consumption:'2'},randomUUID());
  q=await quotes.read(p.designer,resource);expect(calculateBudget(q.document!).cost).toBe('55');
  expect(q.document!.rows.find(r=>r.rowId===ie.rowId)!.unitPrice).toBe('10');
  expect(q.document!.rows.find(r=>r.rowId===printing.rowId)!.unitPrice).toBe('5');
  document={...document,craft:'印绣花'};
  saved=await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document},randomUUID());
  q=await quotes.read(p.designer,resource);
  expect(q.document!.rows.find(r=>r.rowId===printing.rowId)!.unitPrice).toBe('5');
  expect(q.document!.rows.find(r=>r.name==='绣花')!.unitPrice).toBe('');
  expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.consumption).toBe('2');
  expect(q.document!.rows.find(r=>r.rowId===ie.rowId)!.unitPrice).toBe('10');
  document={...document,craft:'绣花'};
  saved=await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document},randomUUID());
  q=await quotes.read(p.designer,resource);expect(q.document!.rows.some(r=>r.rowId===printing.rowId)).toBe(false);
  document={...document,craft:'印绣花'};
  await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document},randomUUID());
  q=await quotes.read(p.designer,resource);expect(q.document!.rows.find(r=>r.rowId===printing.rowId)!.unitPrice).toBe('');
  expect(q.document!.rows.find(r=>r.rowId===ie.rowId)!.unitPrice).toBe('10');
  expect(q.document!.rows.find(r=>r.rowId===p.materialId)!.consumption).toBe('2');
 });

 it('P01 captures sewing readiness at actual late-material verification before assignment and retains correction/restore history',async()=>{
  const scene=await f.scene('2026-11-09T08:00:00.000Z');
  const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
  const p=await run(async()=>{
   const current=await prepare('无',{missingAccessory:true,assignSewing:false}),published=await artifact(current);
   await execution.complete(current.worker,current.sourceId,{taskId:current.paper.taskId,attachmentIds:[],artifactRef:{id:published.artifactSetId,version:published.version,scopeRef:'整款'},note:'TEST paper'},randomUUID());
   const cut=(await execution.read(f.root,current.sourceId)).tasks.find(t=>t.taskKind==='development_cutting')!;
   await execution.complete(current.worker,current.sourceId,{taskId:cut.taskId,attachmentIds:[],note:'TEST cut before accessories'},randomUUID());
   return current;
  });
  const sewingId=(await run(()=>execution.read(f.root,p.sourceId))).tasks.find(t=>t.taskKind==='development_sewing')!.taskId;
  const readiness=async()=>(await nativeTaskReadiness(f.db,[sewingId])).get(sewingId)!;
  expect(await readiness()).toMatchObject({tracked:true,eventId:null,firstReadyAt:null});
  await f.advance(scene,'2026-11-09T09:00:00.000Z');
  await run(async()=>{
   const sheet=await forms.read(p.designer,p.sourceId);
   await forms.materialEvent(p.designer,p.sourceId,p.accessoryId!,{expectedVersion:sheet.version,expectedMaterialRevision:0,action:'到货',expectedDate:null,note:'TEST designer delivery is not clerk verification'},randomUUID());
   await execution.read(f.root,p.sourceId);await execution.read(f.root,p.sourceId);
  });
  expect(await readiness()).toMatchObject({eventId:null,firstReadyAt:null});
  await f.advance(scene,'2026-11-09T12:00:00.000Z');
  await run(async()=>{
   const check=await execution.supplementCheck(f.root,p.sourceId,p.checkTaskId,randomUUID()),state=await execution.read(f.root,p.sourceId);
   const entries=[p.materialId,p.accessoryId!].map(materialId=>({materialId,usage:'use' as const,physical:true,quantity:true,color:true,specification:true,note:'TEST clerk confirms physical availability now',confirmedWith:''}));
   const saved=await execution.saveMaterials(f.root,p.sourceId,{taskId:check.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries,note:'TEST full current material conjunction',result:'通过'},randomUUID());
   await execution.check(f.root,p.sourceId,{taskId:check.taskId,result:'通过',expectedVerificationVersion:saved.version,note:'TEST late auxiliary verified',items:entries.map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());
  });
  const first=await readiness();expect(first).toMatchObject({tracked:true,firstReadyAt:'2026-11-09T12:00:00.000Z',quality:'现场登记'});expect(first.eventId).toBeTruthy();
  expect((await f.db.query('SELECT assignee_id FROM digital_production_task_access WHERE task_id=$1',[sewingId])).rows[0].assignee_id).toBeNull();
  expect((await f.db.query('SELECT 1 FROM digital_production_event_intents WHERE event_id=$1',[first.eventId])).rowCount).toBe(0);
  await f.advance(scene,'2026-11-09T13:00:00.000Z');
  await run(async()=>{
   const state=await execution.read(f.root,p.sourceId),arrangement=state.arrangement!;
   await execution.arrange(f.root,p.sourceId,{roundNumber:1,expectedDocumentVersion:state.sheet.version,expectedVersion:arrangement.version,management:'keep',managementReason:'',entries:arrangement.rows.map(row=>({kind:row.kind as typeof DEVELOPMENT_ARRANGEABLE_KINDS[number],assigneeId:row.kind==='development_sewing'?p.worker.actorId:row.assigneeId,expectedTask:row.taskId?{taskId:row.taskId,state:row.state!,assigneeId:row.assigneeId}:null,reason:'TEST assign after already ready'}))},randomUUID());
   expect((await tasks.read(f.root,sewingId)).enteredAt).toBe(first.firstReadyAt);
   await expect(tasks.correctTime(p.worker,sewingId,{eventId:first.eventId!,occurredAt:null,reason:'TEST worker cannot change readiness'},randomUUID())).rejects.toMatchObject({statusCode:403});
   await tasks.controlResource(f.root,{kind:'source',id:p.sourceId},'pause','TEST ordinary pause',randomUUID());
   await tasks.controlResource(f.root,{kind:'source',id:p.sourceId},'resume','TEST ordinary restore',randomUUID());
  });
  expect(await readiness()).toEqual(first);
  await run(()=>tasks.correctTime(f.root,sewingId,{eventId:first.eventId!,occurredAt:null,reason:'TEST authorized original occurrence is explicitly unknown'},randomUUID()));
  await run(async()=>{
   await tasks.controlResource(f.root,{kind:'source',id:p.sourceId},'pause','TEST pause after explicit unknown',randomUUID());
   await tasks.controlResource(f.root,{kind:'source',id:p.sourceId},'resume','TEST restoring does not manufacture missing readiness',randomUUID());
  });
  expect(await readiness()).toMatchObject({eventId:first.eventId,firstReadyAt:null,quality:'缺失'});
  expect((await f.db.query("SELECT 1 FROM digital_production_task_events WHERE task_id=$1 AND payload->'nativeReadiness'->>'version'='1'",[sewingId])).rowCount).toBe(1);
 });

 it('applies the actual0268schema and keeps source creation sizes optional',async()=>{
  const p=await prepare();expect(p.paper.state).toBe('ready');
  const read=await technical.read(p.designer,p.sourceId);expect(read.enrolled).toBe(true);expect(read.cycle?.allowedSeconds).toBe(7*86400);
  expect((await forms.read(p.designer,p.sourceId)).document?.sizes).toEqual([]);
  await expect(execution.complete(p.worker,p.sourceId,{taskId:p.paper.taskId,note:'图片不等于PLT',attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await tasks.read(p.worker,p.paper.taskId)).state).toBe('ready');
 });
 it('publishes real scopedPLT+usage+base sizes, forbids foreign files and releases cutting parallel to design positioning',async()=>{
  const p=await prepare('印花'),published=await artifact(p);
  const input={taskId:p.paper.taskId,note:'TEST actual paper complete',attachmentIds:[],artifactRef:{id:published.artifactSetId,version:published.version,scopeRef:'整款'}},key=randomUUID();
  await execution.complete(p.worker,p.sourceId,input,key);await execution.complete(p.worker,p.sourceId,input,key);
  const read=await execution.read(f.root,p.sourceId);expect(read.tasks.find(t=>t.taskKind==='development_cutting')?.state).toBe('ready');
  expect(read.tasks.find(t=>t.taskKind==='development_positioning')?.state).toBe('ready');
  expect(read.facts.filter(r=>r.kind==='纸样完成')).toHaveLength(1);
  const plt=(await technical.read(p.worker,p.sourceId)).artifacts[0]!.body.pltAttachmentIds[0]!;
  expect(await forms.canDownload(p.designer,p.sourceId,plt)).toBe(true);
  await f.attachments.createDownloadIntent(p.designer,plt,row=>forms.canDownload(p.designer,p.sourceId,row.attachmentId),'inline');
  await expect(f.attachments.createDownloadIntent(person('qc'),plt,async()=>false)).rejects.toMatchObject({statusCode:403});
  const other=await prepare(),foreign=(await technical.read(p.worker,p.sourceId)).artifacts[0]!;
  await expect(artifact(other,{body:{...foreign.body,consumptionRows:[{materialId:other.materialId,unit:'米',consumption:'1'}]}})).rejects.toMatchObject({statusCode:403});
 });
 it('does not create a review for intermediate feedback; every final version needs its own explicit reuse',async()=>{
  const p=await prepare(),published=await artifact(p);
  const intermediate=await technical.recordComment(p.designer,p.sourceId,comment(0,false),randomUUID());expect(intermediate.reviewTaskId).toBeNull();
  const final=await technical.recordComment(p.designer,p.sourceId,comment(1),randomUUID());expect(final.reviewTaskId).not.toBeNull();
  const initial=await technical.read(p.worker,p.sourceId);expect(initial.effective?.state).toBe('pending_review');
  const task=await tasks.read(p.worker,final.reviewTaskId!);expect(task.slaHours).toBe(24);expect(task.dueAt).not.toBeNull();
  await expect(technical.completeReview(p.designer,p.sourceId,{taskId:final.reviewTaskId!,expectedReviewVersion:1,finalCommentId:final.commentId,finalCommentVersion:final.version,decision:'reuse',artifactSetId:published.artifactSetId,artifactVersion:published.version,note:'无权设计不能代技术确认'},randomUUID())).rejects.toMatchObject({statusCode:404});
  const input={taskId:final.reviewTaskId!,expectedReviewVersion:1,finalCommentId:final.commentId,finalCommentVersion:final.version,decision:'reuse' as const,artifactSetId:published.artifactSetId,artifactVersion:published.version,note:'TEST逐项核对无变化，明确沿用'},key=randomUUID();
  await technical.completeReview(p.worker,p.sourceId,input,key);await technical.completeReview(p.worker,p.sourceId,input,key);
  expect((await technical.read(p.worker,p.sourceId)).effective?.state).toBe('effective');
  const next=await technical.recordComment(p.designer,p.sourceId,comment(2),randomUUID());expect(next.reviewTaskId).not.toBe(final.reviewTaskId);
  const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development'}});
  const reviewWindows=calculation.current.rows.filter(row=>row.id.startsWith('final-comment:'));expect(reviewWindows).toHaveLength(2);expect(reviewWindows.every(row=>row.minutes===1440&&row.independent)).toBe(true);expect(reviewWindows.find(row=>row.source.includes(final.reviewTaskId!))!.basis).toBe('actual');expect(reviewWindows.find(row=>row.source.includes(next.reviewTaskId!))!.basis).toBe('standard');
  expect((await technical.read(p.worker,p.sourceId)).effective?.state).toBe('pending_review');
  const projected=await nodeMaterialsFixture(f.db,f.root,p.sourceId,'development_size_review',next.reviewTaskId!);expect(projected.data.rows.find(r=>r.id==='technical-basis')).toMatchObject({state:'stale',versionLabel:expect.stringContaining('成果 v1')});
  const oldDue=(await tasks.read(f.root,next.reviewTaskId!)).dueAt;
  await tasks.reassign(f.root,next.reviewTaskId!,p.worker.actorId,randomUUID());
  expect((await tasks.read(p.worker,next.reviewTaskId!)).dueAt).toBe(oldDue);
  await expect(execution.customerSample(p.designer,p.sourceId,{routeVersion:1,note:'旧接口不能跳过新复核'},randomUUID())).rejects.toMatchObject({statusCode:409});
 });
 it('keeps the active final comment visible after more than100intermediate comments',async()=>{
  const p=await prepare(),published=await artifact(p),final=await technical.recordComment(p.designer,p.sourceId,comment(),randomUUID());
  for(let version=1;version<=100;version++)await technical.recordComment(p.designer,p.sourceId,comment(version,false),randomUUID());
  const state=await technical.read(p.worker,p.sourceId);
  expect(state.comments.find(c=>c.commentId===final.commentId)).toMatchObject({isFinal:true,version:1,reviewTaskId:final.reviewTaskId});
  expect(state.effective?.finalCommentRef).toEqual({id:final.commentId,version:1});
  await technical.completeReview(p.worker,p.sourceId,{taskId:final.reviewTaskId!,expectedReviewVersion:1,finalCommentId:final.commentId,finalCommentVersion:1,decision:'reuse',artifactSetId:published.artifactSetId,artifactVersion:published.version,note:'TEST current final remains actionable'},randomUUID());
  expect((await technical.read(p.worker,p.sourceId)).effective?.state).toBe('effective');
 });
 it('Final10 projects explicit customer occurrence through the effective technical reference and clears it when that reference changes',async()=>{
  const scene=await f.scene('2026-10-20T12:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const p=await prepare(),published=await artifact(p),occurredAt='2026-10-20T10:00:00.000Z';
   const first=await technical.recordComment(p.designer,p.sourceId,{...comment(),occurredAt},randomUUID());
   const review=async(final:typeof first)=>technical.completeReview(p.worker,p.sourceId,{taskId:final.reviewTaskId!,expectedReviewVersion:1,finalCommentId:final.commentId,finalCommentVersion:final.version,decision:'reuse',artifactSetId:published.artifactSetId,artifactVersion:published.version,note:'TEST explicit original technical review'},randomUUID());
   await review(first);
   const style=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[p.sourceId])).rows[0].design_style_no;
   const order=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,orderDate:'2026-10-20',lines:[{poNumber:'TEST-CUSTOMER-OCCURRENCE',color:'黑',sizes:[{size:'M',quantity:10}],deliveryDate:'2027-03-01'}]}),randomUUID(),p.sourceId);
   const journey=new DigitalJourneyQuery(f.db),read=async()=>(await journey.read(f.root,order.productionOrderId,undefined,true)).stages.flatMap(stage=>stage.nodes).find(node=>node.key==='customer_sample'&&node.current)!;
   expect(await read()).toMatchObject({state:'completed',actualAt:occurredAt,actualQuality:'unverified',completionResult:'unknown'});
   const next=await technical.recordComment(p.designer,p.sourceId,comment(1),randomUUID());
   expect(await read()).toMatchObject({state:'pending',actualAt:null,actualQuality:'missing'});
   await review(next);
   expect(await read()).toMatchObject({state:'completed',actualAt:null,actualQuality:'missing'});
  });
 });
 it('supplements only the original missing customer occurrence, preserving completed review, technical facts, authorization and date precision',async()=>{
  const scene=await f.scene('2026-11-15T04:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const p=await prepare(),published=await artifact(p),final=await technical.recordComment(p.designer,p.sourceId,comment(),randomUUID());
   await technical.completeReview(p.worker,p.sourceId,{taskId:final.reviewTaskId!,expectedReviewVersion:1,finalCommentId:final.commentId,finalCommentVersion:final.version,decision:'reuse',artifactSetId:published.artifactSetId,artifactVersion:published.version,note:'TEST completed before time supplement'},randomUUID());
   const original=(await f.db.query('SELECT * FROM digital_development_final_comments WHERE comment_id=$1',[final.commentId])).rows;
   const review=(await tasks.read(f.root,final.reviewTaskId!)),validity=(await technical.read(p.worker,p.sourceId)).effective;
   const body={commentId:final.commentId,commentVersion:final.version,actualTime:{precision:'date' as const,date:'2026-11-14'},note:'TEST original dated customer message'},keys=[randomUUID(),randomUUID()];
   await expect(technical.supplementCommentTime(p.worker,p.sourceId,body,randomUUID())).rejects.toMatchObject({statusCode:403});
   await expect(technical.supplementCommentTime(p.designer,p.sourceId,{...body,commentVersion:99},randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(technical.supplementCommentTime(p.designer,p.sourceId,{...body,actualTime:{precision:'date',date:'2026-11-16'}},randomUUID())).rejects.toMatchObject({statusCode:409});
   const attempted=await Promise.allSettled(keys.map(key=>technical.supplementCommentTime(p.designer,p.sourceId,body,key)));
   expect(attempted.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect(attempted.filter(value=>value.status==='rejected')).toHaveLength(1);
   const winner=attempted.findIndex(value=>value.status==='fulfilled');
   expect(await technical.supplementCommentTime(p.designer,p.sourceId,body,keys[winner]!)).toEqual((attempted[winner] as PromiseFulfilledResult<unknown>).value);
   expect((await f.db.query('SELECT * FROM digital_development_final_comments WHERE comment_id=$1',[final.commentId])).rows).toEqual(original);
   expect(await tasks.read(f.root,final.reviewTaskId!)).toEqual(review);expect((await technical.read(p.worker,p.sourceId)).effective).toEqual(validity);
   expect((await f.db.query('SELECT 1 FROM digital_development_size_review_requests WHERE final_comment_id=$1',[final.commentId])).rowCount).toBe(1);
   expect((await technical.read(p.designer,p.sourceId)).comments.find(row=>row.commentId===final.commentId)).toMatchObject({occurredAt:null,occurredDate:'2026-11-14',timeEvidence:{note:body.note,recordedAt:'2026-11-15T04:00:00.000Z'}});
   const history=await technical.history(p.designer,p.sourceId,{roundNumber:1,scopeRef:'整款',kind:'comments',version:final.version});expect(history.items[0]).toMatchObject({occurredAt:null,occurredDate:'2026-11-14'});
   const style=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[p.sourceId])).rows[0].design_style_no;
   const order=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',requiresColorMatching:false,designStyleNo:style,orderDate:'2026-11-15',lines:[{poNumber:'TEST dated approval',color:'黑',customerWarehouseArrivalDate:'2027-03-15',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),p.sourceId);
   const node=(await new DigitalJourneyQuery(f.db).read(f.root,order.productionOrderId,undefined,true)).stages.flatMap(stage=>stage.nodes).find(row=>row.key==='customer_sample'&&row.current)!;
   expect(node).toMatchObject({state:'completed',actualAt:null,actualDate:'2026-11-14',actualQuality:'unverified'});
   const facts=await readSeriesPlanFacts(f.db,order.productionOrderId,p.sourceId,'PD',1);expect(facts.facts.find(row=>row.key==='client_sample_approval')).toMatchObject({completed:true,occurredAt:null,occurredDate:'2026-11-14',precision:'date'});
   await expect(f.db.query("UPDATE digital_development_comment_times SET occurred_date='2026-11-13' WHERE comment_id=$1",[final.commentId])).rejects.toThrow();
   await expect(technical.supplementCommentTime(p.designer,p.sourceId,{...body,actualTime:{precision:'instant',at:'2026-11-14T03:00:00Z'}},randomUUID())).rejects.toMatchObject({statusCode:409});
  });
 });
 it('records date/current customer occurrences at their original action without inventing missing or changing review registration clocks',async()=>{
  const scene=await f.scene('2026-11-15T04:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const p=await prepare();
   const dated=await technical.recordComment(p.designer,p.sourceId,{...comment(),actualTime:{precision:'date',date:'2026-11-14'}},randomUUID());
   const first=(await technical.read(p.designer,p.sourceId)).comments.find(row=>row.commentId===dated.commentId)!;
   expect(first).toMatchObject({occurredAt:null,occurredDate:'2026-11-14',recordedAt:'2026-11-15T04:00:00.000Z'});
   expect((await tasks.read(f.root,dated.reviewTaskId!)).enteredAt).toBe('2026-11-15T04:00:00.000Z');
   const now=await technical.recordComment(p.designer,p.sourceId,{...comment(1),actualTime:{precision:'current'}},randomUUID());
   expect((await technical.read(p.designer,p.sourceId)).comments.find(row=>row.commentId===now.commentId)).toMatchObject({occurredAt:'2026-11-15T04:00:00.000Z',occurredDate:null});
  });
 });
 it('adopts only an explicitly selected same-source same-unit technical usage; confirmation remains frozen',async()=>{
  const p=await prepare(),published=await artifact(p),quotes=new DigitalQuotationService(f.db,true),resource={kind:'source' as const,id:p.sourceId},rowId=randomUUID();
  const document={fabricType:'梭织',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币' as const,rows:[{rowId,section:'主料' as const,category:'',name:'TEST棉布',specification:'TEST40支',unit:'米',supplier:'TEST',consumption:'',unitPrice:'10'}],freight:'0',cm:'0',salePrice:'',outsourcingScope:'',outsourcingUnitPrice:'',imageAttachmentIds:[]};
  const saved=await quotes.save(p.designer,resource,{expectedVersion:0,document,assignments:[{rowId,technicalAssigneeId:p.worker.actorId,priceAssigneeId:p.designer.actorId,priceRole:'sample_designer'}]},randomUUID());
  const technicalRead=await quotes.read(p.worker,resource);expect(technicalRead.fullCost).toBe(false);expect(technicalRead.technicalConsumptionOptions).toMatchObject([{materialId:p.materialId,artifactSetId:published.artifactSetId,artifactVersion:1,consumption:'1.250000'}]);
  await expect(quotes.fillRow(p.designer,resource,rowId,{expectedVersion:saved.version,artifactConsumption:{id:published.artifactSetId,version:1,materialId:p.materialId}},randomUUID())).rejects.toMatchObject({statusCode:403});
  const filled=await quotes.fillRow(p.worker,resource,rowId,{expectedVersion:saved.version,artifactConsumption:{id:published.artifactSetId,version:1,materialId:p.materialId}},randomUUID());
  expect(filled.rows[0]?.consumption).toBe('1.250000');expect(filled.rows[0]?.consumptionSource?.kind).toBe('technical_artifact');
  const old=await technical.read(p.worker,p.sourceId),body={...old.artifacts[0]!.body,consumptionRows:[{materialId:p.materialId,unit:'米',consumption:'2'}]};
  await technical.saveArtifact(p.worker,p.sourceId,{taskId:p.paper.taskId,expectedDocumentVersion:p.documentVersion,expectedVersion:1,scopeRef:'整款',action:'publish',body},randomUUID());
  expect((await quotes.read(p.worker,resource)).rows[0]?.consumption).toBe('1.250000');
  await expect(quotes.fillRow(p.worker,resource,rowId,{expectedVersion:filled.version,artifactConsumption:{id:published.artifactSetId,version:1,materialId:p.materialId}},randomUUID())).rejects.toMatchObject({statusCode:409});
  const other=await prepare(),foreign=await artifact(other);
  await expect(quotes.fillRow(p.worker,resource,rowId,{expectedVersion:filled.version,artifactConsumption:{id:foreign.artifactSetId,version:1,materialId:other.materialId}},randomUUID())).rejects.toMatchObject({statusCode:409});
 });
 it('does not let workers approve urgency; approval keeps the publication anchor and original history',async()=>{
  const p=await prepare(),before=await technical.read(p.designer,p.sourceId);
  await technical.urgent(p.designer,p.sourceId,{roundNumber:1,expectedRevision:0,action:'request',reason:'TEST真实加急'},randomUUID());
  await expect(technical.urgent(p.worker,p.sourceId,{roundNumber:1,expectedRevision:1,action:'approve',reason:'无权代批'},randomUUID())).rejects.toMatchObject({statusCode:403});
  await technical.urgent(person('production-management'),p.sourceId,{roundNumber:1,expectedRevision:1,action:'approve',reason:'TEST供应链总监审批板房加急'},randomUUID());
  const after=await technical.read(p.designer,p.sourceId);expect(after.cycle?.allowedSeconds).toBe(5*86400);expect(after.cycle?.publishedAt).toBe(before.cycle?.publishedAt);
 });
 const sampleToTail=async(options:Parameters<typeof prepare>[1]={})=>{
  const p=await prepare('无',options),published=await artifact(p);
  await execution.complete(p.worker,p.sourceId,{taskId:p.paper.taskId,attachmentIds:[],artifactRef:{id:published.artifactSetId,version:published.version,scopeRef:'整款'},note:'TEST actual paper'},randomUUID());
  const cut=(await execution.read(f.root,p.sourceId)).tasks.find(t=>t.taskKind==='development_cutting')!;
  await execution.complete(p.worker,p.sourceId,{taskId:cut.taskId,attachmentIds:[],note:'TEST actual cut'},randomUUID());
  const sewing=(await execution.read(f.root,p.sourceId)).tasks.find(t=>t.taskKind==='development_sewing')!;
  const photo=await f.image(p.worker);await execution.recordUploadPurpose(p.worker,p.sourceId,photo,'车板成果',sewing.taskId);
  await execution.route(p.worker,p.sourceId,{taskId:sewing.taskId,note:'TEST实际车板完成',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo]},randomUUID());
  const tail=(await execution.read(f.root,p.sourceId)).tasks.find(t=>t.taskKind==='development_tail_check')!;
  return {...p,tail};
 };
 it('PR03 retains completed material verification on a supervisor sewing-only remake while prices stay hidden and persisted',async()=>{
  const p=await sampleToTail({automatic:true}),supervisor=person('pattern-room-supervisor');
  const before=await forms.read(p.designer,p.sourceId),hidden=await forms.read(supervisor,p.sourceId);
  expect(hidden.canEdit).toBe(false);expect(hidden.document!.materials[0]!.unitPrice).toBeUndefined();
  const revision={basedOnRound:1,document:before.document!,origin:'内部发现' as const,customerComment:'',internalProblem:'TEST只重做车缝',explanation:'TEST不变的材料不能重新核配',categories:['车缝' as const],affectedNodes:['车板' as const],outputKind:'整件样板' as const};
  // The preview and native publication use this same reader; price-only
  // differences must not reopen physical work or mutate the saved document.
  const preview=await readDevelopmentRevisionPlan(f.db,p.sourceId,revision,hidden.document!);
  expect(preview.affectedNodes).not.toContain('核配');expect(preview.inherited.development_materials?.taskId).toBe(p.checkTaskId);
  const repriced=structuredClone(revision);repriced.document.materials[0]!.unitPrice='21';
  expect((await readDevelopmentRevisionPlan(f.db,p.sourceId,repriced,before.document!)).route).not.toContain('development_materials');
  const changed=structuredClone(revision);changed.document.materials[0]!.width='155';
  expect((await readDevelopmentRevisionPlan(f.db,p.sourceId,changed,before.document!)).route).toContain('development_materials');
  const orderId=(await f.db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[p.sourceId])).rows[0].order_id;
  const order=await native.get(supervisor,orderId),key=randomUUID(),input={version:order.version,roundId:order.currentRoundId,reason:'TEST仅车缝返工',reasonCategory:'other',attachmentIds:[],developmentNodes:['车板'],developmentProblems:['车缝'],developmentMaking:{expectedDocumentVersion:p.documentVersion,quantities:[1]}};
  await native.requestRework(supervisor,orderId,input,key);await native.requestRework(supervisor,orderId,input,key);
  const recorded=(await f.db.query('SELECT document,route_nodes,inherited,affected_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=2',[p.sourceId])).rows[0];
  expect(recorded.route_nodes).not.toContain('development_materials');expect(recorded.affected_nodes).not.toContain('核配');
  expect(recorded.inherited.development_materials).toMatchObject({taskId:p.checkTaskId,roundNumber:1});
  expect(recorded.document.materials[0]).toMatchObject({materialId:p.materialId,unitPrice:'20'});
  expect((await forms.read(p.designer,p.sourceId)).document!.materials[0]!.unitPrice).toBe('20');
  expect((await forms.read(supervisor,p.sourceId)).document!.materials[0]!.unitPrice).toBeUndefined();
  expect((await f.db.query("SELECT count(*)::int n FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.source_id=$1 AND t.route_version=2 AND a.task_kind IN ('development_materials','development_material_recheck')",[p.sourceId])).rows[0].n).toBe(0);
 });
 it('R5 binds a newly submitted first native order to the actual later development round, without inventing a historical link',async()=>{
  const p=await prepare('无',{withoutNative:true}),old=await forms.read(p.designer,p.sourceId),rounds=new DevelopmentRoundService(f.db,true,native);
  const saved=await rounds.save(p.designer,p.sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:old.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST首个原执行尚未生成前的资料复版',explanation:'TEST真实首次衔接',categories:['版型'],affectedNodes:['纸样'],outputKind:'整件样板'}},randomUUID());
  await rounds.publish(p.designer,p.sourceId,{expectedDraftVersion:saved.draftVersion,basedOnRound:1},randomUUID());
  const created=await execution.patternOrder(p.designer,p.sourceId,category,randomUUID()),order=await native.get(p.designer,created.orderId);
  const client=await f.db.connect();try{
   expect(await developmentNativeRound(client,p.sourceId,2)).toBe(order.currentRoundId);
   expect(await developmentNativeRound(client,p.sourceId,1)).toBeNull();
  }finally{client.release();}
  expect(order.rounds).toHaveLength(1);expect(order.status).toBe('pending_assignment');
 });
 const confirmSample=async(p:Awaited<ReturnType<typeof sampleToTail>>)=>{
  const current=(await forms.read(f.root,p.sourceId)).roundNumber??1;
  const tail=(await execution.read(f.root,p.sourceId)).tasks.find(t=>t.taskKind==='development_tail_check'&&t.routeVersion===current)!;
  const photo=await f.image(f.root);await execution.recordUploadPurpose(f.root,p.sourceId,photo,'尾查照片',tail.taskId);
  await execution.route(f.root,p.sourceId,{taskId:tail.taskId,note:'TEST真实尾查通过',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo],measurements:[{name:'胸围',values:['48']}]},randomUUID());
  const confirmation=(await execution.read(p.designer,p.sourceId)).tasks.find(t=>t.taskKind==='development_confirmation'&&t.routeVersion===current)!;
  const input={taskId:confirmation.taskId,note:'TEST设计师实际确认本轮',result:'通过' as const,craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null},key=randomUUID();
  await execution.route(p.designer,p.sourceId,input,key);await execution.route(p.designer,p.sourceId,input,key);
 };
 it.each([{confirmFirst:true,amount:'7',total:'17.00',reasonLength:2000},{confirmFirst:false,amount:'0',total:'10.00',reasonLength:2001},{confirmFirst:true,amount:'7',total:'17.00',reasonLength:4000}])('R5 creates a separate native whole remake and uses only its explicitly approved amount ($amount, revision $reasonLength)',async({confirmFirst,amount,total,reasonLength})=>{
  const p=await sampleToTail();if(confirmFirst)await confirmSample(p);
  const orderId=(await f.db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[p.sourceId])).rows[0].order_id;
  const initial=(await native.get(f.root,orderId)).currentRoundId;
  const rounds=new DevelopmentRoundService(f.db,true,native),old=await forms.read(p.designer,p.sourceId);
  const revision={basedOnRound:1,document:{...old.document!,instructions:'TEST第二轮实际制作说明，保留完整修订资料'},origin:'内部发现' as const,customerComment:'',internalProblem:'改'.repeat(reasonLength),explanation:'TEST独立制作，不借旧工资',categories:['车缝' as const],affectedNodes:['裁板' as const,'车板' as const],outputKind:'整件样板' as const};
  const saved=await rounds.save(p.designer,p.sourceId,{expectedDraftVersion:0,revision},randomUUID()),key=randomUUID(),input={expectedDraftVersion:saved.draftVersion,basedOnRound:1};
  await rounds.publish(p.designer,p.sourceId,input,key);await rounds.publish(p.designer,p.sourceId,input,key);
  let order=await native.get(f.root,orderId);expect(order.currentRoundId).not.toBe(initial);const remake=order.currentRoundId;
  expect(order.status).toBe('pending_assignment');
  expect((await forms.read(p.designer,p.sourceId)).document!.instructions).toBe(revision.document.instructions);
  expect((await f.db.query('SELECT request_reason FROM pattern_room_rounds WHERE round_id=$1',[remake])).rows[0].request_reason).toBe(revision.internalProblem.slice(0,2000));
  expect((await f.db.query('SELECT internal_problem,explanation FROM digital_development_rounds WHERE source_id=$1 AND round_number=2',[p.sourceId])).rows[0]).toEqual({internal_problem:revision.internalProblem,explanation:revision.explanation});
  expect((await f.db.query('SELECT round_type,agreed_amount FROM pattern_room_rounds WHERE round_id=$1',[remake])).rows[0]).toEqual({round_type:'rework',agreed_amount:null});
  const personId=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1',[p.worker.actorId])).rows[0].person_id;
  await expect(native.assign(f.root,orderId,{roundId:remake,version:order.version,personId},randomUUID())).rejects.toMatchObject({statusCode:400});
  order=await native.assign(f.root,orderId,{roundId:remake,version:order.version,personId,amount},randomUUID());
  await arrangeTestRound(f.db,execution,f.root,p.sourceId,p.worker.actorId);
  const cut=(await execution.read(p.worker,p.sourceId)).tasks.find(t=>t.taskKind==='development_cutting'&&t.routeVersion===2)!;
  await execution.complete(p.worker,p.sourceId,{taskId:cut.taskId,attachmentIds:[],note:'TEST第二轮实际裁板'},randomUUID());
  const sewing=(await execution.read(p.worker,p.sourceId)).tasks.find(t=>t.taskKind==='development_sewing'&&t.routeVersion===2)!,photo=await f.image(p.worker);
  await execution.recordUploadPurpose(p.worker,p.sourceId,photo,'车板成果',sewing.taskId);
  const sewInput={taskId:sewing.taskId,note:'TEST第二轮实际车板',result:'通过' as const,craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo]},sewKey=randomUUID();
  await execution.route(p.worker,p.sourceId,sewInput,sewKey);await execution.route(p.worker,p.sourceId,sewInput,sewKey);
  expect((await f.db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[remake])).rows[0].n).toBe(0);
  await confirmSample(p);
  const rows=(await f.db.query('SELECT round_id,amount::text,wage_eligible_at FROM pattern_room_segments WHERE round_id=ANY($1::uuid[]) ORDER BY round_id',[[initial,remake]])).rows;
  expect(rows).toHaveLength(2);expect(Number(rows.find(row=>row.round_id===initial).amount)).toBe(10);expect(Number(rows.find(row=>row.round_id===remake).amount)).toBe(Number(amount));
  expect(rows.find(row=>row.round_id===initial).wage_eligible_at).not.toBeNull();
  expect(rows.find(row=>row.round_id===remake).wage_eligible_at===null).toBe(amount==='0');
  const facts=(await f.db.query("SELECT route_version,kind,payload->>'nativeRoundId' native_id FROM digital_development_route_facts WHERE source_id=$1 AND route_version=2 AND kind IN ('车板完成','最终设计确认')",[p.sourceId])).rows;
  expect(facts).toHaveLength(2);expect(facts.every(row=>row.native_id===remake)).toBe(true);
  const reporting=new ManagementReportingService(f.db),query=ReportQuerySchema.parse({from:'2026-01-01',to:'2026-12-31',q:old.designStyleNo,limit:100});
  const page=await reporting.report(f.root,'wages',query,1),exported=await reporting.exportData(f.root,'wages',query);
  expect(page.rows).toHaveLength(amount==='0'?1:2);expect(exported.data.rows).toHaveLength(page.rows.length);
  expect(page.totals).toEqual(exported.data.totals);expect(page.totals.wageAmount).toBe(total);
 });
 it.each(['worker','root'] as const)('keeps local patch in the original development round and pays only actual added work (%s)',async recipient=>{
  const p=await sampleToTail(),photo=await f.image(f.root);await execution.recordUploadPurpose(f.root,p.sourceId,photo,'尾查照片',p.tail.taskId);
  await execution.route(f.root,p.sourceId,{taskId:p.tail.taskId,note:'TEST局部袖片破损，原纸样可复用',result:'退回',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo],returnNodes:['车板'],problemCategories:['其他'],measurements:[{name:'胸围',values:['48']}]},randomUUID());
  const pending=await technical.read(f.root,p.sourceId),issue=pending.patches[0]!;expect(issue.decision).toBeNull();expect((await forms.read(f.root,p.sourceId)).roundNumber).toBe(1);
  const key=randomUUID(),decision={issueId:issue.issueId,expectedVersion:1,decision:'patch',reusableArtifacts:true,reason:'TEST技术主管确认局部补片可复用原成果'};
  await expect(technical.decidePatch(p.designer,p.sourceId,decision,key)).rejects.toMatchObject({statusCode:403});
  await technical.decidePatch(f.root,p.sourceId,decision,key);await technical.decidePatch(f.root,p.sourceId,decision,key);
  let order=await native.get(f.root,issue.nativeOrderId!);expect(order.status).toBe('pending_assignment');
  const executor=recipient==='root'?f.root:p.worker;
  const workerPerson=recipient==='root'?(await f.access.createPerson({...f.root,authorizationCapability:'master_data:manage'},{personType:'internal',appUserId:f.root.actorId,displayName:'TEST Root补片本人',aliases:[],reason:'TEST native Root self-work'})).personId:(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1',[p.worker.actorId])).rows[0].person_id;
  order=await native.assign(f.root,order.orderId,{roundId:order.currentRoundId,version:order.version,personId:workerPerson,amount:'3'},randomUUID());
  const patch=(await execution.read(executor,p.sourceId)).tasks.find(t=>t.taskKind==='development_patch')!;expect(patch.state).toBe('ready');
  const pendingCalculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development'}});expect(pendingCalculation.current.rows.find(row=>row.id===`patch-task:${patch.taskId}`)).toMatchObject({kind:'unlimited',minutes:null});
  if(recipient==='root')expect((await f.db.query("SELECT count(*)::int n FROM user_role_assignments WHERE user_id=$1 AND role_code='pattern_room_worker' AND revoked_at IS NULL",[f.root.actorId])).rows[0].n).toBe(0);
  await expect(tasks.reassign(f.root,patch.taskId,p.worker.actorId,randomUUID())).rejects.toMatchObject({statusCode:409});
  const workPhoto=await f.image(executor);await execution.recordUploadPurpose(executor,p.sourceId,workPhoto,'补做成果',patch.taskId);
  await technical.completePatch(executor,p.sourceId,{taskId:patch.taskId,note:'TEST实际新增补片完成',attachmentIds:[workPhoto]},randomUUID());
  const tail=(await execution.read(f.root,p.sourceId)).tasks.find(t=>t.taskKind==='development_patch_tail_check')!,tailPhoto=await f.image(f.root);await execution.recordUploadPurpose(f.root,p.sourceId,tailPhoto,'尾查照片',tail.taskId);
  const tailCalculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development'}});expect(tailCalculation.current.rows.find(row=>row.id===`patch-task:${tail.taskId}`)).toMatchObject({kind:'duration',minutes:30});
  await technical.completePatch(f.root,p.sourceId,{taskId:tail.taskId,note:'TEST补做尾查合格',attachmentIds:[tailPhoto],measurements:[{name:'胸围',values:['48']}]},randomUUID());
  expect((await f.db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[order.currentRoundId])).rows[0].n).toBe(0);
  const confirmation=(await execution.read(p.designer,p.sourceId)).tasks.find(t=>t.taskKind==='development_patch_confirmation')!;
  const confirmInput={taskId:confirmation.taskId,note:'TEST设计实际收到本次补做',attachmentIds:[]},confirmKey=randomUUID();await technical.completePatch(p.designer,p.sourceId,confirmInput,confirmKey);await technical.completePatch(p.designer,p.sourceId,confirmInput,confirmKey);
  expect((await forms.read(f.root,p.sourceId)).roundNumber).toBe(1);
  const wages=(await f.db.query('SELECT amount::text,wage_eligible_at FROM pattern_room_segments WHERE round_id=$1',[order.currentRoundId])).rows;expect(wages).toHaveLength(1);expect(Number(wages[0].amount)).toBe(3);expect(wages[0].wage_eligible_at).not.toBeNull();
  expect((await technical.read(f.root,p.sourceId)).cycle?.completedAt).not.toBeNull();
 });
 it('rejects an internal revision with changed technical basis and no paper path before cancelling the old round',async()=>{
  const p=await sampleToTail({automatic:true}),rounds=new DevelopmentRoundService(f.db,true,native),old=await forms.read(p.designer,p.sourceId),document=structuredClone(old.document!);
  document.materials[0]!.width='155';
  const revision={basedOnRound:1,document,origin:'内部发现' as const,customerComment:'',internalProblem:'TEST主料规格改变须重核技术成果',explanation:'TEST preserve old work on rejection',categories:['面料' as const],affectedNodes:['车板' as const],outputKind:'整件样板' as const};
  const draft=await rounds.save(p.designer,p.sourceId,{expectedDraftVersion:0,revision},randomUUID());
  await expect(rounds.publish(p.designer,p.sourceId,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await forms.read(p.designer,p.sourceId)).roundNumber).toBe(1);expect((await tasks.read(f.root,p.tail.taskId)).state).toBe('ready');
  expect((await rounds.read(p.designer,p.sourceId)).draft?.version).toBe(draft.draftVersion);
  expect((await f.db.query('SELECT count(*)::int n FROM digital_development_rounds WHERE source_id=$1',[p.sourceId])).rows[0].n).toBe(0);
  const next=await rounds.save(p.designer,p.sourceId,{expectedDraftVersion:draft.draftVersion,revision:{...revision,affectedNodes:['纸样','裁板','车板']}},randomUUID());
  await rounds.publish(p.designer,p.sourceId,{expectedDraftVersion:next.draftVersion,basedOnRound:1},randomUUID());
  expect((await forms.read(p.designer,p.sourceId)).roundNumber).toBe(2);
  const finalRound=(await rounds.read(p.designer,p.sourceId)).rounds.at(-1)!;
  expect(finalRound.routeNodes).toContain('development_pattern');expect(finalRound.routeNodes).toContain('development_materials');
  const revised=(await forms.read(p.designer,p.sourceId)).document!.materials[0]!;
  expect(revised.materialId).not.toBe(p.materialId);expect(revised.width).toBe('155');expect(revised.unitPrice).toBe('20');
  expect((await forms.read(p.worker,p.sourceId)).document!.materials[0]!.unitPrice).toBeUndefined();
 });
 it('opens a new development round for a whole/key-result redo without cloning the old wage amount',async()=>{
  const p=await sampleToTail(),photo=await f.image(f.root);await execution.recordUploadPurpose(f.root,p.sourceId,photo,'尾查照片',p.tail.taskId);
  await execution.route(f.root,p.sourceId,{taskId:p.tail.taskId,note:'TEST整件关键成果需重做',result:'退回',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo],returnNodes:['车板'],problemCategories:['其他'],measurements:[{name:'胸围',values:['48']}]},randomUUID());
  const issue=(await technical.read(f.root,p.sourceId)).patches[0]!;
  await technical.decidePatch(f.root,p.sourceId,{issueId:issue.issueId,expectedVersion:1,decision:'new_round',making:{expectedDocumentVersion:p.documentVersion,quantities:[1]},reusableArtifacts:false,reason:'TEST技术主管判定关键成果需要重做'},randomUUID());
  expect((await forms.read(f.root,p.sourceId)).roundNumber).toBe(2);
  const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development',round:2}});expect(calculation.context.identity.round).toBe(2);expect(calculation.context.limitations.join(' ')).toContain('不重走首版全段');
  const order=await native.get(f.root,issue.nativeOrderId!);expect(order.status).toBe('pending_assignment');
  expect((await f.db.query('SELECT agreed_amount FROM pattern_room_rounds WHERE round_id=$1',[order.currentRoundId])).rows[0].agreed_amount).toBeNull();
  expect((await f.db.query('SELECT count(*)::int n FROM digital_development_cycle_rounds WHERE source_id=$1',[p.sourceId])).rows[0].n).toBe(2);
 });
 it('excludes only actual external-paper departure to receipt, never the earlier request timestamp',async()=>{
  const scene=await f.scene('2026-10-24T00:00:00Z');let p:Awaited<ReturnType<typeof prepare>>,request:{requestId:string;taskId:string};
  await f.runtime.run(scene,f.root,async()=>{p=await prepare();});
  const supervisor=person('pattern-room-supervisor');
  await f.advance(scene,'2026-10-24T01:00:00Z');await f.runtime.run(scene,f.root,async()=>{request=await execution.externalPattern(supervisor,p.sourceId,{action:'request',roundNumber:1,note:'TEST真实发出请求'},randomUUID());expect((await technical.read(f.root,p.sourceId)).cycle?.state).toBe('unrated');});
  await f.advance(scene,'2026-10-24T01:15:00Z');await f.runtime.run(scene,f.root,async()=>{await technical.externalPaperInterval(supervisor,p.sourceId,{requestId:request.requestId,expectedVersion:0,departedAt:businessNow().toISOString(),note:'TEST实际将原件交外部处理'},randomUUID());});
  await f.advance(scene,'2026-10-24T02:15:00Z');await f.runtime.run(scene,f.root,async()=>{const cycle=(await technical.read(f.root,p.sourceId)).cycle!;expect(cycle.excludedSeconds).toBe(3600);expect(cycle.internalSeconds).toBe(4500);const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development'}});expect(calculation.current.rows.find(row=>row.id==='development_cycle')!.end.at).toBeNull();});
  await f.advance(scene,'2026-10-24T02:45:00Z');await f.runtime.run(scene,f.root,async()=>{const image=await f.image(supervisor);await execution.recordUploadPurpose(supervisor,p.sourceId,image,'外部纸样');await execution.externalPattern(supervisor,p.sourceId,{action:'receive',requestId:request.requestId,note:'TEST实际收到',attachmentIds:[image]},randomUUID());});
  await f.advance(scene,'2026-10-24T03:00:00Z');await f.runtime.run(scene,f.root,async()=>{const cycle=(await technical.read(f.root,p.sourceId)).cycle!;expect(cycle.excludedSeconds).toBe(5400);expect(cycle.internalSeconds).toBe(5400);
   const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development'}});expect(calculation.current.rows.find(row=>row.id==='development_cycle')!.end.at).toBe(cycle.dueAt);
   const event=(await f.db.query("SELECT event_id FROM digital_production_task_events WHERE task_id=$1 AND event_kind='completed' ORDER BY recorded_at DESC LIMIT 1",[request.taskId])).rows[0];
   await tasks.correctTime(f.root,request.taskId,{eventId:event.event_id,occurredAt:null,reason:'TEST收到时间暂不能核实'},randomUUID());expect((await technical.read(f.root,p.sourceId)).cycle?.state).toBe('unrated');const unknownCalculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development'}});expect(unknownCalculation.current.rows.find(row=>row.id===`external-pattern:${request.requestId}`)!.end.at).toBeNull();
   await tasks.correctTime(f.root,request.taskId,{eventId:event.event_id,occurredAt:'2026-10-24T02:45:00Z',reason:'TEST实际收到已核实'},randomUUID());expect((await technical.read(f.root,p.sourceId)).cycle?.excludedSeconds).toBe(5400);
   const correction={requestId:request.requestId,expectedVersion:1,departedAt:'2026-10-24T01:45:00Z',note:'TEST主管核实首次交出时间录错，保留原v1'};
   await expect(technical.externalPaperInterval(p.worker,p.sourceId,correction,randomUUID())).rejects.toMatchObject({statusCode:403});
   const outcomes=await Promise.allSettled([technical.externalPaperInterval(supervisor,p.sourceId,correction,randomUUID()),technical.externalPaperInterval(supervisor,p.sourceId,correction,randomUUID())]);
   expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
   expect((await technical.read(f.root,p.sourceId)).cycle?.excludedSeconds).toBe(3600);
   const unknown={requestId:request.requestId,expectedVersion:2,departedAt:null,note:'TEST发现真实交出时间暂无依据，明确未知'},unknownKey=randomUUID();
   await technical.externalPaperInterval(supervisor,p.sourceId,unknown,unknownKey);await technical.externalPaperInterval(supervisor,p.sourceId,unknown,unknownKey);
   expect((await technical.read(f.root,p.sourceId)).cycle?.state).toBe('unrated');expect((await tasks.read(f.root,request.taskId)).state).toBe('completed');
   await expect(technical.externalPaperInterval(supervisor,p.sourceId,correction,randomUUID())).rejects.toMatchObject({statusCode:409});
   await technical.externalPaperInterval(supervisor,p.sourceId,{requestId:request.requestId,expectedVersion:3,departedAt:'2026-10-24T01:15:00Z',note:'TEST取得原交出依据后核实恢复'},randomUUID());
   expect((await technical.read(f.root,p.sourceId)).cycle?.excludedSeconds).toBe(5400);
   const history=(await f.db.query('SELECT version,departed_at,time_quality FROM digital_development_external_intervals WHERE interval_id=$1 ORDER BY version',[request.requestId])).rows;
   expect(history.map(r=>[r.version,r.time_quality])).toEqual([[1,'现场登记'],[2,'已核实'],[3,'缺失'],[4,'已核实']]);expect(history[2].departed_at).toBeNull();
   const projection=(await execution.read(supervisor,p.sourceId)).externalPatterns.find(r=>r.requestId===request.requestId)!;
   expect(projection.intervalVersion).toBe(4);expect(projection.departureHistory).toHaveLength(4);
   await expect(f.db.query("UPDATE digital_development_external_intervals SET evidence_note='overwrite' WHERE interval_id=$1",[request.requestId])).rejects.toThrow();
  });
 });
 it('rejects a claimed final fabric before the first actual sample and records unknown high-temperature applicability explicitly',async()=>{
  const p=await prepare();await expect(technical.savePreparationBasis(p.designer,p.sourceId,{roundNumber:1,expectedVersion:0,basis:'first_development',finalFabric:true,finalCraft:false,sampleEvidenceIds:[],customerFabricEvidenceIds:[],note:'TEST不能抢先确认'},randomUUID())).rejects.toMatchObject({statusCode:409});
  await technical.saveMaterialDecision(p.worker,p.sourceId,{roundNumber:1,materialId:p.materialId,expectedVersion:0,highTemperatureRequired:null,basis:'TEST供应商纸面尚未明确，保留未知',supplierEvidenceIds:[],warpShrinkPercent:null,weftShrinkPercent:null},randomUUID());
  expect((await technical.read(p.worker,p.sourceId)).materialDecisions[0]?.highTemperatureRequired).toBeNull();
 });
 it('serializes concurrent final comments and requires a new revised group when the reviewer chooses revise',async()=>{
  const p=await prepare(),original=await artifact(p),calls=await Promise.allSettled([technical.recordComment(p.designer,p.sourceId,comment(),randomUUID()),technical.recordComment(p.designer,p.sourceId,comment(),randomUUID())]);
  expect(calls.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(calls.filter(r=>r.status==='rejected')).toHaveLength(1);
  const state=await technical.read(p.worker,p.sourceId),review=state.reviews[0]!;
  const input={taskId:review.taskId,expectedReviewVersion:1,finalCommentId:review.finalCommentId,finalCommentVersion:review.finalCommentVersion,decision:'revise',artifactSetId:original.artifactSetId,artifactVersion:1,note:'TEST需改版不能只点改版'};
  await expect(technical.completeReview(p.worker,p.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:409});
  const changed={...state.artifacts[0]!.body,basedOnFinalComment:{id:review.finalCommentId,version:review.finalCommentVersion}};
  const result=await technical.saveArtifact(p.worker,p.sourceId,{taskId:review.taskId,expectedDocumentVersion:p.documentVersion,expectedVersion:1,scopeRef:'整款',action:'publish',body:changed},randomUUID());
  await technical.completeReview(p.worker,p.sourceId,{...input,artifactVersion:result.version},randomUUID());expect((await technical.read(p.worker,p.sourceId)).effective?.state).toBe('effective');
 });
 it('publishes scoped new-source cycle defaults without rewriting an already-enrolled source or original global catalog',async()=>{
  const p=await prepare(),settings=technical.settingsService(),before=await technical.read(p.designer,p.sourceId),standard=await settings.read(f.root),draft={expectedVersion:standard.version,values:{...standard.values,normalDays:8},reason:'TEST未来新开发采用8天，原单不变'};
  await expect(settings.preview(p.worker,draft)).rejects.toMatchObject({statusCode:403});
  const preview=await settings.preview(f.root,draft),key=randomUUID(),input={...draft,previewToken:preview.token};await settings.publish(f.root,input,key);await settings.publish(f.root,input,key);
  expect((await technical.read(p.designer,p.sourceId)).cycle?.allowedSeconds).toBe(before.cycle?.allowedSeconds);
  const next=await prepare();expect((await technical.read(next.designer,next.sourceId)).cycle?.allowedSeconds).toBe(8*86400);
 });
 it('converts a source without resetting its frozen standard or copying original actual evidence',async()=>{
  const scene=await f.scene('2026-10-23T00:00:00Z');
  let p:Awaited<ReturnType<typeof prepare>>,id:string,sourcePlan:Awaited<ReturnType<typeof developmentSlaPlan>>;
  await f.runtime.run(scene,f.root,async()=>{
   p=await prepare();id=p.sourceId;
    sourcePlan=await developmentSlaPlan(f.db,id);
    });
    const db=await f.db.connect();try{
      await db.query('BEGIN');const repo=new SlaConfigurationRepository(db),current=(await repo.current())!;
      await repo.publish({expectedVersion:current.version,values:{...current.values,development_materials:{kind:'duration',minutes:360}},actorId:f.root.actorId,reason:'TEST new orders only',requestKey:randomUUID()});
      await db.query('COMMIT');
    }finally{db.release();}
    await f.advance(scene,'2026-10-23T01:00:00Z');
    await f.runtime.run(scene,f.root,async()=>{
    const style=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[id])).rows[0].design_style_no;
    const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,orderDate:beijingCalendarDate(businessNow()),lines:[{color:'黑',sizes:[{size:'M',quantity:2000}],deliveryDate:'2027-03-01'}]});
    const key=randomUUID(),order=await identity.createOrder(f.root,input,key,id);
    expect((await identity.createOrder(f.root,input,key,id)).productionOrderId).toBe(order.productionOrderId);
    const snapshotClient=await f.db.connect();
    let snapshot;try{snapshot=await new SlaConfigurationRepository(snapshotClient).orderSnapshot(order.productionOrderId);}finally{snapshotClient.release();}
    expect(snapshot!.configurationId).toBe(sourcePlan.configuration_id);
    expect(snapshot!.snapshot.parameters.development_materials!.value).toEqual(sourcePlan.parameters_json.development_materials.value);
    const sla=new SlaOrderService(f.db,new ContextBusinessClock()),read=await sla.read(f.root,order.productionOrderId);
    expect(read.status).toBe('planned');if(read.status!=='planned')throw new Error('missing plan');
    const completed=(await f.db.query('SELECT completed_at FROM digital_production_tasks WHERE task_id=$1',[p.checkTaskId])).rows[0].completed_at.toISOString();
    expect(read.nodes.find(n=>n.id==='development_materials')).toMatchObject({actualStart:p.publishedAt,actualEnd:completed});
    expect(read.nodes.find(n=>n.id==='development_pattern')).toMatchObject({actualStart:completed});
    expect(read.development!.facts.development_materials!.evidence).toContain(p.checkTaskId);
    expect((await f.db.query("SELECT count(*)::int n FROM digital_sla_node_facts WHERE production_order_id=$1 AND node_id LIKE 'development_%'",[order.productionOrderId])).rows[0].n).toBe(0);
    const originalPlan=structuredClone(read.original);
    // Historical second-ledger copies must not mask an original-business correction.
    await f.db.query(`INSERT INTO digital_sla_node_facts(fact_id,production_order_id,node_id,revision,plan_id,fact_json,business_time,created_by,reason,request_key)
      VALUES($1,$2,'development_materials',1,$3,$4,$5,$6,'legacy compatibility fixture',$7)`,
      [randomUUID(),order.productionOrderId,read.original.planId,JSON.stringify(read.development!.facts.development_materials),JSON.stringify(await new ContextBusinessClock().read({kind:'order',id:order.productionOrderId})),f.root.actorId,randomUUID()]);
    const completionEvent=(await f.db.query("SELECT event_id FROM digital_production_task_events WHERE task_id=$1 AND event_kind='completed' ORDER BY recorded_at DESC LIMIT 1",[p.checkTaskId])).rows[0].event_id;
    const tasks=new DigitalProductionTaskService(f.db);
    const corrected=await tasks.correctTime(f.root,p.checkTaskId,{eventId:completionEvent,occurredAt:null,reason:'TEST original time unknown'},randomUUID());
    const unknown=await sla.read(f.root,order.productionOrderId);
    if(unknown.status!=='planned')throw new Error('missing plan');
    expect(unknown.nodes.find(n=>n.id==='development_materials')!.actualEnd).toBeNull();
    expect(unknown.nodes.find(n=>n.id==='development_materials')).toMatchObject({status:'completed_unrated',planOverdue:false});
    expect(unknown.progress).toEqual(read.progress);
    expect((await tasks.read(f.root,p.checkTaskId)).state).toBe('completed');
    expect(unknown.development!.facts.development_materials!.evidence).toContain(corrected.eventId);
    expect(unknown.original).toEqual(originalPlan);
    await tasks.correctTime(f.root,p.checkTaskId,{eventId:completionEvent,occurredAt:completed,reason:'TEST verified original time'},randomUUID());
    const restored=await sla.read(f.root,order.productionOrderId);
    if(restored.status!=='planned')throw new Error('missing plan');
    expect(restored.nodes.find(n=>n.id==='development_materials')!.actualEnd).toBe(completed);
    expect(restored.original).toEqual(originalPlan);
    expect((await f.db.query("SELECT count(*)::int n FROM digital_sla_node_facts WHERE production_order_id=$1",[order.productionOrderId])).rows[0].n).toBe(1);
    expect((await f.db.query("SELECT count(*)::int n FROM digital_production_task_events WHERE task_id=$1 AND corrects_event_id=$2",[p.checkTaskId,completionEvent])).rows[0].n).toBe(2);
    await expect(sla.read(person('qc'),order.productionOrderId)).rejects.toMatchObject({statusCode:404});
    await expect(new SlaOrderService(f.db,{read:async()=>({now:businessNow().toISOString(),scenarioId:null,revision:0})}).read(f.root,order.productionOrderId)).rejects.toThrow('scope mismatch');

    });
 });
 it('R5 distinguishes an authorized unenrolled old directory from a missing exact version and an unauthorized source',async()=>{
  const designer=person('sample-designer'),created={sourceId:randomUUID()};
  // Explicit old-source fixture: current createSource correctly enrolls new
  // sources. Do not delete that immutable enrollment or disable its trigger.
  await f.db.query("INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,customer_code)VALUES($1,$2,'头版',$3,'PD')",[created.sourceId,designer.actorId,`TEST-OLD-DIRECTORY-${randomUUID()}`]);
  const document=DevelopmentDocumentSchema.parse({template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['48']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST historical source document',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:await f.image(designer),kind:'款图'}]});
  await forms.save(designer,created.sourceId,{expectedVersion:0,document},randomUUID());
  for(const kind of ['artifacts','comments'] as const){
   const input={roundNumber:1,scopeRef:'整款',kind,view:'directory' as const};
   expect(await technical.history(designer,created.sourceId,input)).toMatchObject({sourceId:created.sourceId,roundNumber:1,enrolled:false,items:[],contextAvailable:false});
   await expect(technical.history(designer,created.sourceId,{...input,version:1})).rejects.toMatchObject({statusCode:404});
   await expect(technical.history(person('qc'),created.sourceId,input)).rejects.toMatchObject({statusCode:404});
  }
 });
 it('serves bounded technical directory metadata and exact historic bodies without a latest fallback',async()=>{
  const p=await prepare(),first=await artifact(p),original=(await technical.read(p.worker,p.sourceId)).artifacts[0]!;
  for(let version=1;version<=21;version++)await technical.saveArtifact(p.worker,p.sourceId,{taskId:p.paper.taskId,expectedDocumentVersion:p.documentVersion,expectedVersion:version,scopeRef:'整款',action:'save',body:{...original.body,note:`TEST directory draft ${version+1}`}},randomUUID());
  const query={roundNumber:1,scopeRef:'整款',kind:'artifacts' as const,view:'directory' as const},page=await technical.history(p.worker,p.sourceId,query);
  expect(page.items).toHaveLength(20);expect(page.nextBeforeVersion).toBe(3);expect(page.items.every(v=>!Object.hasOwn(v,'body'))).toBe(true);
  expect(page.adoptedArtifact).toMatchObject({artifactSetId:first.artifactSetId,version:1,roundNumber:1});
  const old=await technical.history(p.worker,p.sourceId,{...query,beforeVersion:page.nextBeforeVersion!});expect(old.items.map(v=>v.version)).toEqual([2,1]);expect(old.nextBeforeVersion).toBeNull();
  const exact=await technical.history(p.worker,p.sourceId,{roundNumber:1,scopeRef:'整款',kind:'artifacts',version:1});expect(exact.items).toHaveLength(1);expect(exact.items[0]).toMatchObject({artifactSetId:first.artifactSetId,version:1,body:original.body});
  await expect(technical.history(p.worker,p.sourceId,{...query,version:99999})).rejects.toMatchObject({statusCode:404});
  await expect(technical.history(person('qc'),p.sourceId,query)).rejects.toMatchObject({statusCode:404}); // Original source reader deliberately hides inaccessible resource existence.
  expect((await technical.read(p.worker,p.sourceId)).effective?.artifactRef).toEqual(page.effective?.artifactRef);
  const app=Fastify(),deps={service:identity,creationEnabled:true,authenticate:async(token:string|undefined)=>{if(token!=='worker')throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:p.worker.actorId,displayName:'TEST paper worker',businessRoles:p.worker.actorRoles,capabilities:['digital_production:view']};}};
  app.setErrorHandler((e,_r,reply)=>{const error=e as ApplicationError;void reply.code(error.statusCode??500).send({code:error.code,message:error.message});});registerDevelopmentExecutionRoutes(app,deps,execution,f.attachments);await app.ready();
  try{const base=`/digital-production/sources/${p.sourceId}/execution/technical/history?roundNumber=1&kind=artifacts`,headers={cookie:'dx_rework_session=worker'};
   expect((await app.inject({method:'GET',url:base+'&view=directory'})).statusCode).toBe(401);const metadata=await app.inject({method:'GET',url:base+'&view=directory',headers});expect(metadata.statusCode).toBe(200);expect(metadata.json().items.every((v:unknown)=>!Object.hasOwn(v as object,'body'))).toBe(true);
   const original=await app.inject({method:'GET',url:base+'&version=1',headers});expect(original.statusCode).toBe(200);expect(original.json().items[0].body.pltAttachmentIds).toHaveLength(1);
   expect((await app.inject({method:'GET',url:base+'&version=1&beforeVersion=2',headers})).statusCode).toBe(400);expect((await app.inject({method:'GET',url:base+'&version=2147483648',headers})).statusCode).toBe(400);
   expect((await app.inject({method:'GET',url:base+`&version=1&adoptedArtifactId=${randomUUID()}`,headers})).statusCode).toBe(404);
  }finally{await app.close();}

 });

 it('reads the exact originally adopted customer template after a newer version exists under original technical permissions',async()=>{
  const p=await prepare();await artifact(p);const original=(await technical.read(p.worker,p.sourceId)).artifacts[0]!,settings=technical.settingsService(),templateId=randomUUID(),table={...original.body.baseSizeTable,templateRef:null};
  await settings.saveTemplate(p.worker,{templateId,expectedVersion:0,body:{customerCode:'PD',name:'TEST原模板',table,note:'TEST原确认v1'},reason:'TEST客户初版'},randomUUID());
  await technical.saveArtifact(p.worker,p.sourceId,{taskId:p.paper.taskId,expectedDocumentVersion:p.documentVersion,expectedVersion:1,scopeRef:'整款',action:'publish',body:{...original.body,baseSizeTable:{...table,templateRef:{id:templateId,version:1}}}},randomUUID());
  await settings.saveTemplate(p.worker,{templateId,expectedVersion:1,body:{customerCode:'PD',name:'TEST原模板',table:{...table,measurements:table.measurements.map(m=>({...m,values:['52']}))},note:'TEST后续v2'},reason:'TEST后续新版'},randomUUID());
  expect((await settings.templates(p.worker,'PD')).items.find(t=>t.templateId===templateId)?.version).toBe(2);
  const adopted=await technical.history(p.worker,p.sourceId,{roundNumber:1,scopeRef:'整款',kind:'artifacts',version:2}),ref=('body' in adopted.items[0]! ? adopted.items[0].body as TechnicalArtifactBody:null)!.baseSizeTable.templateRef!;
  expect(ref).toEqual({id:templateId,version:1});const exact=await settings.templateVersion(p.worker,ref.id,ref.version);expect(exact.version).toBe(1);expect(exact.body.table.measurements[0].values).toEqual(['48']);
  expect((await settings.templateVersion(f.root,ref.id,ref.version)).version).toBe(1);await expect(settings.templateVersion(p.designer,ref.id,ref.version)).rejects.toMatchObject({statusCode:403});await expect(settings.templateVersion(person('qc'),ref.id,ref.version)).rejects.toMatchObject({statusCode:403});await expect(settings.templateVersion(p.worker,templateId,9999)).rejects.toMatchObject({statusCode:404});
  const app=Fastify(),deps={service:identity,creationEnabled:true,authenticate:async(token:string|undefined)=>{const who=token==='worker'?p.worker:token==='designer'?p.designer:null;if(!who)throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:who.actorId,displayName:'TEST template read',businessRoles:who.actorRoles,capabilities:['digital_production:view']};}};
  app.setErrorHandler((e,_r,reply)=>{const error=e as ApplicationError;void reply.code(error.statusCode??500).send({code:error.code,message:error.message});});registerDevelopmentExecutionRoutes(app,deps,execution,f.attachments);await app.ready();
  try{const url=`/digital-production/technical-size-templates/${templateId}/versions/1`,headers={cookie:'dx_rework_session=worker'},exact=await app.inject({method:'GET',url,headers});expect(exact.statusCode).toBe(200);expect(exact.headers['cache-control']).toBe('no-store');expect(exact.json().version).toBe(1);expect((await app.inject({method:'GET',url})).statusCode).toBe(401);expect((await app.inject({method:'GET',url,headers:{cookie:'dx_rework_session=designer'}})).statusCode).toBe(403);expect((await app.inject({method:'GET',url:url.replace('/versions/1','/versions/0'),headers})).statusCode).toBe(400);expect((await app.inject({method:'GET',url:url.replace('/versions/1','/versions/9999'),headers})).statusCode).toBe(404);}finally{await app.close();}
 });
 it('P03-06: retrieves complete original PNG PDF and PLT bytes through native source authorization and private storage grants',async()=>{
  const p=await prepare();await artifact(p);
  const plotId=(await technical.read(p.worker,p.sourceId)).artifacts[0]!.body.pltAttachmentIds[0]!,imageId=(await forms.read(p.designer,p.sourceId)).document!.files.find(f=>f.kind==='款图')!.attachmentId;
  const pdfBytes=await new Promise<Buffer>((resolve,reject)=>{const pdf=new PDFDocument(),chunks:Buffer[]=[];pdf.on('data',(chunk:Buffer)=>chunks.push(chunk));pdf.on('error',reject);pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.text('TEST P03 complete original PDF');pdf.end();});
  const pdfHash=createHash('sha256').update(pdfBytes).digest('hex'),intent=await f.attachments.createUploadIntent(p.designer,{filename:'TEST-original.pdf',mimeType:'application/pdf',sizeBytes:pdfBytes.length,sha256:pdfHash});
  await execution.recordUploadPurpose(p.designer,p.sourceId,intent.attachmentId,'客户评语依据');await f.storage.writeImmutable(intent.objectKey,pdfBytes,{mimeType:'application/pdf',sha256:pdfHash});await f.attachments.finalize(p.designer,intent.attachmentId);
  await technical.recordComment(p.designer,p.sourceId,{...comment(0,false),evidenceRefs:[intent.attachmentId]},randomUUID());
  const directory=await mkdtemp(join(tmpdir(),'dx-p03-private-bytes-')),storage=new AcceptanceObjectStorage(directory,'http://test','TEST-private-byte-grants-not-live'),app=Fastify();
  try{
   for(const row of (await f.db.query('SELECT attachment_id,object_key,mime_type,sha256 FROM attachments WHERE attachment_id=ANY($1::uuid[])',[[imageId,intent.attachmentId,plotId]])).rows){const bytes=f.storage.objectBytes.get(row.object_key);expect(bytes).toBeDefined();await storage.writeImmutable(row.object_key,bytes!,{mimeType:row.mime_type,sha256:row.sha256});}
   const attachments=new AttachmentService(f.db,storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});
   app.setErrorHandler((e,_r,reply)=>{const error=e as ApplicationError;void reply.code(error.statusCode??500).send({code:error.code,message:error.message});});
   registerDevelopmentRoutes(app,{service:identity,creationEnabled:true,authenticate:async token=>{const who=token==='designer'?p.designer:token==='qc'?person('qc'):null;if(!who)throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:who.actorId,displayName:'TEST private source reader',businessRoles:who.actorRoles,capabilities:who.authorizationCapabilities!};}},forms,attachments);
   registerAcceptanceStorageRoutes(app,storage);await app.ready();
   for(const [id,mime] of [[imageId,'image/png'],[intent.attachmentId,'application/pdf'],[plotId,'application/octet-stream']] as const){
    const path=`/digital-production/sources/${p.sourceId}/development/attachments/${id}`,response=await app.inject({method:'GET',url:path,headers:{cookie:'dx_rework_session=designer'}});expect(response.statusCode).toBe(302);
    const target=new URL(response.headers.location!),download=await app.inject({method:'GET',url:target.pathname+target.search});expect(download.statusCode).toBe(200);expect(download.headers['content-type']).toContain(mime);expect(download.headers['cache-control']).toContain('no-store');
    const original=(await f.db.query('SELECT object_key,sha256,size_bytes FROM attachments WHERE attachment_id=$1',[id])).rows[0];
    expect(download.rawPayload.byteLength).toBe(Number(original.size_bytes));expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(original.sha256);expect(download.rawPayload).toEqual(Buffer.from(f.storage.objectBytes.get(original.object_key)!));
    if(mime==='application/pdf')expect(download.rawPayload.toString('latin1')).toContain('/Type /Catalog');
    if(mime==='application/octet-stream')expect(download.rawPayload.toString()).toBe('IN;SP1;PU0,0;PD100,100;PU;SP0;');
    expect((await app.inject({method:'GET',url:path})).statusCode).toBe(401);expect((await app.inject({method:'GET',url:path,headers:{cookie:'dx_rework_session=qc'}})).statusCode).toBe(404);
   }
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
 });
 it('reads only the proven inherited artifact from the selected child round and rejects arbitrary artifact IDs',async()=>{
  const p=await sampleToTail(),rounds=new DevelopmentRoundService(f.db,true,native),old=await forms.read(p.designer,p.sourceId);
  const draft=await rounds.save(p.designer,p.sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:old.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST仅重做车缝，技术成果仍可复用',explanation:'TEST原生复版继承',categories:['车缝'],affectedNodes:['车板'],outputKind:'整件样板'}},randomUUID());
  await rounds.publish(p.designer,p.sourceId,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
  const published=(await f.db.query('SELECT published_at FROM digital_development_rounds WHERE source_id=$1 AND round_number=2',[p.sourceId])).rows[0];
  const projected=await new DigitalJourneyQuery(f.db).read(f.root,p.sourceId,undefined,true),adopted=projected.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&node.state==='inherited'&&node.progressApplicability==='applicable');
  expect(adopted.length).toBeGreaterThan(0);
  for(const node of adopted){expect(node.inheritedResult).toMatchObject({adoptedAt:new Date(published.published_at).toISOString(),adoptedRound:2,adoptionSourceRef:`development-round:${p.sourceId}:2`});expect(node.actualAt).toBeNull();}
  const metadata=await technical.history(p.designer,p.sourceId,{roundNumber:2,scopeRef:'整款',kind:'artifacts',view:'directory'});expect(metadata.items).toEqual([]);expect(metadata.adoptedArtifact).toMatchObject({sourceId:p.sourceId,roundNumber:1,viaSourceId:p.sourceId,viaRoundNumber:2});
  const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'source',id:p.sourceId,range:'development',round:2}});expect(calculation.context.identity.round).toBe(2);expect(calculation.current.rows.some(row=>row.id==='development_pattern')).toBe(false);expect(calculation.current.rows.some(row=>row.id==='development_sewing')).toBe(true);
  const inherited=metadata.adoptedArtifact!,detail=await technical.history(p.designer,p.sourceId,{roundNumber:2,scopeRef:'整款',kind:'artifacts',version:inherited.version,adoptedArtifactId:inherited.artifactSetId});expect(detail.items[0]).toMatchObject({roundNumber:1,artifactSetId:inherited.artifactSetId});expect(Object.hasOwn(detail.items[0]!,'body')).toBe(true);
  const directory=await technical.history(p.designer,p.sourceId,{roundNumber:2,scopeRef:'整款',kind:'artifacts',version:inherited.version,adoptedArtifactId:inherited.artifactSetId,view:'directory'});
  const recorded=(await f.db.query('SELECT created_at FROM digital_development_artifact_inheritances WHERE source_id=$1 AND round_number=2 AND scope_ref=$2',[p.sourceId,'整款'])).rows[0];
  expect(directory.items[0]).toMatchObject({artifactSetId:inherited.artifactSetId,version:inherited.version,roundNumber:1,viaSourceId:p.sourceId,viaRoundNumber:2,inheritedAt:new Date(recorded.created_at).toISOString()});expect(Object.hasOwn(directory.items[0]!,'body')).toBe(false);
  expect(metadata.adoptedArtifact?.inheritedAt).toBe(new Date(recorded.created_at).toISOString());
  await expect(technical.history(p.designer,p.sourceId,{roundNumber:2,scopeRef:'整款',kind:'artifacts',version:inherited.version,adoptedArtifactId:randomUUID(),view:'directory'})).rejects.toMatchObject({statusCode:404});
  const app=Fastify();app.setErrorHandler((e,_r,reply)=>{const error=e as ApplicationError;void reply.code(error.statusCode??500).send({code:error.code,message:error.message});});
  registerDevelopmentExecutionRoutes(app,{service:identity,creationEnabled:true,authenticate:async token=>{if(token!=='designer')throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:p.designer.actorId,displayName:'TEST original designer',businessRoles:p.designer.actorRoles,capabilities:['digital_production:view']};}},execution,f.attachments);await app.ready();
  try{const path=`/digital-production/sources/${p.sourceId}/execution/technical/history?roundNumber=2&scopeRef=${encodeURIComponent('整款')}&kind=artifacts&version=${inherited.version}&adoptedArtifactId=${inherited.artifactSetId}&view=directory`,headers={cookie:'dx_rework_session=designer'},response=await app.inject({method:'GET',url:path,headers});expect(response.statusCode).toBe(200);expect(response.json().items[0].inheritedAt).toBe(new Date(recorded.created_at).toISOString());expect(Object.hasOwn(response.json().items[0],'body')).toBe(false);expect((await app.inject({method:'GET',url:path})).statusCode).toBe(401);expect((await app.inject({method:'GET',url:path.replace(inherited.artifactSetId,randomUUID()),headers})).statusCode).toBe(404);}finally{await app.close();}
  await expect(technical.history(p.designer,p.sourceId,{roundNumber:2,scopeRef:'整款',kind:'artifacts',version:inherited.version,adoptedArtifactId:randomUUID()})).rejects.toMatchObject({statusCode:404});
  const unchanged=await technical.history(p.designer,p.sourceId,{roundNumber:2,scopeRef:'整款',kind:'artifacts',view:'directory'});expect(unchanged.effective).toEqual(metadata.effective);
 });

});
