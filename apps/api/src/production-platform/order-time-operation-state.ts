import {developmentSourceLifecycle,preorderDraftOrder,workbenchPreorderPublication} from './development-source-lifecycle.js';
import {orderTimeFactoryCommitments,outstandingFactoryCommitments} from './order-time-factory-commitments.js';
import {publicationFormalInput} from './order-time-publication-intent.js';
import {beijingCalendarDate,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import type {SeriesRoute} from '@dx-rework/contracts/digital-series-plan';
import {orderTimeCreated} from './order-time-created.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {frameworkScopeInputs,overlayFrameworkCompletion} from './order-time-framework-route.js';
import {styleLabelObservedFact} from './style-label-readiness.js';
import {orderTimeWashingReworkState,attachWashingReworkInput,retainedWashingReworkTargets} from './order-time-washing-rework.js';
import type {OrderTimeWashingReworkChanges} from '@dx-rework/contracts/order-time-washing-rework';
import {evaluateFrameworkSubmission} from './order-time-framework-submission.js';
import {hasBothBuiltinCrafts} from '@dx-rework/contracts/digital-craft';
import type {Pool,PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {SlaAnchor,SlaTime} from '@dx-rework/domain/digital-sla-plan';
import {FrozenOrderTimePlanSchema,orderTimeRule,type OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {CraftStepChoicesSchema,craftStepIdentity,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {OrderTimeOperationSchema,type OrderTimeOperation,type OrderTimeProductionRoute,type OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';
import {isDevelopmentMaterialPlaceholder,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {developmentSlaRoute,developmentSlaPlan} from './development-sla-enrollment.js';
import {readDevelopmentRevisionPlan} from './development-round-plan.js';
import {FixedTimelineAdoptionRepository,type FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {fixedDevelopmentWork} from './fixed-development-work.js';
import {fixedOrderWork} from './fixed-order-work.js';
import type {FixedWorkInputs} from './fixed-work-definition.js';
import {OrderTimePlanRepository,type OrderTimeInput} from './order-time-plan-repository.js';
import {currentOrderTimeCompany,historicalOrderTimeCompany,orderTimeAdmission} from './order-time-admission.js';
import {formalDevelopmentHandoverAvailable} from './development-formal-handover-evidence.js';
import {orderTimeInputFromRoute,orderTimeCheck,orderTimeBegunStates,type OrderTimeNativeProgress} from './order-time-request-plan.js';
import {formalRemainingSchedule} from './order-time-formal-arrangement.js';
import {nativeTaskReadiness} from './task-readiness-facts.js';
import {orderTimeBulkSteps,orderTimeStoredBulkSteps} from './order-time-route-identities.js';
import {preparationAvailable,preparationHandoverCurrent,preparationInvestmentScope,currentPreparationMaterial,currentPreparationMaterials,preparationContext,preparationMaterialHistory,directInvestmentInstruction,instructionInvestmentMaterials} from './preparation-material-repository.js';
import {materialReadiness} from './development-material-readiness.js';
import {reuseJourneySnapshotReads} from './journey-snapshot-reads.js';

type DB=PoolClient;
const conflict=(message:string):never=>{throw new ApplicationError('ORDER_TIME_CONFLICT',message,409);};
const alias:Record<string,string>={development_craft_return:'development_craft_confirmation',external_pattern:'development_external_pattern',production_sheet:'production_instruction',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',bulk_cutting:'bulk_cutting',factory_production_work:'production_reporting',factory_production:'factory_production_qc',garment_packing:'packing',garment_inspection:'receiving_inspection'};
const steps=(document:Pick<DevelopmentDocument,'craft'|'craftSteps'>):CraftStepChoice[]=>document.craft==='无'?[]:CraftStepChoicesSchema.parse(document.craftSteps??[{craftKind:document.craft==='绣花'?'embroidery':'printing',sequence:1}]);
const scoped=(operation:OrderTimeOperation):BusinessTimeScope|null=>operation.kind==='arrangement'?operation.resource:'sourceId'in operation?{kind:'source',id:operation.sourceId}:'orderId'in operation?{kind:'order',id:operation.orderId}:null;
export const orderTimeOperationScope=scoped;

/** Original actor and original native rows, all on the caller's single client.
 * The public operation contains intent, never an authorized actor or a DTO. */
export async function loadOrderTimeOperation(database:Pool,db:DB,actor:TrustedActorContext,raw:OrderTimeOperation,time:BusinessTime,changes:Record<string,OrderTimeRule>={},washingChanges:OrderTimeWashingChanges=[],rewashChanges:OrderTimeWashingReworkChanges=[],purpose:'command'|'native-refresh'|'cockpit-instruction-read'='command'){
 const operation=OrderTimeOperationSchema.parse(raw),resource=scoped(operation),policy=new DigitalProductionAccessPolicy(db);
 if(resource)await policy.assert(actor,resource.kind,resource.id,'technical');
 const sourceId=resource?.kind==='source'?resource.id:resource?.kind==='order'?(await db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[resource.id])).rows[0]?.source_id??null:null;
 const source=sourceId?(await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0]??digitalNotFound():null;
 const lifecycle=sourceId?await developmentSourceLifecycle(db,sourceId):null;
 const preorderPublication=sourceId&&source?.workbench_generated_number&&!lifecycle?.is_draft?await workbenchPreorderPublication(db,sourceId):null;
 if(resource?.kind==='source'&&lifecycle?.is_draft&&operation.kind!=='development_publish')
  return conflict('开发草稿尚未有效发布，请先沿原流程发布');
 if(resource?.kind==='source'&&preorderPublication&&operation.kind!=='confirm_order')
  return conflict('预下单沿正式确认启用时效，当前来源不采用时效计划');
 const order=resource?.kind==='order'?(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1',[resource.id])).rows[0]??digitalNotFound():null;
 const designerId=source?.created_by??order?.created_by??actor.actorId;
 const designer=isRootActor(actor)||actor.actorId===designerId&&actor.actorRoles.includes('sample_designer')&&actor.authorizationCapabilities?.includes('pattern_room:orders:create')&&await policy.activeRole(actor.actorId,'sample_designer');
 const manager=isRootActor(actor)||actor.actorRoles.some(role=>['owner_group','production_management'].includes(role))&&Boolean(await policy.activeRole(actor.actorId,'owner_group')||await policy.activeRole(actor.actorId,'production_management'));
 const main=Boolean(order&&order.primary_merchandiser_id===actor.actorId&&actor.actorRoles.includes('order_merchandiser')&&await policy.activeRole(actor.actorId,'order_merchandiser'));
 // This internal probe returns readiness to a read-only cockpit caller. It
 // does not provide command admission or change the public operation routes.
 const cockpitReader=purpose==='cockpit-instruction-read'&&operation.kind==='instruction_publish'
  &&actor.actorRoles.includes('pmc')&&await policy.activeRole(actor.actorId,'pmc');
 if(!designer&&!manager&&!main&&!cockpitReader)digitalForbidden();
 const saved=resource?await new OrderTimePlanRepository(db).current(resource):null;
 const inherited=resource?.kind==='order'&&sourceId?await new OrderTimePlanRepository(db).current({kind:'source',id:sourceId}):null;
 const original=saved?.input.plan??inherited?.input.plan??orderTimeAdmission(db)?.plan,oldResource=source&&!preorderPublication&&!lifecycle?.is_draft&&!source.order_time_managed?{kind:'source' as const,id:source.source_id}:order&&!order.order_time_managed?{kind:'order' as const,id:order.production_order_id}:null;
 const company=original?.company??(oldResource?await historicalOrderTimeCompany(db,oldResource):await currentOrderTimeCompany(db));
 if(!company)return conflict('请先在生产管理设置保存本次公司时效，再办理本单时效');
 const plan=FrozenOrderTimePlanSchema.parse(original?{...original,overrides:{...original.overrides,...changes},revision:Object.keys(changes).length?original.revision+1:original.revision}:{version:'order-time-plan-v1',company,overrides:changes,revision:1});
 const initial:FixedWorkInputs={data:{unified:{configurationId:'order-time-preflight',snapshotRef:'order-time-preflight',values:{ruleVersion:'20261023.1',parameters:{}}},planning:null,development:null,orderTimePlan:plan}};
 const washing=order&&plan.company.framework?await (await import('./order-time-washing.js')).orderTimeWashingState(db,order.production_order_id,washingChanges):null;
 if(washingChanges.length&&!washing)conflict('请从已采用三层时效的正式订单调整洗水');
 const sourceVersion:Record<string,unknown>={operation,sourceId,orderId:order?.production_order_id??null,orderVersion:order?.version??null,planRevision:saved?.revision??0,companyReference:company.reference};
 const instructionDraft=order?(await db.query('SELECT * FROM digital_instruction_documents WHERE production_order_id=$1',[order.production_order_id])).rows[0]:null;
 const selectedInstruction=operation.kind==='instruction_publish'?instructionDraft:instructionDraft?.published_version?(await db.query('SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 AND version=$2',[order!.production_order_id,instructionDraft.published_version])).rows[0]:null;
 const retainedSource=saved?.input.work.map(work=>work.canonicalWorkRef?.match(/^source:([^:]+):round:(\d+):/)).find(match=>match?.[1]===sourceId);
 const sourceRound=selectedInstruction?.source_round??(resource?.kind==='order'&&retainedSource?Number(retainedSource[2]):undefined);
 let document=sourceId?(await developmentDocumentRow(db,sourceId,sourceRound))??null:null;
 if(operation.kind==='development_publish'&&source?.workbench_generated_number&&preorderDraftOrder(document?.document))
  return conflict('编号预下单须沿预下单发布及正式确认入口办理');
 if(preorderPublication)sourceVersion.preorderPublication=preorderPublication.event_id;
 if(order)sourceVersion.instructionVersion=selectedInstruction?.version??null;
 if(operation.kind==='development_revision'){
  if(operation.input.revision)conflict('客户复版须沿原版单入口建立，之后按原审批发布');
  const draft=(await db.query('SELECT version,payload FROM digital_development_round_drafts WHERE source_id=$1',[operation.sourceId])).rows[0]??conflict('请先保存本单复版资料');
  if(draft.payload.origin!=='内部发现')conflict('客户复版先建立独立草稿，再在该草稿发布时核算本单时效');
  const selected=await readDevelopmentRevisionPlan(db,sourceId!,draft.payload,document!.document,(await developmentSlaPlan(db,sourceId!))?.route_schema_version);
  sourceVersion.revisionDraftVersion=draft.version;document={...document,document:draft.payload.document,round_number:operation.input.basedOnRound+1,output_kind:draft.payload.outputKind,revision:{route_nodes:selected.route,inherited:selected.inherited}};
 }
 if(document){sourceVersion.documentVersion=document.version;sourceVersion.round=document.round_number??1;}
 const factoryCommitments:NonNullable<OrderTimeInput['factoryCommitments']>=[];
 const round=document?.round_number??1,development=document?.document as DevelopmentDocument|null;
 let frameworkRoute:SeriesRoute|undefined;
 let route:Pick<FixedTimelineInput,'work'|'consumers'>,production:OrderTimeProductionRoute|null=null,dates:Array<{po:string;date:string|null}>=[],optionalDevelopmentGoal=false;
 const styleNo=source?.design_style_no??order?.design_style_no??(operation.kind==='direct_order'?operation.input.designStyleNo:''),missing:string[]=[];
 const adopted=sourceId?await new FixedTimelineAdoptionRepository(db).existing({kind:'source',id:sourceId},round):null;
 const kinds=document?.revision?.route_nodes??['development_materials',...developmentSlaRoute(development??{craft:'无',washing:'免洗'},document?.output_kind??'整件样板',2)];
 const built=development?fixedDevelopmentWork(initial,sourceId!,round,kinds,steps(development).map(step=>({...step,stepId:adopted?.input.craftSteps?.find(old=>craftStepIdentity(old)===craftStepIdentity(step))?.stepId??`planned-${round}-${craftStepIdentity(step)}`})),hasBothBuiltinCrafts(steps(development)),development.washing,development.materials.some(material=>material.category==='辅料'&&material.requiredThisRound!==false)):null;
 // A new native revision is new work, not the original node under the same
 // display label. Preserve the original target identity and allocate this
 // round's work its own keys; inherited completed work is not scheduled again.
 const dev=built&&round>1?{...built,previous:built.previous?built.previous+':round:'+round:null,route:built.route.map(node=>({...node,nodeId:node.nodeId+':round:'+round})),work:built.work.map(work=>({...work,id:work.id+':round:'+round,dependsOn:work.dependsOn.map(id=>id+':round:'+round),...(work.includedIn?{includedIn:work.includedIn+':round:'+round}:{})}))}:built;
 const publicationOrder=publicationFormalInput(development,{serverToday:beijingCalendarDate(new Date(time.now)),minimumInitialCustomerDate:minimumInitialCustomerDate(new Date(time.now)),orderTimeEnabled:true},Boolean(plan.company.framework));
 const includesProduction=resource?.kind==='order'||operation.kind==='confirm_order'||operation.kind==='direct_order'||Boolean(publicationOrder);
 let materialInvestmentScope:OrderTimeInput['materialInvestmentScope'];
 let materialInvestmentResolutionRef:string|undefined;
 if(includesProduction){
  const priorFramework=saved?.input.frameworkPlans;
  const priorScope=saved?.input.materialInvestmentScope;
  let preorder=Boolean(priorScope?.reference.startsWith('preorder:'));
  // The original order handover, rather than the current attachment of a
  // development source, identifies an order-born first material target.
  const firstOrderTarget=Boolean(order&&priorFramework&&priorScope===null&&operation.kind==='arrangement');
  if(plan.company.framework&&firstOrderTarget&&await preparationAvailable(db)){
   const orderId=String(order.production_order_id);
   const handover=await currentPreparationMaterial(db,orderId,'design_handover');
   const orderBasis=handover?.resource.kind==='order'&&handover.resource.id===orderId&&handover.state==='ready'&&handover.valid
    ?handover.investmentScopeBasis:undefined;
   const instruction=orderBasis?.orderInstructionVersion?await directInvestmentInstruction(db,orderId):null;
   const scope=instruction?preparationInvestmentScope(instructionInvestmentMaterials(instruction.document),'instruction'):null;
   materialInvestmentScope=scope?.rows.length&&orderBasis?.fingerprint===scope.fingerprint
    ?{fabric:scope.fabric,accessories:scope.accessories,reference:'order:'+orderId+':'+scope.fingerprint}:null;
  }else if(plan.company.framework&&!priorFramework&&sourceId&&document&&development){
   const scope=preparationInvestmentScope(development.materials);
   if(await preparationAvailable(db)){
    const evidence=(await db.query(`SELECT state,body,NOT EXISTS(SELECT 1
      FROM jsonb_array_elements_text(coalesce(body->'evidenceIds','[]'::jsonb)) file(id)
      WHERE NOT EXISTS(SELECT 1 FROM attachments WHERE attachment_id::text=file.id AND status='ready')) AS files_ready
     FROM digital_preparation_material_versions WHERE resource_kind='source' AND resource_id=$1 AND kind='design_handover' AND scope_ref='whole'
     ORDER BY recorded_at DESC,version DESC LIMIT 1`,[sourceId])).rows[0];
    preorder=Boolean(evidence?.body?.investmentScopeBasis?.preorder&&evidence.state==='ready'&&evidence.files_ready
     &&preparationHandoverCurrent(evidence.body,{version:document.version,materials:development.materials}));
   }
   materialInvestmentScope=scope.rows.length?{fabric:scope.fabric,accessories:scope.accessories,
    reference:(preorder?'preorder:':'source:')+sourceId+':round:'+round+':'+scope.fingerprint}:null;
  }else if(plan.company.framework)materialInvestmentScope=priorFramework?priorScope:null;
  // Only an explicit formal arrangement can resolve the first date on an
  // already identified material scope. Match the same native handover exactly.
  const pendingInvestment=priorScope&&Object.values(priorFramework??{}).some(plan=>plan.milestones.some(row=>
   row.key==='material_investment'&&row.target.at===null&&row.materialInvestmentTargetBasis?.scope?.reference===priorScope.reference));
  if(order&&manager&&pendingInvestment&&priorScope&&operation.kind==='arrangement'&&purpose==='command'&&await preparationAvailable(db)){
   const orderId=String(order.production_order_id),handover=await currentPreparationMaterial(db,orderId,'design_handover');
   const basis=handover?.state==='ready'&&handover.valid?handover.investmentScopeBasis:undefined;
   if(basis&&handover){
    const reference=handover.resource.kind==='order'&&handover.resource.id===orderId&&basis.orderInstructionVersion
     ?'order:'+orderId+':'+basis.fingerprint
     :handover.resource.kind==='source'&&handover.resource.id===sourceId&&basis.sourceDocumentVersion
      ?(basis.preorder?'preorder:':'source:')+sourceId+':round:'+round+':'+basis.fingerprint:null;
    if(reference===priorScope.reference){
     materialInvestmentResolutionRef=reference;
     sourceVersion.materialInvestmentHandover={id:handover.recordId,version:handover.version,reference};
     const rule=orderTimeRule(plan,'material_investment')?.rule;
     if(priorScope.accessories&&rule?.kind==='event'&&!rule.accessoriesLeadTime){
      const published=await currentOrderTimeCompany(db),next=published?.nodes.material_investment;
      if(next?.kind==='event'&&next.accessoriesLeadTime){
       plan.overrides.material_investment={...rule,accessoriesLeadTime:next.accessoriesLeadTime};
       if(original&&plan.revision===original.revision)plan.revision++;
       sourceVersion.materialInvestmentStandardReference=published!.reference;
      }
     }
    }
   }
  }
  let lines:Array<{id:string;po:string;date:string|null;customerDateVersion?:number}>;
  if(order){
   const rows=(await db.query('SELECT line_id,coalesce(po_number,formal_style_no) AS po,customer_warehouse_arrival_date::text AS date,customer_date_version,factory_delivery_date::text AS factory_date,factory_date_version,factory_date_source FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[resource!.id])).rows;
   for(const row of rows)if(row.factory_date)factoryCommitments.push({lineId:row.line_id,label:row.po??row.line_id,date:row.factory_date,version:Number(row.factory_date_version),source:row.factory_date_source??'原PO工厂交货日期'});
   lines=rows.map(row=>({id:row.line_id,po:row.po??'',date:row.date,customerDateVersion:Number(row.customer_date_version)}));
   // An ordinary arrangement reads the effective publication, never a main
   // merchandiser's uncommitted route draft. Only its explicit publish intent
   // evaluates that saved candidate and commits route plus timing together.
   const instruction=selectedInstruction?.document as InstructionDocument|undefined;
   if(instruction){const label=instruction.secondaryCraft==='沿用开发'?development?.craft:instruction.secondaryCraft,chosen=instruction.secondaryCraft==='沿用开发'?development?.craftSteps:instruction.craftSteps;
    production={craftSteps:label==='无'?[]:label?CraftStepChoicesSchema.parse(chosen??[{craftKind:label==='绣花'?'embroidery':'printing',sequence:1}]):null,preshrink:instruction.preshrink==='待确认'?null:instruction.preshrink==='需要预缩'};
   }else production=order.order_time_managed?(await db.query('SELECT production_route FROM digital_order_time_subjects WHERE production_order_id=$1',[order.production_order_id])).rows[0]?.production_route??development?.productionPlanning??null:development?.productionPlanning??null;
  }else{
   const value=operation.kind==='confirm_order'||operation.kind==='direct_order'?operation.input:development!.customerOrderDraft!.order;
   lines=value.lines.map((line,index)=>({id:`planned-po-${index+1}`,po:line.formalPoNo??line.poNumber??line.formalStyleNo??'',date:line.customerWarehouseArrivalDate===undefined?line.deliveryDate??null:line.customerWarehouseArrivalDate}));
   production=operation.kind==='direct_order'?operation.route:operation.kind==='confirm_order'?operation.input.productionPlanning??development?.productionPlanning??null:development?.productionPlanning??null;
  }
  if(production?.craftSteps===null||!production)missing.push('请在原单确认大货工艺及先后顺序');
  if(production?.preshrink===null||!production)missing.push('请在原单确认大货是否预缩');
  if(!dev&&operation.kind!=='direct_order'&&!(order?.order_time_managed&&!sourceId))missing.push('本单开发路线还没确认');
  dates=lines.map(line=>({po:line.po,date:line.date}));
  const orderAdoption=order?await new FixedTimelineAdoptionRepository(db).existing({kind:'order',id:order.production_order_id}):null;
  const preparation=order?(await db.query('SELECT preparation_id FROM digital_bulk_preparations WHERE production_order_id=$1 AND instruction_version=$2 ORDER BY created_at DESC LIMIT 1',[order.production_order_id,sourceVersion.instructionVersion??0])).rows[0]:null;
  const actualRoute=orderAdoption&&preparation?await (await import('./fixed-order-route.js')).readFixedOrderRoute(db,orderAdoption,preparation.preparation_id):null;
  const selectedSteps=actualRoute?.craftSteps??orderTimeStoredBulkSteps(saved?.input),originalSteps=selectedSteps.length?selectedSteps:orderAdoption?.input.craftSteps??[];
  const declaredSteps=orderTimeBulkSteps(order?.production_order_id??'planned-order',Number(sourceVersion.instructionVersion??0),production?.craftSteps??[],originalSteps);
  const colorMatching=order?.requires_color_matching??(operation.kind==='direct_order'||operation.kind==='confirm_order'?operation.input.requiresColorMatching:development?.customerOrderDraft?.order.requiresColorMatching);
  frameworkRoute=colorMatching===true?'A':colorMatching===false?'B':undefined;
  if(plan.company.framework&&!frameworkRoute)throw new ApplicationError('VALIDATION_ERROR','请在原单确认是否需要对色',400);
  for(const line of lines)if(!line.date)missing.push(`${line.po||'本PO'}的客户交期尚未填写`);
  const bulk=fixedOrderWork(initial,order?.production_order_id??'planned-order',sourceId??'planned-source',round,production?.preshrink?'需要预缩':'无需预缩',declaredSteps,hasBothBuiltinCrafts(declaredSteps),dev,lines.map(line=>({line_id:line.id,goal:line.date?{precision:'date',value:line.date,source:'本单客户交期'}:{precision:'unknown',reason:'请填写本单客户交期'},customerDateVersion:line.customerDateVersion??1,...(washing?.get(line.id)?.document?{washing:washing.get(line.id)!.document!.arrangement}:{})})),frameworkRoute,{preorder,keepLegacyGraph:Boolean(priorFramework&&priorScope===undefined)});
  route={work:bulk.work,consumers:bulk.consumers.map(consumer=>({...consumer,lineId:resource?.kind==='order'?consumer.lineId:null}))};
 }else{
  if(!dev)return conflict('请先保存本单开发资料');
  optionalDevelopmentGoal=!development?.returnDate;
  route={work:dev.work,consumers:[{scopeRef:`source:${sourceId}:round:${round}`,lineId:null,nodeIds:dev.work.map(work=>work.id),ends:dev.previous?{[dev.previous]:development?.returnDate?{precision:'date',value:development.returnDate,source:'本轮样板要求完成日'}:{precision:'unknown',reason:'请填写样板要求完成日'}}:{}}]};
  dates=[{po:'样板',date:development?.returnDate??null}];
 }
 const goals=new Map<string,SlaAnchor>();
 for(const [index,consumer]of route.consumers.entries()){
  const date=dates[index]?.date;if(!date)continue;
  const previous=saved?.input.scopes.find(scope=>scope.scopeRef===consumer.scopeRef&&scope.lineId===consumer.lineId)?.customerGoal;
  // Rebuilding the same dated scope is not a new customer-date approval.
  // Keep its immutable evidence; changed dates still face repository guards.
  goals.set(consumer.scopeRef,previous?.precision==='date'&&previous.value===date?structuredClone(previous):{precision:'date',value:date,source:'本单已填写的客户或样板日期'});
 }
 const value=orderTimeInputFromRoute(plan,route,goals,!missing.length,missing,sourceId?{kind:'source',id:sourceId}:resource??undefined);
 if(materialInvestmentScope!==undefined)value.materialInvestmentScope=materialInvestmentScope;
 if(plan.company.framework){value.factoryCommitments=factoryCommitments;sourceVersion.factoryCommitments=factoryCommitments;}
 if(rewashChanges.length&&(!manager||operation.kind!=='arrangement'||!order||!saved?.input.frameworkPlans))conflict('请由原有权人员在已采用的本单安排中新增返洗工作');
 if(rewashChanges.length&&(Object.keys(changes).length||washingChanges.length))conflict('新增返洗请保留原节点安排，其他调整沿原入口另行办理');
 const hasWashing=Boolean(rewashChanges.length||saved?.input.rewashing?.length||saved?.input.work.some(work=>/^bulk_(factory|return)_washing/.test(work.parameterKey))
  ||washing&&[...washing.values()].some(row=>row.document&&row.document.arrangement.mode!=='none'));
 const rewashing=order&&plan.company.framework&&saved&&hasWashing?await orderTimeWashingReworkState(db,order.production_order_id,saved,rewashChanges):null;
 const rewashBounds=rewashing?attachWashingReworkInput(value,rewashing.rows):{};
 const tasks=resource?(await db.query(`SELECT t.task_id,t.route_version,t.state,t.entered_at,t.entered_quality,t.completed_at,t.completed_quality,a.task_kind,a.source_id,a.production_order_id,p.step_id,
  d.due_at,d.sla_basis,EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned
  FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) LEFT JOIN digital_timeline_task_positions p USING(task_id)
  LEFT JOIN LATERAL(SELECT due_at,sla_basis FROM digital_production_deadline_revisions WHERE task_id=t.task_id AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1)d ON true
  WHERE ($1::uuid IS NOT NULL AND a.source_id=$1) OR ($2::uuid IS NOT NULL AND a.production_order_id=$2)`,[sourceId,order?.production_order_id??null])).rows:[];
 const ready=await nativeTaskReadiness(db,tasks.map(task=>task.task_id)),progress=new Map<string,OrderTimeNativeProgress>();
 const pendingTasks=new Set(tasks.filter(task=>task.state==='pending'&&!task.returned).map(task=>task.task_id)),pendingWork=new Set<string>();
 for(const work of value.work){
  const reference=work.canonicalWorkRef??work.id,match=reference.match(/^source:([^:]+):round:(\d+):/),step=reference.match(/:step:([^:]+):/)?.[1],key=alias[work.parameterKey]??work.parameterKey;
  const matched=tasks.filter(task=>task.state!=='cancelled'&&task.task_kind===key&&(!match||task.source_id===match[1]&&task.route_version===Number(match[2]))&&(!step||task.step_id===step));
  if(matched.length!==1)continue;const task=matched[0]!,native=ready.get(task.task_id),complete=task.state==='completed'&&!task.returned;
  if(pendingTasks.has(task.task_id))pendingWork.add(reference);
  progress.set(reference,{completed:complete,actualAt:complete&&['现场登记','已核实'].includes(task.completed_quality)&&task.completed_at?new Date(task.completed_at).toISOString():null,
   readyAt:native?.tracked?native.firstReadyAt:['现场登记','已核实'].includes(task.entered_quality)&&task.entered_at?new Date(task.entered_at).toISOString():null,
   deadline:task.due_at?new Date(task.due_at).toISOString():null,calendar:task.sla_basis?.calendarRef??'continuous'});
 }
 // The same exact included-return requirement as the live R5-06 reader.
 for(const work of value.work.filter(work=>['development_printing','development_embroidery'].includes(work.parameterKey))){
  const parent=progress.get(work.canonicalWorkRef??work.id),returns=value.work.filter(child=>child.includedIn===work.id&&child.parameterKey==='development_craft_return');
  if(!parent)continue;const receipt=returns.length===1?progress.get(returns[0]!.canonicalWorkRef??returns[0]!.id):null;
  parent.completed=parent.completed&&receipt?.completed===true;parent.actualAt=parent.completed?receipt!.actualAt:null;
 }
 // Existing orders use the same exact per-PO cut, native batch, accepted redo
 // and completion facts as the live reader. A candidate future route has no
 // matching native identity and therefore cannot borrow an old execution.
 if(resource&&(saved||adopted||order)){
  const {DigitalJourneyQuery}=await import('./journey-query.js');
  const timing=await new DigitalJourneyQuery(database).orderTimeProgressWithClient(reuseJourneySnapshotReads(db),resource,time.now);
  for(const work of value.work)for(const scope of value.scopes){
   // Legacy customer_sample is a sample approval, not commercial confirmation.
   if(plan.company.framework&&work.parameterKey==='customer_confirmation')continue;
   const candidates=timing.fixedSchedule?.scopes.filter(native=>native.scopeRef===scope.scopeRef||native.lineId!==null&&native.lineId===scope.lineId||resource.kind==='source'&&native.lineId===null).flatMap(native=>native.work.filter(node=>node.canonicalWorkRef===(work.canonicalWorkRef??work.id)).map(node=>({node,fact:native.facts[node.id]})))??[];
   const distinct=new Map(candidates.map(entry=>[JSON.stringify({node:entry.node.canonicalWorkRef,fact:entry.fact}),entry]));
   if(distinct.size!==1)continue;
   const {node,fact}=Array.from(distinct.values())[0]!;if(!fact)continue;
   const ready=fact.clockStart.precision==='instant'?fact.clockStart.at:null;
   const windows=fact.ownWindows??[],open=windows.filter(window=>!window.complete),deadlines=open.map(window=>window.deadline).filter((at):at is string=>Boolean(at));
   const deadline=open.length?deadlines.length===open.length?deadlines.sort().at(-1)!:null:ready&&node.responsibilityMinutes!==null&&node.responsibilityMinutes!==undefined&&node.responsibilityCalendar?(await import('./fixed-timeline-targets.js')).shiftFixedTimeline(ready,node.responsibilityMinutes,node.responsibilityCalendar):null;
   const scopedWork=scope.scopeRef+'|'+(work.canonicalWorkRef??work.id);
   if(fact.ownTaskId&&pendingTasks.has(fact.ownTaskId))pendingWork.add(scopedWork);
   progress.set(scopedWork,{completed:fact.businessCompleted,actualAt:fact.completed.precision==='instant'?fact.completed.at:null,actualDate:fact.completed.precision==='date'?fact.completed.date:null,readyAt:ready,deadline,calendar:node.responsibilityCalendar??null,
    unresolvedOverrun:open.some(window=>window.deadline&&Date.parse(window.deadline)<=Date.parse(time.now))});
  }
 }
 if(preorderPublication&&operation.kind==='confirm_order'&&sourceId){
  const context=await preparationContext(db,{kind:'source',id:sourceId});
  const facts=currentPreparationMaterials(await preparationMaterialHistory(db,context),null);
  const formalHandover=await formalDevelopmentHandoverAvailable(db);
  for(const work of value.work){
   if(work.parameterKey!=='design_handover'&&work.parameterKey!=='material_investment')continue;
   if(formalHandover&&work.parameterKey==='design_handover')continue;
   const fact=facts.find(row=>row.kind===work.parameterKey&&row.scopeRef==='whole'&&row.valid&&
    (row.state==='ready'||row.state==='partial')&&row.occurredAt&&row.occurredAt<=time.now);
   if(!fact)continue;
   const key=work.canonicalWorkRef??work.id;
   progress.set(key,overlayFrameworkCompletion(progress.get(key),{completed:fact.state==='ready',precision:'instant',occurredAt:fact.occurredAt,scopeRef:'whole'}));
  }
  sourceVersion.preorderMaterialFacts=facts.map(fact=>({id:fact.recordId,version:fact.version,valid:fact.valid}));
 }
 const preorderFormalStart=preorderPublication
  ?order?(await orderTimeCreated(db,{kind:'order',id:order.production_order_id}))?.at:operation.kind==='confirm_order'?time.now:null
  :null;
 if(preorderFormalStart)for(const [identity,fact] of progress){
  if(!fact.completed&&fact.readyAt&&fact.readyAt<preorderFormalStart)
   progress.set(identity,{...fact,readyAt:preorderFormalStart,deadline:null,unresolvedOverrun:false});
 }
 const extraSettings=new Map<string,boolean>();
 if(development){
  const began=(await db.query('SELECT 1 FROM digital_development_cycle_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,round])).rowCount!>0;
  const urgent=(await db.query("SELECT 1 FROM digital_development_urgent_events WHERE source_id=$1 AND round_number=$2 AND action='approve' LIMIT 1",[sourceId,round])).rowCount!>0;
  extraSettings.set(urgent?'development_cycle_urgent':'development_cycle_normal',began);
 }
 if(value.scopes.some(scope=>scope.shipSample))extraSettings.set('ship_sample_advance',false);
 const begunStates=orderTimeBegunStates(value,progress);
 for(const [key,rule]of Object.entries(changes)){
  if(/^bulk_(factory|return)_washing/.test(key))conflict('请在本单大货洗水安排中修改对应PO的用时');
  if(!value.work.some(work=>work.parameterKey===key)&&!extraSettings.has(key))conflict('不能修改本单不适用的节点');
  if(extraSettings.get(key)&&JSON.stringify(original?.overrides[key]??original?.company.nodes[key]??company.nodes[key])!==JSON.stringify(rule))conflict('已开始的开发周期保留原责任窗口');
  const applicable=value.work.filter(work=>work.parameterKey===key);
  if(applicable.length&&applicable.every(work=>begunStates.get(work.id)?.all)&&JSON.stringify(original?.overrides[key]??original?.company.nodes[key]??company.nodes[key])!==JSON.stringify(rule))conflict('已开始的节点保留原用时和责任时钟，请调整尚未开始的节点');
 }
 const notBefore:Record<string,SlaAnchor>={...rewashBounds};
 const unconfirmedFabric:string[]=[];
 if(development){
  const native=operation.kind==='development_revision'?null:await materialReadiness(db,sourceId!,round),byId=new Map(native?.materials.map(row=>[row.materialId,row])??[]);
  const expected=(await db.query(`SELECT DISTINCT ON(material_id) material_id,expected_date::text AS expected_date,event_id FROM digital_development_material_events WHERE source_id=$1 AND route_version=$2 AND action='修改预计日期' ORDER BY material_id,sequence DESC`,[sourceId,round])).rows;
  const waiting=development.materials.filter(material=>{const row=byId.get(material.materialId);return (row?row.required:material.requiredThisRound)&&(row?!row.supplyAvailable:!material.available);});
  const bounds=waiting.map(material=>({material,name:material.name||material.label,date:(expected.find(row=>row.material_id===material.materialId)?.expected_date??material.expectedDate) as string|null}));
  if(source?.workbench_generated_number||source?.workbench_number_root_id){
   const fabric=bounds.filter(row=>row.material.category!=='辅料'&&!isDevelopmentMaterialPlaceholder(row.material));
   const accessories=bounds.filter(row=>row.material.category==='辅料'&&!isDevelopmentMaterialPlaceholder(row.material));
   for(const row of fabric)if(!row.date)unconfirmedFabric.push(row.name);
   for(const row of accessories)if(!row.date&&row.material.designerHasMaterial===false){
    value.route.complete=false;
    value.route.missing.push(`${row.name}选择了没有实物，请填写预计日期`);
   }
   const setBound=(parameterKey:string,rows:typeof bounds,label:string)=>{
    const work=value.work.find(item=>item.parameterKey===parameterKey);
    const latest=rows.flatMap(row=>row.date?[row.date]:[]).sort().at(-1);
    if(work&&latest)notBefore[work.id]={precision:'date',value:latest,source:label};
   };
   setBound('development_materials',fabric,'本单已登记的最晚面料预计');
   setBound('development_sewing',accessories,'本单已登记的最晚辅料预计，实际车板仍以文员补核为准');
  }else{
   const dates=bounds.flatMap(row=>row.date?[row.date]:[]).sort();
   for(const row of bounds.filter(row=>!row.date)){value.route.complete=false;value.route.missing.push(`${row.name}尚未到位，请在原单填写预计到位日`);}
   if(dates.length){const first=value.work.find(work=>work.parameterKey==='development_materials');if(first)notBefore[first.id]={precision:'date',value:dates.at(-1)!,source:'本单已登记的最晚物料到位日'};}
  }
  sourceVersion.materialSupply={readiness:native?.materials??null,expected,...(unconfirmedFabric.length?{unconfirmedFabric}:{})};
 }
 if(washing)sourceVersion.washing=[...washing];
 if(rewashing)sourceVersion.rewashing=rewashing.sourceVersion;
 sourceVersion.customerDates=dates;sourceVersion.workFacts=[...progress];sourceVersion.materialBounds=notBefore;
 const datedScopes=value.scopes.filter(scope=>scope.customerGoal.precision==='date');
 let formalEnds:Record<string,SlaTime[]>|undefined;
 // Publication also reloads an adopted route using an arrangement-shaped
 // read. Only an actual arrangement command approves a new remaining plan.
 if(purpose==='command'&&operation.kind==='arrangement'&&saved&&!(plan.company.framework&&frameworkRoute&&datedScopes.length)){
  const pending=[...pendingWork].sort();
  sourceVersion.formalPendingWork=pending;
  value.formalInputs={version:'approved-remaining-v1',progress:Object.fromEntries(progress),notBefore,pendingWork:pending};
  formalEnds=formalRemainingSchedule(value,value.formalInputs,saved,time,'本次拟采用安排').terminalEnds;
 }
 const check=orderTimeCheck({value,time,progress,sourceVersion,resource:resource??{kind:'proposal',id:null},styleNo,customerDates:dates,canRequest:Boolean(designer),canApply:Boolean(manager),notBefore,extraSettings,optionalDevelopmentGoal,...(formalEnds?{formalEnds}:{})});
 if(plan.company.framework&&frameworkRoute&&datedScopes.length){
  const unresolvedNativeRemainder=check.forecastQuality==='lower_bound'&&check.feasibility==='unknown';
  const prospective=operation.kind==='confirm_order'&&Boolean(lifecycle?.first_event_id||preorderPublication)||operation.kind==='development_publish'&&lifecycle?.is_draft;
  const created=resource&&!prospective?await orderTimeCreated(db,resource):null;
  const acceptedAt:SlaAnchor=created?{precision:'instant',value:created.at,source:created.evidence}:resource&&!prospective
   ?{precision:'unknown',reason:'本单接单发生时间缺少原始记录'}:{precision:'instant',value:time.now,source:'本次新单拟生效接单时刻'};
  if(created)for(const work of value.work.filter(row=>row.parameterKey==='order_creation'))progress.set(work.canonicalWorkRef??work.id,{completed:true,actualAt:created.at,readyAt:null,deadline:null});
  if(order){
   const commercial=(await db.query(`SELECT q.quote_id,q.confirmed_version,v.confirmation->>'confirmedAt' AS confirmed_at
    FROM digital_quotation_documents q JOIN digital_quotation_versions v ON v.quote_id=q.quote_id AND v.version=q.confirmed_version
    WHERE q.production_order_id=$1`,[order.production_order_id])).rows[0];
   const commercialAt=commercial?.confirmed_at&&Number.isFinite(Date.parse(commercial.confirmed_at))&&Date.parse(commercial.confirmed_at)<=Date.parse(time.now)?new Date(commercial.confirmed_at).toISOString():null;
   sourceVersion.commercialConfirmation=commercial?{id:commercial.quote_id,version:commercial.confirmed_version,at:commercialAt}:null;
   for(const work of value.work.filter(row=>row.parameterKey==='customer_confirmation'))progress.set(work.canonicalWorkRef??work.id,{completed:Boolean(commercial),actualAt:commercialAt,readyAt:null,deadline:null});
   const native=await (await import('./series-plan-facts.js')).readSeriesPlanFacts(db,order.production_order_id,sourceId,order.customer_code,round);
   const aliases:Record<string,string>={fabric_receipt_a:'fabric_receipt',fabric_receipt_b:'fabric_receipt',warehouse_accessories:'accessories_ready',warehouse_dispatch:'processing_dispatch'};
   for(const scope of value.scopes)for(const work of value.work){
    const key=aliases[work.parameterKey]??work.parameterKey;
    const ref=work.canonicalWorkRef??work.id,scoped=scope.scopeRef+'|'+ref;
    const previous=progress.get(scoped)??progress.get(ref);
    if(key==='style_label_ready'){
     const fact=styleLabelObservedFact(native.facts,scope.lineId);
     progress.set(scoped,{...previous,completed:fact.completed,actualAt:fact.occurredAt,actualDate:null,readyAt:previous?.readyAt??null,deadline:previous?.deadline??null});
     continue;
    }
    const rows=native.facts.filter(fact=>fact.key===key&&(fact.scopeRef===scope.scopeRef||fact.scopeRef==='whole'));
    const exact=rows.filter(fact=>fact.scopeRef===scope.scopeRef),selected=exact.length?exact:rows.filter(fact=>fact.scopeRef==='whole');
    if(selected.length!==1)continue;const fact=selected[0]!;
    progress.set(scoped,overlayFrameworkCompletion(previous,fact));
   }
   sourceVersion.frameworkFactRevisions=native.revisions;
  }
  value.frameworkContext={route:frameworkRoute,acceptedAt,notBefore,progress:Object.fromEntries(progress),
   ...(materialInvestmentResolutionRef?{materialInvestmentResolutionRef}:{})};
  const result=evaluateFrameworkSubmission({scopes:frameworkScopeInputs({...value,scopes:datedScopes},frameworkRoute,acceptedAt,notBefore).map(input=>{
   const prior=saved?.input.frameworkPlans?.[input.scopeRef];
   const sameBasis=prior&&prior.input.route===input.route&&prior.input.customerDelivery.date===input.customerDelivery.date;
   return {input,retained:retainedWashingReworkTargets(input,progress,prior,time.now,Boolean(rewashing?.added),value.rewashing),
    ...(sameBasis?{adoptedMilestones:prior.milestones,...(materialInvestmentResolutionRef?{materialInvestmentResolutionRef}:{})}:{})};
  }),observedAt:time.now,mode:'automatic',acceptLate:false});
  check.fingerprint=fixedTimelineIdentity({prior:check.fingerprint,sourceVersion,frameworkProgress:[...progress]});
  // The caller already authorized this exact order. Reuse the native scoped
  // receipt ledger and the same transaction; no first receipt is manufactured
  // from a planned return or a different factory's batch.
  const deliveries=order&&factoryCommitments.length?(await new (await import('./order-closure-service.js')).OrderClosureService(database).readFactsWithClient(order.production_order_id,reuseJourneySnapshotReads(db))).factoryDeliveries??[]:[];
  check.fingerprint=fixedTimelineIdentity({prior:check.fingerprint,factoryDeliveries:deliveries});
  check.factoryCommitments=orderTimeFactoryCommitments(outstandingFactoryCommitments(factoryCommitments,deliveries),result.candidates);
  check.framework={milestones:result.candidates.flatMap(candidate=>candidate.milestones.map(row=>({...row,scopeRef:candidate.input.scopeRef}))),riskAccepted:false};
  check.coverage=[...new Set([...check.coverage,...result.missing.flatMap(row=>row.reasons)])];
  check.feasibility=unresolvedNativeRemainder||!value.route.complete||result.action==='complete_inputs'?'unknown':result.gaps.length||check.factoryCommitments.some(row=>row.status==='insufficient')?'insufficient':'sufficient';
  check.lateMinutes=result.delivery.every(row=>row.lateMinutes!==null)?Math.max(...result.delivery.map(row=>row.lateMinutes!)):null;
  const ends=result.candidates.map(candidate=>candidate.milestones.find(row=>row.key==='planned_shipment')!.planned.at);
  check.expectedEnd=ends.length&&ends.every((at):at is string=>Boolean(at))?new Date(Math.max(...ends.map(at=>Date.parse(at!)))).toISOString():null;
  check.requiredMinutes=check.expectedEnd?Math.max(0,(Date.parse(check.expectedEnd)-Date.parse(time.now))/60000):null;
  check.forecastQuality=unresolvedNativeRemainder?'lower_bound':check.expectedEnd?'conditional':'unknown';
 }
 if(unconfirmedFabric.length){
  check.coverage.push(`${unconfirmedFabric.join('、')}的实际到料待跟单核实，板房核配仍以原文员确认实物为准`);
  if(check.expectedEnd)check.forecastQuality='lower_bound';
  if(check.feasibility==='sufficient'||check.feasibility==='not_applicable'){
   if(operation.kind==='development_publish')check.publicationMayProceedWithUnconfirmedFabric=true;
   check.feasibility='unknown';
   check.lateMinutes=null;
  }
 }
 if(washing)check.washing=[...washing].map(([lineId,row])=>({lineId,label:row.label,version:row.version,document:row.document}));
 if(rewashing)check.rewashing=rewashing.candidates.flatMap(row=>row.plan.document.arrangement.mode==='none'?[]:[{lineId:row.lineId,scopeId:row.scopeId,quantityVersion:row.quantityVersion,inspectionId:row.inspectionId,label:row.label,round:row.round,availableQuantity:row.availableQuantity,inspectionAt:row.inspectionAt,washingMinutes:row.plan.document.arrangement.washing.minutes,inspectionMinutes:row.plan.document.arrangement.inspection.minutes,calendar:row.plan.document.arrangement.washing.calendar,inspectionCalendar:row.plan.document.arrangement.inspection.calendar}]);
 void database;
 const linkedApplicability={complete:Boolean(!sourceId||development)&&(!includesProduction||Boolean(production&&production.craftSteps!==null&&production.preshrink!==null)),parameterKeys:[...new Set([...value.work.map(work=>work.parameterKey),...extraSettings.keys()])]};
 return {operation,value,check,designerId,sourceId,orderId:order?.production_order_id??null,preorderPublication,progress,time,main,designer:Boolean(designer),manager:Boolean(manager),production,linkedApplicability};
}
