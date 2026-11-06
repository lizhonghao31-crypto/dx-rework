import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {DIGITAL_SLA_PARAMETERS,validateDigitalSlaSnapshot,validateDigitalSlaValues,type DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import {DevelopmentCycleValuesSchema} from '@dx-rework/contracts/digital-development-technical';
import {SlaCalculationPreviewSchema,SLA_CALCULATOR_VERSION,SLA_CALENDAR_VERSION,SLA_CALCULATION_ROUTE_VERSION,type CalculationAnchor,type CalculationGraph,type CalculationNode,type SlaCalculationContext,type SlaCalculationPreview,type SlaCalculationPreviewInput,type SlaCalculationSelection} from '@dx-rework/contracts/sla-calculation';
import {calculateSlaPreview,calculationDraftGraph,SlaCalculationInputError} from '@dx-rework/domain/sla-calculation';
import {buildSlaCalculationRoute,type CalculationRouteInput} from '@dx-rework/domain/sla-calculation-routes';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {ContextBusinessClock,assertBusinessClockUnchanged} from '../acceptance-clock/business-time.js';
import {assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {DigitalProductionAccessPolicy,digitalNotFound} from './access-policy.js';
import {SlaSettingsService} from './sla-settings-service.js';
import {developmentSlaPlan} from './development-sla-enrollment.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {developmentTaskTiming} from './development-task-timing.js';
import {materialReadiness} from './development-material-readiness.js';
import {externalPatternRecords} from './development-external-pattern-facts.js';
import {developmentCycleEvidence} from './development-cycle-evidence.js';
import {preparationAdoption} from './preparation-material-repository.js';
import {productionReadiness,preparationWindow} from './production-readiness-repository.js';
import {SlaOrderService} from './sla-order-service.js';
import {firstContractBusinessReady} from './contract-business-ready.js';
import {factoryBatchTiming} from './factory-batch-timing.js';
import {factoryProductionCompletion} from './factory-production-facts.js';

const iso=(value:Date|string|null|undefined)=>value?new Date(value).toISOString():null;
const canonical=(value:unknown):unknown=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,v])=>[key,canonical(v)])):value;
export const slaCalculationDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const conflict=(message:string):never=>{throw new ApplicationError('DIGITAL_TASK_CONFLICT',message,409);};
const instant=(value:string,source:string):CalculationAnchor=>({precision:'instant',value,source});
const craft=(value:string|undefined)=>value==='无'?'none' as const:value==='印花'?'printing' as const:value==='绣花'?'embroidery' as const:value==='印绣花'?'print_embroidery' as const:'unknown' as const;
const nativeFact=(f:SlaNodeFact):NonNullable<CalculationRouteInput['native']>[string]=>{
 const single=f.batchWindows?.length===1?f.batchWindows[0]:null;
 const minutes=f.standardMinutes!==undefined?f.standardMinutes:single?.startedAt&&single.deadline?(Date.parse(single.deadline)-Date.parse(single.startedAt))/60000:f.batchWindows?.length?null:undefined;
 return {evidence:f.evidence,...(f.startedAt?{startedAt:f.startedAt}:{}),...(f.completedAt?{completedAt:f.completedAt}:{}),...(minutes!==undefined?{minutes}:{}),...(f.waitingFor?{waitingFor:f.waitingFor.reason}:{})};
};
const emptyConditions=():CalculationRouteInput['conditions']=>({craft:'unknown',craftExecution:'unknown',pattern:'unknown',washing:'none',preshrink:'unknown',preparation:'unknown',developmentMode:'normal',rework:'unknown'});

/** Only original authorized readers are used. Each response is one repeatable-read, read-only snapshot. */
export class SlaCalculationService{
 constructor(private readonly database:Pool){}
 async preview(actor:TrustedActorContext,raw:unknown):Promise<SlaCalculationPreview>{
  const parsed=SlaCalculationPreviewSchema.safeParse(raw);
  if(!parsed.success){const path=parsed.error.issues[0]?.path??[],parameter=DIGITAL_SLA_PARAMETERS.find(p=>path.includes(p.key));throw new ApplicationError('VALIDATION_ERROR',parameter?`${parameter.label}：请检查本字段的时长、单位或类型，空值不能当作0`:'请检查演算范围、参考条件和标准草稿；不能提交身份或业务完成事实',400);}
  const input=parsed.data,db=await this.database.connect();let observed:BusinessTime|undefined;
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await assertSlaSettingsReadActor(db,actor);
   const current=await new SlaSettingsService().read(db,actor);
   const technical=(await db.query('SELECT version,values_json FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
   if(!technical)throw new ApplicationError('SERVICE_UNAVAILABLE','开发独立标准尚未就绪，当前演算不能确认该规则来源',503);
   const development={version:Number(technical.version),values:DevelopmentCycleValuesSchema.parse(technical.values_json)};
   if(input.unified&&input.unified.expectedVersion!==current.version)conflict('统一标准已有新版本，请保留草稿并重新读取后演算');
   if(input.development&&input.development.expectedVersion!==development.version)conflict('开发独立标准已有新版本，请保留草稿并重新读取后演算');
   let draftUnified:DigitalSlaValues;
   try{draftUnified=validateDigitalSlaValues(input.unified?.values??current.values);}catch(error){const key=error instanceof Error?/: ([a-z_]+)$/.exec(error.message)?.[1]:null,parameter=DIGITAL_SLA_PARAMETERS.find(p=>p.key===key);throw new ApplicationError('VALIDATION_ERROR',parameter?`${parameter.label}：本次值或内含目标合计不合法，请核对该字段与父窗口`:'草稿时长、精度或内含窗口不合法，请核对具体节点及父窗口',400);}
   const context:SlaCalculationContext={selection:input.selection,identity:{kind:'example',id:null,sourceId:null,orderId:null,round:null,label:'流程示例 · 明确参考条件'},unified:{version:current.version,values:current.values},development,
    graph:null as unknown as CalculationGraph,bindings:{reader:{actorId:actor.actorId,roles:[...actor.actorRoles].sort()},routeVersion:SLA_CALCULATION_ROUTE_VERSION,calculatorVersion:SLA_CALCULATOR_VERSION,calendarVersion:SLA_CALENDAR_VERSION},limitations:[]};
   if(input.selection.mode==='example'){
    context.graph=buildSlaCalculationRoute({range:input.selection.range,conditions:input.selection.conditions,anchors:input.selection.references,values:current.values,unifiedSource:`统一标准 v${current.version} · 流程示例`,development:development.values,developmentSource:`开发独立标准 v${development.version} · 流程示例`});
    context.limitations.push('流程示例只在明确参考条件下演算标准窗口，不是实际完成、产能或保证交期；不写入业务实例');
   }else{
    const selection=input.selection;
    await new DigitalProductionAccessPolicy(db).assert(actor,selection.kind,selection.id,'technical');
    observed=await new ContextBusinessClock(this.database,db).read({kind:selection.kind,id:selection.id});
    context.bindings.clock={scenarioId:observed.scenarioId,revision:observed.revision,...(observed.scenarioId?{now:observed.now}:{})};
    if(selection.range==='development')await this.developmentContext(db,context,selection,observed);
    else await this.orderContext(db,actor,context,selection,observed);
    context.limitations.push('实例按原采用与冻结规则读取；本次改值仅作未发布假设，不改变实例标准、事实或原执行许可');
   }
   const result=this.calculate(context,input,draftUnified);
   await db.query('COMMIT');
   if(input.selection.mode==='instance'&&observed)await assertBusinessClockUnchanged(new ContextBusinessClock(this.database),{kind:input.selection.kind,id:input.selection.id},observed);
   return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private calculate(context:SlaCalculationContext,input:SlaCalculationPreviewInput,values:DigitalSlaValues):SlaCalculationPreview{
  const draftValues={unified:values,development:input.development?.values??context.development.values};
  const graph=calculationDraftGraph(context.graph,{unified:context.unified.values,development:context.development.values},draftValues);
  const current=calculateSlaPreview(context.graph),contextDigest=slaCalculationDigest(context);
  let draft:ReturnType<typeof calculateSlaPreview>;
  try{draft=calculateSlaPreview(graph);}catch(error){if(error instanceof SlaCalculationInputError)throw new ApplicationError('VALIDATION_ERROR',`${error.message}（${error.field}）`,400);throw error;}
  return {context,contextDigest,contextChanged:input.checkContextDigest!==undefined&&input.checkContextDigest!==contextDigest,current,draft,
   differences:{overallMs:current.overall.spanMs!==null&&draft.overall.spanMs!==null?draft.overall.spanMs-current.overall.spanMs:null,
    stages:draft.stages.map(s=>{const before=current.stages.find(b=>b.stage===s.stage);return {stage:s.stage,spanMs:s.spanMs!==null&&before?.spanMs!==null&&before?.spanMs!==undefined?s.spanMs-before.spanMs:null};}),
    nodes:draft.rows.map(n=>{const before=current.rows.find(b=>b.id===n.id);return {id:n.id,endMs:n.end.at&&before?.end.at?Date.parse(n.end.at)-Date.parse(before.end.at):null};})},
   calculationReceipt:{purpose:'read_only_calculation',contextDigest,valuesDigest:slaCalculationDigest(draftValues),resultDigest:slaCalculationDigest(draft),calculatorVersion:SLA_CALCULATOR_VERSION,calendarVersion:SLA_CALENDAR_VERSION,status:draft.overall.status}};
 }
 private async developmentContext(db:PoolClient,context:SlaCalculationContext,selection:Extract<SlaCalculationSelection,{mode:'instance'}>,time:BusinessTime){
  if(selection.poLineId||selection.batchId)throw new ApplicationError('VALIDATION_ERROR','开发本轮演算不接收大货 PO 或批次范围',400);
  const source=selection.kind==='source'?(await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1',[selection.id])).rows[0]:(await db.query('SELECT s.* FROM digital_production_orders o JOIN digital_production_sources s USING(source_id) WHERE o.production_order_id=$1',[selection.id])).rows[0];
  if(!source)digitalNotFound();
  const mothers=(await db.query('SELECT production_order_id,source_id FROM digital_production_orders WHERE source_id=$1 ORDER BY production_order_id',[source.source_id])).rows;
  const document=await developmentDocumentRow(db,source.source_id,selection.round);if(!document)digitalNotFound();
  const round=Number(document.round_number??1),saved=await developmentSlaPlan(db,source.source_id),conditions=emptyConditions();
  conditions.craft=craft(document.document.craft);conditions.washing=document.document.washing==='免洗'?'none':document.document.washing==='外洗'?'external':document.document.washing==='内洗'?'internal':'unknown';conditions.pattern='internal';
  const frozen=saved?validateDigitalSlaSnapshot({ruleVersion:saved.rule_version,parameters:saved.parameters_json}):null;
  const values=frozen?Object.fromEntries(Object.entries(frozen.parameters).map(([key,p])=>[key,p.value])):context.unified.values;
  const cycle=(await db.query('SELECT * FROM digital_development_cycle_rounds WHERE source_id=$1 AND round_number=$2',[source.source_id,round])).rows[0];
  const cycleStatus=cycle?await developmentCycleEvidence(db,source.source_id,round,time.now):null;
  conditions.developmentMode=cycleStatus?.mode??'normal';
  const native:NonNullable<CalculationRouteInput['native']>={},anchors:Record<string,CalculationAnchor>={};
  if(document.published_at)anchors.development_published=instant(iso(document.published_at)!,`development:${source.source_id}:round:${round}:published`);
  const tasks=(await db.query(`SELECT t.*,a.source_id,a.task_kind,
    EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS material_returned,
    EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回') AS tail_returned
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 ORDER BY t.created_at,t.task_id`,[source.source_id,round])).rows;
  const timingByTask=new Map<string,Awaited<ReturnType<typeof developmentTaskTiming>>>();
  for(const task of tasks){
   const timing=await developmentTaskTiming(db,task),key=task.task_kind==='development_material_recheck'?'development_materials':task.task_kind==='development_external_pattern'?'external_pattern':task.task_kind==='development_craft_confirmation'?'development_craft_return':task.task_kind;
   timingByTask.set(task.task_id,timing);
   const credible=task.completed_at&&['现场登记','已核实'].includes(task.completed_quality)&&!task.material_returned&&!task.tail_returned;
   native[key]={evidence:`task:${task.task_id}:round:${round}${timing?`;${timing.basis.join(';')}`:''}`,...(timing?{minutes:timing.seconds===null?null:timing.seconds/60}:{}),...(timing?.enteredAt?{startedAt:timing.enteredAt}:{}),...(credible?{completedAt:iso(task.completed_at)!}:{}),...(['cancelled','blocked'].includes(task.state)||task.material_returned||task.tail_returned?{waitingFor:task.material_returned?'本轮资料已退回，须核对原补料和复核':task.tail_returned?'本轮尾查退回，须按原补做／复版处理':'本轮原任务尚未满足执行条件'}:{})};
  }
  const craftKey=conditions.craft!=='none'&&conditions.craft!=='unknown'?`development_${conditions.craft}`:null;
  if(craftKey&&native[craftKey]){
   delete native[craftKey]!.completedAt;
   if(native.development_craft_return?.completedAt)native[craftKey]!.completedAt=native.development_craft_return.completedAt;
  }
  const papers=(await externalPatternRecords(db,source.source_id)).filter(p=>p.roundNumber===round);if(papers.length)conditions.pattern='external';
  const execution=(await db.query("SELECT f.payload->>'craftExecution' AS execution,f.fact_id FROM digital_development_route_facts f WHERE f.source_id=$1 AND f.route_version=$2 AND f.kind='发工艺' ORDER BY sequence DESC LIMIT 1",[source.source_id,round])).rows[0];
  conditions.craftExecution=execution?.execution==='外发'?'external':execution?.execution==='内部'?'internal':'unknown';
  const routeKinds=round>1?(document.revision?.route_nodes??[]):saved?.route_nodes?.length?['development_materials',...saved.route_nodes]:undefined;
  const materials=await materialReadiness(db,source.source_id,round);
  if(!materials.earlyReady)native.development_pattern={...native.development_pattern,evidence:native.development_pattern?.evidence??`source:${source.source_id}:round:${round}:materials`,waitingFor:`本轮纸样前物料条件尚未满足：${materials.earlyMissing.map(m=>m.name).join('、')||'原核配与质量依据待核'}`};
  if(!materials.sewingReady)native.development_sewing={...native.development_sewing,evidence:native.development_sewing?.evidence??`source:${source.source_id}:round:${round}:sewing-materials`,waitingFor:`本轮车板前物料条件尚未满足：${materials.sewingMissing.map(m=>m.name).join('、')||'原核配与质量依据待核'}`};
  context.graph=buildSlaCalculationRoute({observationMode:'instance',range:'development',conditions,values,unifiedSource:saved?`来源冻结标准 ${saved.configuration_id} · revision ${saved.revision}`:'历史来源未冻结；现行值仅作明示参考',development:cycle?DevelopmentCycleValuesSchema.parse(cycle.values_json):context.development.values,developmentSource:cycle?`本轮冻结开发独立标准 v${cycle.policy_version}`:`开发独立标准 v${context.development.version} · 参考`,anchors,native,...(routeKinds?{routeKinds}:{}),outputKind:document.revision?.output_kind??'整件样板'});
  const supervision=context.graph.nodes.find(n=>n.id==='development_cycle');
  if(supervision&&cycleStatus)supervision.exclusion={knownMs:cycleStatus.dueAt!==null?Math.round(cycleStatus.excludedSeconds*1000):null,reasons:cycleStatus.precisionReasons.length?cycleStatus.precisionReasons:['真实外发尚未完成，内部周期自然截止须待实际回收核定']};
  // External paper is an existing independent request. It does not replace the internal pattern's native route.
  const external=context.graph.nodes.find(n=>n.id==='external_pattern');if(external&&papers.length){context.graph.nodes=context.graph.nodes.filter(n=>n!==external);for(const paper of papers){const key=`external-pattern:${paper.requestId}`,task=tasks.find(t=>t.task_id===paper.taskId),completed=task?.state==='completed'&&task.completed_at&&['现场登记','已核实'].includes(task.completed_quality);context.graph.anchors[key]=instant(iso(paper.requestedAt)!,key);const n={...external,id:key,label:`外部纸样 · 本轮请求 ${papers.indexOf(paper)+1}`,anchorKey:key};delete n.completedAt;if(completed)n.completedAt=instant(iso(task.completed_at)!,`task:${task.task_id}:effective-completion`);else if(paper.receivedAt)n.completedAt={precision:'unknown',reason:'原纸样收到记录保留，但当前有效完成时刻尚未核实'};context.graph.nodes.push(n);}}
  const reviews=(await db.query('SELECT q.review_id,q.task_id,q.requested_at,q.final_comment_id,t.state,t.completed_at,t.completed_quality FROM digital_development_size_review_requests q JOIN digital_production_tasks t ON t.task_id=q.task_id JOIN digital_production_task_access a ON a.task_id=t.task_id WHERE a.source_id=$1 AND t.route_version=$2 ORDER BY q.requested_at,q.review_id',[source.source_id,round])).rows;
  const review=context.graph.nodes.find(n=>n.id==='final_comment_review')!;
  if(reviews.length){context.graph.nodes=context.graph.nodes.filter(n=>n!==review);for(const r of reviews){const key=`final-comment:${r.final_comment_id}:review:${r.review_id}`,timing=timingByTask.get(r.task_id),minutes=timing?.seconds!==null&&timing?.seconds!==undefined?timing.seconds/60:null;context.graph.anchors[key]=instant(iso(r.requested_at)!,key);context.graph.nodes.push({...review,id:key,anchorKey:key,minutes,kind:minutes===null?'unlimited':'duration',binding:minutes===null?null:review.binding,source:`task:${r.task_id}:final-comment:${r.final_comment_id}`,...(r.state==='completed'&&r.completed_at&&['现场登记','已核实'].includes(r.completed_quality)?{completedAt:instant(iso(r.completed_at)!,`task:${r.task_id}:completed`)}:{})});}}
  const patches=tasks.filter(t=>['development_patch','development_patch_tail_check','development_patch_confirmation'].includes(t.task_kind));
  for(const task of patches){
   const timing=timingByTask.get(task.task_id),minutes=timing?.seconds!==null&&timing?.seconds!==undefined?timing.seconds/60:null,key=`patch-task:${task.task_id}`,credible=task.state==='completed'&&task.completed_at&&['现场登记','已核实'].includes(task.completed_quality);
   if(timing?.enteredAt)context.graph.anchors[key]=instant(timing.enteredAt,`task:${task.task_id}:native-start`);
   const node:CalculationNode={id:key,label:task.task_kind==='development_patch'?'本轮原生局部补做':task.task_kind==='development_patch_tail_check'?'本次补做尾查':'本次补做原设计确认',stage:2,parameterKey:task.task_kind,applicable:'yes',countsProgress:false,kind:minutes===null?'unlimited':'duration',minutes,offsetDays:null,dependsOn:[],anchorKey:key,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:`task:${task.task_id}:round:${round} · ${timing?.basis.join(';')??'本次补做未冻结独立时长'}`,binding:task.task_kind==='development_patch_tail_check'&&minutes!==null?{group:'unified',key:'development_tail_check'}:null,independent:task.task_kind==='development_patch_confirmation',...(credible?{completedAt:instant(iso(task.completed_at)!,`task:${task.task_id}:completed`)}:{})};context.graph.nodes.push(node);if(!node.independent)context.graph.endIds.push(node.id);
  }
  context.identity={kind:selection.kind,id:selection.id,sourceId:source.source_id,orderId:selection.kind==='order'?selection.id:mothers.length===1?mothers[0].production_order_id:null,round,label:`${source.design_style_no} · 第${round}轮`};
  context.bindings.motherOrders=mothers;
  context.bindings.development={sourceId:source.source_id,round,documentVersion:document.version,document:document.document,routeKinds:routeKinds??null,inherited:document.revision?.inherited??null,savedRevision:saved?.revision??null,configurationId:saved?.configuration_id??null,parameters:saved?.parameters_json??null,cycle:cycle??null,cycleBasis:cycleStatus?{policyVersion:cycleStatus.policyVersion,mode:cycleStatus.mode,publishedAt:cycleStatus.publishedAt,completedAt:cycleStatus.completedAt,excludedSeconds:cycleStatus.dueAt!==null?cycleStatus.excludedSeconds:null,dueAt:cycleStatus.dueAt,precisionReasons:cycleStatus.precisionReasons,urgentRevision:cycleStatus.urgentRevision,urgentState:cycleStatus.urgentState}:null,papers,materials,tasks:tasks.map(t=>[t.task_id,t.state,t.completed_at,t.completed_quality,t.material_returned,t.tail_returned]),execution,reviews};
  if(!saved)context.limitations.push('历史来源没有冻结标准，现行参数仅作参考，不追改历史评价');
  if(round>1)context.limitations.push('本轮只演算原路线中重新办理的节点；原成果沿用关系保留，不重走首版全段');
  if(cycleStatus?.precisionReasons.length)context.limitations.push(...cycleStatus.precisionReasons);
 }
 private async orderContext(db:PoolClient,actor:TrustedActorContext,context:SlaCalculationContext,selection:Extract<SlaCalculationSelection,{mode:'instance'}>,time:BusinessTime){
  if(selection.kind!=='order')throw new ApplicationError('VALIDATION_ERROR','此范围须选择有权正式订单，不能把开发来源当作大货实例',400);
  if(selection.round!==undefined)throw new ApplicationError('VALIDATION_ERROR','大货范围按当前真实采用关系读取，不接收开发轮次覆盖',400);
  const order=(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1',[selection.id])).rows[0]??digitalNotFound();
  const lines=(await db.query('SELECT line_id,COALESCE(formal_style_no,po_number) AS po_number,color,customer_warehouse_arrival_date::text AS customer_date,factory_delivery_date::text AS factory_date FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[selection.id])).rows;
  if(selection.poLineId&&!lines.some(l=>l.line_id===selection.poLineId))digitalNotFound();
  const read=await new SlaOrderService(this.database,{read:async()=>time}).readWithClient(actor,selection.id,db,{mode:'read_projection'});
  const conditions=emptyConditions(),anchors:Record<string,CalculationAnchor>={};
  let values=context.unified.values,source=`统一标准 v${context.unified.version} · 历史实例参考`;
  if(read.status==='planned'){
   const snapshot=(await db.query('SELECT rule_version,parameters_json FROM digital_sla_order_snapshots WHERE snapshot_id=$1 AND production_order_id=$2',[read.current.snapshotId,selection.id])).rows[0]??digitalNotFound();
   values=Object.fromEntries(Object.entries(validateDigitalSlaSnapshot({ruleVersion:snapshot.rule_version,parameters:snapshot.parameters_json}).parameters).map(([key,p])=>[key,p.value]));source=`本单冻结 ${read.current.snapshotId} · 计划 v${read.current.revision}`;
   context.bindings.orderPlan={planId:read.current.planId,revision:read.current.revision,snapshotId:read.current.snapshotId,plan:read.current.plan,applications:read.applications,facts:read.facts,factory:read.factory,receivingRevision:read.receiving.revision,rework:read.rework.windows,garments:read.garments.windows};
  }else context.limitations.push(read.reason);
  const document=order.source_id?await developmentDocumentRow(db,order.source_id):null;
  conditions.craft=selection.range==='bulk_craft'?(read.status==='planned'&&read.factory?read.factory.craftKey===null?'none':read.factory.craftKey==='bulk_printing'?'printing':read.factory.craftKey==='bulk_embroidery'?'embroidery':'print_embroidery':'unknown'):craft(document?.document.craft);
  const instruction=(await db.query('SELECT v.version,v.published_at,v.source_round,v.document FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1',[selection.id])).rows[0];
  const adoption=await preparationAdoption(db,{kind:'order',id:selection.id});
  const retainLegacy=Boolean(adoption?.standards.retainedInstructionVersion&&instruction?.version<=adoption.standards.retainedInstructionVersion);
  conditions.preparation=adoption&&!retainLegacy?'adopted':'legacy';
  const readiness=selection.range==='preparation'?await productionReadiness(db,selection.id):null;
  const facts=read.status==='planned'?read.facts:{};
  const preshrink=read.status==='planned'?read.evaluationPlan.nodes.find(n=>n.id==='warehouse_preshrink'):null;
  conditions.preshrink=preshrink?.applicable==='no'?'no':preshrink?.applicable==='yes'?'yes':'unknown';
  if(readiness?.receiptAt)anchors.whole_fabric_arrived=instant(readiness.receiptAt,'原生主料实际到仓');
  if(readiness?.readyAt)anchors.final_preparation_ready=instant(readiness.readyAt,`原生正式制单就绪:${readiness.revision}`);
  if(instruction?.published_at)anchors.instruction_published=instant(iso(instruction.published_at)!,`instruction:${selection.id}:v${instruction.version}`);
  if(facts.sourcing_approval?.completedAt)anchors.sourcing_decided=instant(facts.sourcing_approval.completedAt,facts.sourcing_approval.evidence);
  if(facts.bulk_cutting?.completedAt)anchors.whole_cutting_completed=instant(facts.bulk_cutting.completedAt,facts.bulk_cutting.evidence);
  if(selection.range==='contract'||selection.range==='bulk_craft'){const contract=await firstContractBusinessReady(db,selection.id);if(contract.at)anchors.contract_pdf_ready=instant(contract.at,contract.evidence);context.bindings.contract=contract;}
  const native=Object.fromEntries(Object.entries(facts).map(([key,f])=>[key,nativeFact(f)]));
  if(readiness&&!readiness.fabric.usable)native.warehouse_preshrink={...native.warehouse_preshrink,evidence:native.warehouse_preshrink?.evidence??`order:${selection.id}:fabric`,waitingFor:'本单验布尚未合格或合法获准使用；预缩仍等待原质量放行'};
  const make=(references:Record<string,CalculationAnchor>,overrides:Partial<CalculationRouteInput>={})=>buildSlaCalculationRoute({observationMode:'instance',range:selection.range,conditions,anchors:references,values,unifiedSource:source,development:context.development.values,developmentSource:`开发独立标准 v${context.development.version}`,native,requireContractReady:selection.range==='bulk_craft',...(adoption?{preparationMinutes:{draft:adoption.standards.draftMinutes,final:adoption.standards.finalMinutes,source:`产前采用 ${adoption.adoption_id} · ${adoption.rule_version}`}}:{}),...overrides});
  context.graph=make(anchors);
  if(selection.range==='contract'){
   const states=(await db.query(`SELECT l.child_id,s.* FROM digital_production_child_links l CROSS JOIN LATERAL sourcing_contract_return_business_state(l.child_id) s WHERE l.module='sourcing' AND l.production_order_id=$1 ORDER BY l.child_id`,[selection.id])).rows;
   context.bindings.contractHistory=states;const graphs:CalculationGraph[]=[];
   for(const state of states){const refs:Record<string,CalculationAnchor>={};if(state.contract_generated_at)refs.contract_pdf_ready=instant(iso(state.contract_generated_at)!,`contract:${state.child_id}:original-first-ready`);const g=make(refs),n=g.nodes.find(row=>row.id==='contract_return')!;n.source=`原合同 ${state.child_id} · 首次回签独立业务日历`;
    if(!state.contract_return_monitor_enabled){n.applicable='no';context.limitations.push(`原合同 ${state.child_id} 未纳入回签监控，不以现行规则追评历史`);}
    else if(state.contract_returned_at)n.completedAt=instant(iso(state.contract_returned_at)!,`contract:${state.child_id}:original-first-valid-return`);
    graphs.push(this.prefix(g,state.child_id,'原合同回签'));
   }
   if(graphs.length)context.graph=this.mergeGraphs(graphs,context.graph);
  }
  if(selection.range==='bulk_craft'&&read.status==='planned'){const timing=await factoryBatchTiming(db,selection.id);context.bindings.batchScope=timing;this.batchGraphs(context,selection,read,make,anchors,timing);}
  if(selection.range==='delivery'){
   if(selection.batchId)throw new ApplicationError('VALIDATION_ERROR','回货范围以原收货与返工记录列出；不能使用大货工艺批次替代收货批次',400);
   const selected=lines.filter(l=>!selection.poLineId||l.line_id===selection.poLineId),graphs:CalculationGraph[]=[];
   for(const line of selected){const refs={...anchors};if(line.factory_date)refs.factory_delivery_date={precision:'date',value:line.factory_date,source:`PO:${line.line_id}:工厂交货约定`};if(line.customer_date)refs.customer_shipping_date={precision:'date',value:line.customer_date,source:`PO:${line.line_id}:客户交货约定`};
    const ownNative:NonNullable<CalculationRouteInput['native']>={};for(const key of ['garment_inspection','garment_packing','garment_rework']){const fact=facts[`${key}:${line.line_id}`];if(fact)ownNative[key]=nativeFact(fact);}
    const produced=await factoryProductionCompletion(db,selection.id,[line.line_id]);
    if(produced.actualDate)refs.factory_production_finished={precision:'date',value:produced.actualDate,source:`PO:${line.line_id}:原厂单生产完成业务日期`};
    const packing=facts[`garment_packing:${line.line_id}`];if(packing?.startedAt)refs.original_packing_conditions_ready=instant(packing.startedAt,packing.evidence);
    if(packing?.batchCoverageComplete===false){ownNative.garment_packing={...ownNative.garment_packing,evidence:packing.evidence,waitingFor:'本 PO 仍有未覆盖数量，不能用首批装箱窗口代表全单'};}
    const ownRework=read.status==='planned'?read.rework.windows.filter(w=>w.lineId===line.line_id):[];
    const g=make(refs,{native:ownNative,conditions:{...conditions,rework:ownRework.length?'yes':'no'}});this.appendNativeWindows(g,read,line.line_id);graphs.push(this.prefix(g,line.line_id,`PO ${line.po_number??'号码待核'} · ${line.color}`));
   }
    context.graph=this.mergeGraphs(graphs,context.graph);context.bindings.poLines=selected;
  }else if(selection.batchId&&selection.range!=='bulk_craft')throw new ApplicationError('VALIDATION_ERROR','所选演算范围不接受工艺批次',400);
  if(selection.range==='preparation'){
   const draft=await preparationWindow(db,selection.id,'draft'),final=await preparationWindow(db,selection.id,'final');
   if(conditions.preparation==='adopted')for(const [kind,window]of [['draft',draft],['final',final]] as const){
    const node=context.graph.nodes.find(n=>n.id===`preparation_${kind}`)!,key=`preparation-window:${selection.id}:${kind}`;
    node.anchorKey=key;node.source=`原独立制单${kind==='draft'?'草稿':'正式'}窗口 · ${adoption!.adoption_id}`;
    if(window.startedAt){context.graph.anchors[key]=instant(window.startedAt,node.source);node.minutes=window.minutes;}
    else node.waitingFor=window.reason??'尚未建立可信的原制单窗口，不以当前就绪时间重新起算';
    if(window.completedAt)node.completedAt=instant(window.completedAt,`${node.source}:原办理事实`);
   }
   context.bindings.preparation={adoption,retainLegacy,readinessRevision:readiness?.revision??null,finalReasons:readiness?.finalReasons??[],draft,final,instruction};if(readiness?.finalReasons.length)context.limitations.push(...readiness.finalReasons);
  }
  context.identity={kind:'order',id:selection.id,sourceId:order.source_id??null,orderId:selection.id,round:instruction?.source_round??null,label:`${order.design_style_no} · ${selection.poLineId?'所选 PO':'本单适用范围'}`};
  context.bindings.orderIdentity={orderId:selection.id,sourceId:order.source_id??null,sourceVersion:document?.version??null,instructionVersion:instruction?.version??null,poLines:lines,adoption};
 }
 private prefix(graph:CalculationGraph,prefix:string,label:string):CalculationGraph{
  const id=(v:string)=>`${prefix}/${v}`,copy=structuredClone(graph);
  copy.anchors=Object.fromEntries(Object.entries(copy.anchors).map(([key,value])=>[id(key),value]));
  copy.nodes=copy.nodes.map(n=>({...n,id:id(n.id),label:`${label} · ${n.label}`,dependsOn:n.dependsOn.map(id),anchorKey:n.anchorKey?id(n.anchorKey):null,targetKey:n.targetKey?id(n.targetKey):null,includedIn:n.includedIn?id(n.includedIn):null}));copy.endIds=copy.endIds.map(id);if(copy.startIds)copy.startIds=copy.startIds.map(id);return copy;
 }
 private mergeGraphs(graphs:CalculationGraph[],base:CalculationGraph):CalculationGraph{return graphs.length?{...base,nodes:graphs.flatMap(g=>g.nodes),anchors:Object.assign({},...graphs.map(g=>g.anchors)),endIds:graphs.flatMap(g=>g.endIds),startIds:graphs.flatMap(g=>g.startIds??[])}:base;}
 private batchGraphs(context:SlaCalculationContext,selection:Extract<SlaCalculationSelection,{mode:'instance'}>,read:Extract<Awaited<ReturnType<SlaOrderService['readWithClient']>>,{status:'planned'}>,make:(anchors:Record<string,CalculationAnchor>,overrides?:Partial<CalculationRouteInput>)=>CalculationGraph,anchors:Record<string,CalculationAnchor>,timing:Awaited<ReturnType<typeof factoryBatchTiming>>){
  const windows=read.factory?.windows??[];
  const sends=windows.filter(w=>w.kind==='process_logistics'&&(!selection.batchId||w.key===selection.batchId)&&(!selection.poLineId||w.lineIds.includes(selection.poLineId)));
  if(selection.batchId&&!sends.length)digitalNotFound();
  if(!sends.length){if(read.factory?.craftKey!==null)context.limitations.push('本范围尚无可归属的原生发工艺批次；不假造发出或回收时点');return;}
  const graphs=sends.flatMap((send,index)=>{
   const refs={...anchors};if(send.enteredAt)refs.cut_craft_dispatched=instant(send.enteredAt,send.evidence);
   const key=read.factory!.craftKey!,segments:CalculationGraph[]=[];
   const origin={evidence:send.evidence,minutes:send.minutes,...(send.enteredAt?{startedAt:send.enteredAt}:{})};
   for(const batch of timing?.ledger.batches.filter(b=>b.sendFactId===send.key)??[])for(const line of batch.rows.filter(l=>(!selection.poLineId||l.lineId===selection.poLineId)&&(l.available>0||l.sent>0))){
    const qc=windows.find(w=>w.kind==='bulk_qc'&&w.key===batch.factId),dispatch=windows.find(w=>w.kind==='warehouse_dispatch'&&w.key===`${batch.factId}:${line.lineId}`);
    const own:NonNullable<CalculationRouteInput['native']>={[key]:{...origin,...(batch.occurredAt?{completedAt:batch.occurredAt}:{})},bulk_qc:{evidence:qc?.evidence??`factory-return:${batch.factId}:PO:${line.lineId}`,...(qc?{minutes:qc.minutes}:{}),...(batch.occurredAt?{startedAt:batch.occurredAt}:{}),...(line.checkedAt?{completedAt:line.checkedAt}:{})},warehouse_dispatch:{evidence:dispatch?.evidence??`factory-return:${batch.factId}:PO:${line.lineId}:dispatch`,...(dispatch?{minutes:dispatch.minutes}:{}),...(dispatch?.enteredAt?{startedAt:dispatch.enteredAt}:{}),...(dispatch?.completedAt?{completedAt:dispatch.completedAt}:{}),...(!line.allowDispatch?{waitingFor:'本批 PO 尚未质检合格或取得原允许发厂决定'}:{})}};
    segments.push(this.prefix(make(refs,{native:own}),`${send.key}:return:${batch.factId}:${line.lineId}`,`原生工艺批次 ${index+1} · 已回本批 ${line.returned}件`));
   }
   for(const line of timing?.ledger.pendingSends.find(s=>s.factId===send.key)?.rows.filter(l=>l.remaining>0&&(!selection.poLineId||l.lineId===selection.poLineId))??[]){
    segments.push(this.prefix(make(refs,{native:{[key]:origin}}),`${send.key}:pending:${line.lineId}`,`原生工艺批次 ${index+1} · 待回 ${line.remaining}件`));
   }
   return segments;
  });
  context.graph=this.mergeGraphs(graphs,context.graph);
  const scope=timing?.ledger.totals.filter(line=>!selection.poLineId||line.lineId===selection.poLineId),covered=Boolean(scope?.length&&scope.every(line=>line.craftRemaining===0));
  if(!selection.batchId&&!covered){const marker:CalculationNode={id:'uncovered_craft_scope',label:'尚未发工艺或范围未覆盖的数量',stage:5,parameterKey:'uncovered_craft_scope',applicable:'unknown',countsProgress:false,kind:'unlimited',minutes:null,offsetDays:null,dependsOn:[],anchorKey:null,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:'原生工艺数量账范围',binding:null};context.graph.nodes.push(marker);context.graph.endIds.push(marker.id);}
 }
 private appendNativeWindows(graph:CalculationGraph,read:Awaited<ReturnType<SlaOrderService['readWithClient']>>,lineId:string){
  if(read.status!=='planned')return;
  const logistics=read.nodes.find(n=>n.id===`return_logistics:${lineId}`)?.logisticsWindows??[];
  if(logistics.length)graph.nodes=graph.nodes.filter(n=>n.id!=='return_logistics');
  for(const [index,window]of logistics.entries()){
   const minutes=window.estimatedMinutes;graph.nodes.push({id:`native-logistics:${index}`,label:`${window.supplierName} · 原日期型回货物流预计`,stage:7,parameterKey:'return_logistics',applicable:'yes',countsProgress:false,kind:minutes!==null?'estimate':'unlimited',minutes,offsetDays:null,dependsOn:[],anchorKey:null,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:`${window.evidence} · 冻结 ${window.snapshotId??'版本依据缺失'}`,binding:minutes!==null?{group:'unified',key:'return_logistics'}:null,independent:true,...(window.arrivalRange?{estimateRange:{...window.arrivalRange,shippedOn:window.shippedOn,source:window.evidence,actualDispatchedAt:null}}:{})});
  }
  const windows=[...read.garments.windows.filter(w=>w.lineId===lineId).map(w=>({...w,label:'原生本批到仓质检',parameterKey:'garment_inspection'})),...read.rework.windows.filter(w=>w.lineId===lineId).map(w=>({...w,label:'原生本轮返工作业',parameterKey:'garment_rework'}))];
  for(const [index,w]of windows.entries()){
   const key=`native-window:${w.parameterKey}:${index}`;if(w.startedAt)graph.anchors[key]=instant(w.startedAt,w.evidence);
   const minutes=w.startedAt&&w.deadline?(Date.parse(w.deadline)-Date.parse(w.startedAt))/60000:null;
   graph.nodes.push({id:key,label:w.label,stage:7,parameterKey:w.parameterKey,applicable:'yes',countsProgress:false,kind:minutes!==null&&minutes>0?'duration':'unlimited',minutes,offsetDays:null,dependsOn:[],anchorKey:key,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:`${w.evidence} · 冻结 ${w.snapshotId??'版本依据缺失'}`,binding:minutes!==null?{group:'unified',key:w.parameterKey}:null,independent:true,...(w.completedAt?{completedAt:instant(w.completedAt,w.evidence)}:{})});
  }
 }
}
