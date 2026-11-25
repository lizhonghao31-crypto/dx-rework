import {orderDocumentHistory} from './order-document-history.js';
import type {RootAuthority} from '../access/root-authority.js';
import {BulkPreshrinkCorrectionService} from './bulk-preshrink-correction-service.js';
import {resolveBulkPreshrinkRequirement,readBulkPreshrinkRequirement} from './bulk-preshrink-requirement.js';
import {bridgePreparationMaterials} from './preparation-series-bridge.js';
import {ProductionReadinessService} from './production-readiness-service.js';
import {publishedProductionBasis} from './production-document-basis.js';
import {preparationAdoption,preparationContext,preparationResponsibility,currentPreparationMaterial,appendPreparationMaterial} from './preparation-material-repository.js';
import {refreshPreparationWindows,instructionTechnicalCurrent,styleLabelCuttingReason,productionReadiness,preparationTestReasons} from './production-readiness-repository.js';
import {technicalEnrollment,effectiveTechnicalEvidence} from './development-technical-repository.js';
import {businessNow,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {captureOrderTimeline} from './fixed-order-adoption.js';
import {BulkMaterialsDispatchSchema,type BulkMaterialsDispatch} from '@dx-rework/contracts/bulk-preparation';
import {bulkFabricFacts} from "./bulk-fabric-facts.js";
import {BulkFabricReportSchema,BulkFabricDecisionSchema,type BulkFabricReport,type BulkFabricDecision} from "@dx-rework/contracts/bulk-preparation";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BulkPatternCardPage, BulkPatternCardSummary, BulkPatternCardTask, BulkDispatch, BulkCompletion, BulkPreparationSheet, BulkWorkroomFilter, BulkWorkroomResult } from "@dx-rework/contracts/bulk-preparation";
import {readDevelopmentOrderRush} from './development-order-rush.js';
import type { InstructionDocument } from "@dx-rework/contracts/production-instruction";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalManagementReader, isDigitalTechnicalManager } from "./access-policy.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { developmentDocumentRow } from "./development-round-repository.js";
import { resolveDigitalChild } from "./child-link-repository.js";
import { isRootActor } from "../access/business-authority.js";
import {journeyTaskSummaries} from './journey-task-summary.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';
import {readJourneyCandidateCohort} from './journey-snapshot-reads.js';
import {readWarehouseInstructionDemands} from './warehouse-instruction-demand.js';
import {materialIssueOptions,freezeMaterialIssueBasis,originalMaterialIssueHistory,readMaterialIssueDestination} from './warehouse-material-issue.js';
import {warehouseIssueFits} from './warehouse-issue-allocation.js';
import {warehouseFabricReportLots} from './warehouse-fabric-report-lots.js';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
type DB=Pick<Pool|PoolClient,"query">;
const fail=(message:string):never=>{throw new ApplicationError("BULK_PREPARATION_CONFLICT",message,409);};
const lock=(db:DB)=>db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
export class BulkPreparationService {
 constructor(private readonly database:Pool){}
 scopedPreshrinkCorrection(root:RootAuthority){return new BulkPreshrinkCorrectionService(this.database,root);}
 private tasks(){return new DigitalProductionTaskService(this.database);}
 async gates(db:DB,id:string){
  const order=(await db.query("SELECT * FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0]??digitalNotFound();
  const source=order.source_id?await developmentDocumentRow(db,order.source_id):null;
  const instruction=(await db.query(`SELECT v.* FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[id])).rows[0];
  const technical=source&&await technicalEnrollment(db,order.source_id)?await effectiveTechnicalEvidence(db,order.source_id,source.round_number,'整款',order.customer_code):null;
  const customerSampleFact=!technical&&source?.status==='published'?(await db.query("SELECT fact_id,payload,actor_id FROM digital_development_route_facts WHERE source_id=$1 AND route_version=$2 AND kind='客户样板确认'",[order.source_id,source.round_number])).rows[0]??null:null;
  const customerConfirmed=technical?technical.state==='effective':Boolean(customerSampleFact);
  const sourcing=(await db.query("SELECT s.* FROM digital_production_child_links l JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id WHERE l.module='sourcing' AND l.production_order_id=$1",[id])).rows[0];
  let approval;
  if(sourcing){
   await resolveDigitalChild(db,'sourcing',sourcing.sourcing_case_id,sourcing.workflow_generation);
   approval=(await db.query(`SELECT a.*,decision.cutting_process FROM sourcing_approval_snapshots a JOIN sourcing_decisions decision ON decision.sourcing_decision_id=a.sourcing_decision_id WHERE a.sourcing_case_id=$1 AND a.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_decisions WHERE sourcing_case_id=$1 ORDER BY decision_version DESC LIMIT 1)
    AND (EXISTS(SELECT 1 FROM sourcing_owner_decisions d WHERE d.sourcing_case_id=$1 AND d.sourcing_decision_id=a.sourcing_decision_id AND d.decision='approved') OR EXISTS(SELECT 1 FROM sourcing_decisions effective WHERE effective.sourcing_decision_id=a.sourcing_decision_id AND effective.source_type='factory_change' AND effective.source_change_request_id IS NOT NULL)
      OR (decision.source_type='price_reapplication' AND EXISTS(
        SELECT 1 FROM sourcing_price_reapplications request JOIN sourcing_price_reviews review USING(price_request_id)
        WHERE request.price_request_id=decision.source_price_request_id AND request.sourcing_case_id=a.sourcing_case_id
          AND request.base_decision_id=decision.supersedes_decision_id AND review.decision='approved'
          AND review.operation_event_id=decision.operation_event_id AND review.operation_event_id=a.operation_event_id)))
    ORDER BY a.approved_at DESC LIMIT 1`,[sourcing.sourcing_case_id])).rows[0];
  }
  const instructionValid=Boolean(instruction&&source&&await instructionTechnicalCurrent(db,id,instruction.version,technical?.revision??null)&&instruction.source_round===source.round_number&&['需要预缩','无需预缩'].includes(instruction.document.preshrink));
  const ownerApproved=Boolean(approval&&!sourcing?.deleted_at);
  const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2)",[id,order.source_id])).rows;
  const existing=instruction&&source?(await db.query('SELECT workflow_version FROM digital_bulk_preparations WHERE production_order_id=$1 AND instruction_version=$2 AND source_round=$3',[id,instruction.version,source.round_number])).rows[0]:null;
  const snapshot=(await db.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation?(await db.query('SELECT snapshot_id FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0]:null;
  const enrolled=Boolean(snapshot);
  const parallel=existing?existing.workflow_version===2:enrolled;
  const fabric=parallel?await bulkFabricFacts(db,id):null;
  const reasons:string[]=[],commercialReasons:string[]=[];
  const closed=Boolean((await db.query("SELECT to_regclass('digital_order_closures') AS relation")).rows[0]?.relation&&(await db.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[id])).rowCount);
  if(closed)reasons.push('母单已特殊结案，原实绩及历史继续保留');
  if(!customerConfirmed)reasons.push(technical?'当前走货技术依据尚未有效：请设计登记最终批复，并由技术完成本次尺寸复核；资料变版须重新核对':'当前开发轮次尚未确认客户样板：请设计师取得客户确认后，在本单开发办理页登记客户样板确认');
  if(ownerApproved&&!['in_house','outsourced'].includes(approval.cutting_process))commercialReasons.push('当前选厂方案缺裁剪方式：请主跟单在本单原外发选厂方案明确本厂裁或外厂裁，再按原审批流程办理');
  if(!ownerApproved)commercialReasons.push('当前选厂方案尚无有效老板批准：请主跟单在本单原外发选厂页核对当前方案，由老板按原审批流程办理');
  if(!instructionValid)reasons.push('当前大货制单未发布、与开发轮次不符或缺预缩选择：请主跟单在本单大货制单核对当前资料及预缩要求后发布');
  if(lifecycle.some(r=>r.state!=='active'))reasons.push('母单或开发来源已暂停/取消');
  return {order,source,instruction,approval,customerConfirmed,customerSampleFact,technical,ownerApproved,instructionValid,parallel,snapshotId:snapshot?.snapshot_id??null,technicalReasons:[...reasons,...(parallel?[]:commercialReasons)],reasons:[...reasons,...commercialReasons,...(parallel&&!fabric?.usable?['验布尚未合格或获准使用，请在原产前准备办理验布及质量决定']:[])],fabric,terminal:closed||lifecycle.some(r=>r.state!=='active')};
 }
 private async current(db:DB,id:string,g:Awaited<ReturnType<BulkPreparationService['gates']>>){
  if(g.technicalReasons.length)return null;
  return (await db.query("SELECT * FROM digital_bulk_preparations WHERE production_order_id=$1 AND instruction_version=$2 AND source_round=$3",[id,g.instruction.version,g.source!.round_number])).rows[0]??null;
 }
 private async routeTasks(db:DB,preparationId:string){return (await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 AND a.task_kind IN ('bulk_pattern','warehouse_preshrink','bulk_cutting','bulk_cutting_external') ORDER BY t.created_at,t.task_id",[preparationId])).rows;}
 private async fact(db:PoolClient,actor:TrustedActorContext,preparationId:string,kind:string,taskId:string|null){await db.query("INSERT INTO digital_bulk_preparation_facts(fact_id,preparation_id,kind,task_id,actor_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(preparation_id,kind) DO NOTHING",[randomUUID(),preparationId,kind,taskId,actor.actorId,businessNow().toISOString()]);}
 private async validAssignee(db:DB,id:string|null|undefined,role:string){return id&&await new DigitalProductionAccessPolicy(db).activeRole(id,role)?id:null;}
 private async nextOccurrence(db:DB,id:string,kind:string){return Number((await db.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind=$2",[id,kind])).rows[0].n);}
 async sync(db:PoolClient,actor:TrustedActorContext,id:string){
  if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return;
  await lock(db);await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[id]);
  await refreshPreparationWindows(db,id);
  const g=await this.gates(db,id);
  // Never rewrite or supersede a route once a real cutting fact exists.
  if((await db.query("SELECT 1 FROM digital_production_child_links l JOIN cutting_orders c ON c.sourcing_case_id=l.child_id JOIN cutting_records r ON r.cutting_order_id=c.cutting_order_id WHERE l.module='sourcing' AND l.production_order_id=$1 LIMIT 1",[id])).rowCount){if(g.instruction&&g.source&&g.instruction.source_round!==g.source.round_number)fail('已开始实裁，不能发布影响本单大货的开发修改');await this.refreshCuttingReadiness(db,actor,id);return;}
  if(g.technicalReasons.length){if(!g.instructionValid||!g.customerConfirmed)await this.tasks().supersedeBulkTasksWithClient(db,actor,id);return;}
  let prep=await this.current(db,id,g);
  if(!prep){
   await this.tasks().supersedeBulkTasksWithClient(db,actor,id);
   const priorUnfinished=(await db.query(`SELECT p.* FROM digital_bulk_preparations p WHERE p.production_order_id=$1 AND p.source_round=$2 AND p.preparation_id=(SELECT latest.preparation_id FROM digital_bulk_preparations latest WHERE latest.production_order_id=$1 ORDER BY latest.created_at DESC,latest.preparation_id DESC LIMIT 1) AND NOT EXISTS(SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=p.preparation_id AND a.task_kind='bulk_pattern' AND t.state='completed') ORDER BY p.created_at DESC,p.preparation_id LIMIT 1`,[id,g.source!.round_number])).rows[0];
   const priorCompleted=(await db.query(`SELECT p.preparation_id FROM digital_bulk_preparations p JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id JOIN digital_production_task_access a USING(task_id)
    WHERE p.production_order_id=$1 AND a.task_kind='bulk_pattern' AND t.state='completed' ORDER BY p.created_at DESC LIMIT 1`,[id])).rows[0];
   const adopted=await preparationAdoption(db,{kind:'order',id});
   // A replacement of an unfinished supplemental scope retains that scope's original clock.
   const continuing=adopted&&priorUnfinished;
   const supplement=adopted?(continuing?priorUnfinished.supplement_of_preparation_id:priorCompleted?.preparation_id??null):null;
   const origin=continuing?(priorUnfinished.clock_origin_preparation_id??priorUnfinished.preparation_id):null;
   const pid=randomUUID(),document=g.instruction.document as InstructionDocument;
   await db.query("INSERT INTO digital_bulk_preparations(preparation_id,production_order_id,instruction_version,approval_snapshot_id,source_id,source_round,preshrink,created_by,workflow_version,sla_snapshot_id,supplement_of_preparation_id,clock_origin_preparation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[pid,id,g.instruction.version,g.approval?.sourcing_approval_snapshot_id??null,g.order.source_id,g.source!.round_number,resolveBulkPreshrinkRequirement(null,document),actor.actorId,g.parallel?2:1,g.parallel?g.snapshotId:null,supplement,origin]);
   prep=(await db.query("SELECT * FROM digital_bulk_preparations WHERE preparation_id=$1",[pid])).rows[0];
   await captureOrderTimeline(db,actor.actorId,id,pid,g.instruction.version,document,g.order.source_id,g.source!.round_number,g.source!.document,
    `digital_bulk_preparations:${pid}`,await new ContextBusinessClock(this.database,db).read({kind:'order',id}));
   const dispatch=(await db.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows[0];
   for(const kind of ['bulk_pattern',...(resolveBulkPreshrinkRequirement(prep)==='需要预缩'?['warehouse_preshrink']:[])] as Array<'bulk_pattern'|'warehouse_preshrink'>){
    const assignee=await this.validAssignee(db,kind==='bulk_pattern'?dispatch?.pattern_worker_id:dispatch?.warehouse_worker_id,kind==='bulk_pattern'?'pattern_room_worker':'warehouse_receiver');
    const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind,routeId:pid,routeVersion:g.instruction.version,occurrence:await this.nextOccurrence(db,id,kind),assigneeId:assignee,conditions:['handover_received']});
    if(!g.parallel)await this.tasks().setConditionWithClient(db,actor,task.taskId,'owner_approved',true,undefined,'客户样板、原批准与制单已齐');
    else if(kind==='bulk_pattern')await this.tasks().setConditionWithClient(db,actor,task.taskId,'customer_confirmed',true,undefined,'客户确认及有效制单已齐，纸样不等批价');
    // Version 2 preshrink remains blocked until the original quality facts explicitly release fabric.

    if(kind==='warehouse_preshrink'&&assignee)await this.tasks().setConditionWithClient(db,actor,task.taskId,'handover_received',true,undefined,'整批预缩已可办理');
   }
   if(resolveBulkPreshrinkRequirement(prep)==='无需预缩')await this.fact(db,actor,pid,'无需预缩',null);
  }
  await this.syncPreparationTasks(db,actor,id,g,prep);
  await this.refreshCuttingReadiness(db,actor,id);
 }
 async syncCorrectedPreparation(db:PoolClient,actor:TrustedActorContext,id:string,preparationId:string,correctionId:string){
  // A correction may converge the existing route only. It must never initialize
  // preparation windows, create another prep or supersede unrelated tasks.
  await lock(db);await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
  const g=await this.gates(db,id),prep=await this.current(db,id,g);
  if(!prep||prep.preparation_id!==preparationId||!(await db.query('SELECT 1 FROM digital_bulk_preshrink_corrections WHERE correction_id=$1 AND production_order_id=$2 AND preparation_id=$3',[correctionId,id,preparationId])).rowCount)fail('纠正依据已变化，不能同步其它准备');
  await this.syncPreparationTasks(db,actor,id,g,prep);
 }
 private async refreshCuttingReadiness(db:PoolClient,actor:TrustedActorContext,id:string){
  const tasks=(await db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN ('bulk_cutting','bulk_cutting_external') AND t.state IN ('pending','ready','blocked') ORDER BY t.task_id",[id])).rows;
  for(const task of tasks)await this.tasks().refreshNativeReadinessWithClient(db,actor,task.task_id);
 }
 /** A technical fact update does not authorize creating/replacing bulk work. */
 async refreshSourceCuttingReadiness(db:PoolClient,actor:TrustedActorContext,sourceId:string){
  for(const row of (await db.query('SELECT production_order_id FROM digital_production_orders WHERE source_id=$1 ORDER BY production_order_id',[sourceId])).rows)
   await this.refreshCuttingReadiness(db,actor,row.production_order_id);
 }
 private async syncPreparationTasks(db:PoolClient,actor:TrustedActorContext,id:string,g:Awaited<ReturnType<BulkPreparationService['gates']>>,prep:{preparation_id:string;instruction_version:number;preshrink:string}){
  const effectivePreshrink=await readBulkPreshrinkRequirement(db,prep);
  const tasks=await this.routeTasks(db,prep.preparation_id);
  const pattern=tasks.find(t=>t.task_kind==='bulk_pattern'),preshrink=tasks.find(t=>t.task_kind==='warehouse_preshrink');
  if(g.parallel&&effectivePreshrink.requirement==='需要预缩'&&preshrink&&!['completed','cancelled'].includes(preshrink.state)){
   const condition=(await db.query("SELECT satisfied FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='materials_ready'",[preshrink.task_id])).rows[0];
   if(condition&&condition.satisfied!==Boolean(g.fabric?.usable))await this.tasks().setConditionWithClient(db,actor,preshrink.task_id,'materials_ready',Boolean(g.fabric?.usable),g.fabric?.usableAt??null,'验布合格或授权继续使用；先处理未放行仍等待');
  }
  if(!g.reasons.length&&pattern?.state==='completed'&&(effectivePreshrink.requirement==='无需预缩'||preshrink?.state==='completed')&&!tasks.some(t=>['bulk_cutting','bulk_cutting_external'].includes(t.task_kind))){
   const dispatch=(await db.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows[0];
   const external=g.approval.cutting_process==='outsourced',kind=external?'bulk_cutting_external':'bulk_cutting';
   const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind,routeId:prep.preparation_id,routeVersion:prep.instruction_version,occurrence:await this.nextOccurrence(db,id,kind),assigneeId:await this.validAssignee(db,external?g.order.primary_merchandiser_id:dispatch?.cutting_worker_id,external?'order_merchandiser':'cutting_worker')});
   for(const condition of ['owner_approved','pattern_ready','preshrink_ready'] as const)await this.tasks().setConditionWithClient(db,actor,task.taskId,condition,true,g.parallel?null:undefined,'全部PO前置汇合；不能据此推定裁床实际收布时间');
  }
 }
 async syncSource(db:PoolClient,actor:TrustedActorContext,sourceId:string){
  if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return;
  for(const row of (await db.query("SELECT production_order_id FROM digital_production_orders WHERE source_id=$1 ORDER BY production_order_id",[sourceId])).rows)await this.sync(db,actor,row.production_order_id);
 }
 /** Internal facts for one mother only. No task DTO/action permission is persisted. */
 async readJourneyFactsWithClient(id:string,db:PoolClient,time:BusinessTime,actor?:TrustedActorContext|null){
  if(actor)await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
  const g=await this.gates(db,id),prep=await this.current(db,id,g);
  const rows=(await db.query(`SELECT po.line_id AS "lineId",l.child_id AS "cuttingOrderId",r.actual_cut_count AS "actualCutCount"
   FROM digital_production_po_lines po LEFT JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id
   LEFT JOIN current_cutting_records r ON r.cutting_order_id=l.child_id WHERE po.production_order_id=$1 ORDER BY po.position`,[id])).rows;
  const taskIds=prep?(await this.routeTasks(db,prep.preparation_id)).map(task=>task.task_id):[];
  const tasks=taskIds.length
   ?actor?await this.tasks().readAuthorized(actor,taskIds,db):[...(await journeyTaskSummaries(db,taskIds,time)).values()]
   :[];
  const resource={kind:'order' as const,id};
  const responsibility=actor
   ?await preparationAdoption(db,resource)?await new ProductionReadinessService(this.database).readResponsibility(actor,resource,db):null
   :await preparationResponsibility(db,await preparationContext(db,resource));
  return {gates:g,sheet:{instructionVersion:g.instruction?.version??null,sourceRound:g.source?.round_number??null,
   customerConfirmed:g.customerConfirmed,ownerApproved:g.ownerApproved,instructionValid:g.instructionValid,reasons:g.reasons,tasks,
   preshrink:(await readBulkPreshrinkRequirement(db,prep,g.instruction?.document)).requirement,
   cutting:{completed:rows.length>0&&rows.every(r=>r.actualCutCount!==null),lines:rows.map(r=>({lineId:r.lineId as string,cuttingOrderId:r.cuttingOrderId as string|null}))},readiness:responsibility?{responsibility}:undefined}};
 }
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<BulkPreparationSheet>{
  const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'order',id,'technical');const g=await this.gates(db,id),prep=await this.current(db,id,g);
  const adoption=await preparationAdoption(db,{kind:'order',id});
  const publishedSource=g.instruction?.order_snapshot?.sourceId;
  const sourceReadable=typeof publishedSource==='string'&&await policy.allowed(actor,'source',publishedSource,'technical');
  const publishedBasis=await publishedProductionBasis(db,id,g.instruction,Boolean(adoption),sourceReadable);
  const tasks=prep?await this.tasks().readAuthorized(actor,(await this.routeTasks(db,prep.preparation_id)).map(t=>t.task_id),db):[];
  const terminal=g.terminal,canDispatchPattern=!terminal&&(isDigitalLeader(actor)||isDigitalTechnicalManager(actor)||actor.actorRoles.includes('development_clerk')),canDispatchWarehouse=!terminal&&isDigitalLeader(actor);
  const canReadDispatch=isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor)||actor.actorRoles.includes('development_clerk')||actor.actorRoles.includes('sample_designer')&&g.order.created_by===actor.actorId
   ||actor.actorRoles.includes('order_merchandiser')&&g.order.primary_merchandiser_id===actor.actorId&&await policy.activeRole(actor.actorId,'order_merchandiser');
  const dispatchPerson=(person:string|null|undefined)=>person&&(canReadDispatch||tasks.some(task=>task.assigneeId===person))?person:null;
  const row=(await db.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows[0];
  const cuttingRows=(await db.query(`SELECT po.line_id AS "lineId",po.po_number AS "poNumber",po.formal_style_no AS "formalStyleNo",po.temporary_style_no AS "temporaryStyleNo",po.color,l.child_id AS "cuttingOrderId",(SELECT sum(quantity)::int FROM digital_production_po_sizes WHERE line_id=po.line_id) AS "orderQuantity",r.actual_cut_count AS "actualCutCount",r.piece_count AS "pieceCount",coalesce(r.corrected,false) AS corrected FROM digital_production_po_lines po LEFT JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id LEFT JOIN current_cutting_records r ON r.cutting_order_id=l.child_id WHERE po.production_order_id=$1 ORDER BY po.position`,[id])).rows;
  // The current published instruction already belongs to this authorized order. Do not
  // use source-wide/history access or expose a whole order snapshot for the reference.
  const referenceInstruction=g.instruction&&g.source&&g.instruction.source_round===g.source.round_number?g.instruction:null;
  const styleImage=referenceInstruction?.document.images?.find((image:InstructionDocument['images'][number])=>image.kind==='款图');
  const reference={designStyleNo:referenceInstruction?.order_snapshot?.designStyleNo??g.order.design_style_no,customerCode:referenceInstruction?.order_snapshot?.customerCode??g.order.customer_code??null,
   styleImageUrl:styleImage?`/api/digital-production/orders/${id}/instruction/attachments/${styleImage.attachmentId}`:null,instructionVersion:referenceInstruction?.version??null,sourceRound:referenceInstruction?.source_round??null};
  const canReportFabric=!terminal&&await this.warehouseAllowed(db,actor,id)&&(isRootActor(actor)||await policy.activeRole(actor.actorId,'warehouse_receiver')||await policy.activeRole(actor.actorId,'warehouse_supervisor'));
  const canDecideFabric=!terminal&&(isRootActor(actor)||await policy.activeRole(actor.actorId,'production_management')||await policy.activeRole(actor.actorId,'owner_group'));
  const materialHistory=await originalMaterialIssueHistory(db,id);
  const materialCanDispatch=canReportFabric&&Boolean(g.approval)&&g.instructionValid;
  const readiness=adoption?await new ProductionReadinessService(this.database).read(actor,{kind:'order',id},db):null;
  const currentAccessories=(g.instruction?.document.accessories??[]) as InstructionDocument['accessories'];
  const scopedFabric=g.fabric?.report?.receiptBatches as BulkFabricReport['receiptBatches'];
  const currentFabric=(scopedFabric?g.instruction?.document.fabrics??[]:[]) as InstructionDocument['fabrics'];
  const availableFabric=g.fabric?.usable&&'warehouseCoverageCurrent' in g.fabric&&g.fabric.warehouseCoverageCurrent?scopedFabric:undefined;
  const active=readiness&&materialCanDispatch&&(currentAccessories.length||currentFabric.length)?(await readWarehouseInstructionDemands(db,[id])).get(id):undefined;
  const options=active&&readiness&&g.ownerApproved?materialIssueOptions(readiness,active,materialHistory,businessNow().toISOString(),
   await readMaterialIssueDestination(db,id,g.approval,readiness.lines.map(line=>line.lineId)),
   new Map(cuttingRows.map(row=>[row.lineId,row.poNumber??row.formalStyleNo??row.color])),availableFabric):undefined;
  const fabricItems=currentFabric.filter(row=>active?.demand.rows.some(binding=>binding.instructionMaterialId===row.id&&scopedFabric?.some(lot=>lot.materialId===binding.sourceMaterialId)))
   .map(row=>({id:row.id,name:row.name,specification:row.remarks,materialColor:[...new Set(Object.values(row.colors))].join('、'),group:row.part,kind:'fabric' as const,
    issueOptions:options?.get(row.id)?.map(value=>value.option)??[]}));
  const materials={canDispatch:materialCanDispatch,supplierId:g.approval?.supplier_id??null,supplierName:g.approval?.supplier_name_snapshot??null,instructionVersion:g.instruction?.version??null,items:[...fabricItems,...currentAccessories.map(m=>({id:m.id,name:m.name,specification:m.specification,materialColor:m.materialColor,group:m.group,
   ...(active?.demand.tracked.includes(m.id)?{issueOptions:options?.get(m.id)?.map(value=>value.option)??[]}:{}),
  }))],history:materialHistory.map(e=>({eventId:e.event_id,occurredAt:new Date(e.occurred_at).toISOString(),operatorName:e.display_name,note:e.payload.note,items:e.payload.items.map(({materialId,name,quantity,unit})=>({materialId,name,quantity,unit}))}))};
  const uncutLines=cuttingRows.filter(r=>r.actualCutCount===null).map(r=>r.lineId as string);const physicalCuttingReasons=uncutLines.length?[...(await styleLabelCuttingReason(db,id,uncutLines)?[await styleLabelCuttingReason(db,id,uncutLines) as string]:[]),...await preparationTestReasons(db,id)]:[];
  return {publishedBasis,physicalCuttingReasons,...(readiness?{readiness}:{}),materials,...(g.fabric?{fabric:g.fabric}:{}),canReportFabric,canDecideFabric,reference,cutting:{mode:g.approval?.cutting_process??null,completed:cuttingRows.length>0&&cuttingRows.every(r=>r.actualCutCount!==null),lines:cuttingRows.map(r=>({...r,actualCutCount:r.actualCutCount===null?null:Number(r.actualCutCount),pieceCount:r.pieceCount===null?null:Number(r.pieceCount)})) as BulkPreparationSheet['cutting']['lines']},orderId:id,instructionVersion:g.instruction?.version??null,sourceRound:g.source?.round_number??null,adoptedRound:g.instruction?.source_round??null,customerConfirmed:g.customerConfirmed,ownerApproved:g.ownerApproved,instructionValid:g.instructionValid,reasons:g.reasons,preparationId:prep?.preparation_id??null,preshrink:(await readBulkPreshrinkRequirement(db,prep,g.instruction?.document)).requirement,
   dispatch:{version:row?.version??0,patternWorkerId:dispatchPerson(row?.pattern_worker_id),warehouseWorkerId:dispatchPerson(row?.warehouse_worker_id),cuttingWorkerId:dispatchPerson(row?.cutting_worker_id)},canDispatchPattern,canDispatchWarehouse,
   facts:prep?(await db.query('SELECT kind,recorded_at AS "recordedAt" FROM digital_bulk_preparation_facts WHERE preparation_id=$1 ORDER BY recorded_at',[prep.preparation_id])).rows:[],tasks};
 }
 async documentHistory(actor:TrustedActorContext,id:string,beforeId?:string,eventId?:string){return orderDocumentHistory(this.database,actor,id,'fabric',beforeId,eventId);}
 private async workroomPage(db:DB,actor:TrustedActorContext,filter:BulkWorkroomFilter){
  const policy=new DigitalProductionAccessPolicy(db);
  const root=isRootActor(actor);
  const managementRoles=['owner_group','production_management','pmc','pattern_room_supervisor','development_clerk'];
  let manager=root,worker=false;
  for(const role of managementRoles)if(actor.actorRoles.includes(role)&&await policy.activeRole(actor.actorId,role))manager=true;
  if(actor.actorRoles.includes('pattern_room_worker'))worker=await policy.activeRole(actor.actorId,'pattern_room_worker');
  if(!manager&&!worker||filter.scope==='all'&&!manager)digitalForbidden();
  const where=`o.source_id IS NOT NULL AND (EXISTS(SELECT 1 FROM digital_bulk_preparations recorded WHERE recorded.production_order_id=o.production_order_id) OR EXISTS(SELECT 1 FROM digital_bulk_dispatch arranged WHERE arranged.production_order_id=o.production_order_id)) AND ($2='' OR strpos(lower(s.design_style_no),lower($2))>0 OR strpos(lower(coalesce(o.customer_code,s.customer_code,'')),lower($2))>0 OR EXISTS(SELECT 1 FROM digital_production_po_lines po WHERE po.production_order_id=o.production_order_id AND (strpos(lower(coalesce(po.po_number,'')),lower($2))>0 OR strpos(lower(coalesce(po.formal_style_no,'')),lower($2))>0 OR strpos(lower(coalesce(po.temporary_style_no,'')),lower($2))>0)) OR EXISTS(SELECT 1 FROM digital_bulk_preparations p JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id JOIN digital_production_task_access a USING(task_id) JOIN app_users u ON u.id=a.assignee_id WHERE p.production_order_id=o.production_order_id AND a.task_kind='bulk_pattern' AND t.state<>'cancelled' AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1) AND strpos(lower(u.display_name),lower($2))>0))
   AND ($3::boolean OR EXISTS(SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) JOIN digital_bulk_preparations p ON p.preparation_id=t.route_instance_id JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version WHERE a.production_order_id=o.production_order_id AND a.task_kind='bulk_pattern' AND a.assignee_id=$1 AND t.state<>'cancelled' AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)))`;
  const args=[actor.actorId,filter.search,filter.scope==='all'];
  const from='FROM digital_production_orders o JOIN digital_production_sources s ON s.source_id=o.source_id';
  const total=Number((await db.query(`SELECT count(*) AS total ${from} WHERE ${where}`,args)).rows[0].total);
  const rows=(await db.query(`SELECT o.production_order_id,s.design_style_no,coalesce(o.customer_code,s.customer_code) AS customer_code ${from} WHERE ${where} ORDER BY o.created_at DESC,o.production_order_id LIMIT 15 OFFSET $4`,[...args,(filter.page-1)*15])).rows;
  return {rows,total};
 }
 async workroom(actor:TrustedActorContext,filter:BulkWorkroomFilter):Promise<BulkWorkroomResult>{
  const {rows,total}=await this.workroomPage(this.database,actor,filter);
  const policy=new DigitalProductionAccessPolicy(this.database),items=[];
  for(const row of rows){if(await policy.allowed(actor,'order',row.production_order_id,'technical'))items.push({orderId:row.production_order_id,designStyleNo:row.design_style_no,customer:row.customer_code,sheet:await this.read(actor,row.production_order_id)});}
  return {page:filter.page,pageSize:15,total,items};
 }

 /** Card reads are bounded by the already selected and authorized page. */
 async workroomCards(actor:TrustedActorContext,filter:BulkWorkroomFilter):Promise<BulkPatternCardPage>{
  const db=await this.database.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const {rows,total}=await this.workroomPage(db,actor,filter);
   const scopes=rows.map(row=>({kind:'order' as const,id:row.production_order_id as string}));
   const access=await readJourneySelectionAccess(db,actor,scopes);
   const readable=rows.filter(row=>access.resources.get('order:'+row.production_order_id)?.technical);
   const ids=readable.map(row=>row.production_order_id as string);
   const rush=await readDevelopmentOrderRush(db,ids.map(orderId=>({orderId,sourceId:null})));
   const pageEvidence=await readJourneyCandidateCohort(db,ids,async(client,id)=>{
    const gates=await this.gates(client,id),preparation=await this.current(client,id,gates);
    return {id,preparationId:preparation?.preparation_id as string|undefined,reasons:gates.reasons};
   });
   const preparationIds=new Map(pageEvidence.map(row=>[row.id,row.preparationId]));
   const reasons=new Map(pageEvidence.map(row=>[row.id,row.reasons]));
   const preparations=[...preparationIds.values()].flatMap(id=>id?[id]:[]);
   const lines=new Map<string,BulkPatternCardSummary['lines']>();
   if(ids.length){
    const rows=await db.query(`SELECT production_order_id AS "orderId",line_id AS "lineId",po_number AS "poNumber",
      formal_style_no AS "formalStyleNo",temporary_style_no AS "temporaryStyleNo",color
      FROM digital_production_po_lines WHERE production_order_id=ANY($1::uuid[]) ORDER BY position`,[ids]);
    for(const {orderId,...line} of rows.rows){
     const entries=lines.get(orderId)??[];entries.push(line as BulkPatternCardSummary['lines'][number]);lines.set(orderId,entries);
    }
   }
   const facts=new Map<string,BulkPatternCardSummary['facts']>(),patternTasks=new Map<string,BulkPatternCardTask>();
   if(preparations.length){
    const evidence=await db.query<{preparation_id:string;kind:string}>(`SELECT preparation_id,kind
      FROM digital_bulk_preparation_facts WHERE preparation_id=ANY($1::uuid[]) AND kind IN ('纸样完成','唛架完成','纸样派交')`,[preparations]);
    for(const {preparation_id,kind} of evidence.rows){
     const entries=facts.get(preparation_id)??[];entries.push({kind});facts.set(preparation_id,entries);
    }
    const taskRows=(await db.query<{route_instance_id:string;task_id:string}>(`SELECT t.route_instance_id,t.task_id
      FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
      WHERE t.route_instance_id=ANY($1::uuid[]) AND a.task_kind='bulk_pattern' ORDER BY t.created_at,t.task_id`,[preparations])).rows;
    const page=await this.tasks().prepareReadPage(actor,taskRows.map(row=>row.task_id),db);
    for(const row of taskRows){
     if(patternTasks.has(row.route_instance_id)||!page.allowed(row.task_id))continue;
     const {taskId,sourceId,orderId,assigneeName,state,blockedReason,slaHours,enteredAt,completedAt,dueAt,warningAt,deadlineExclusive,acceptanceBusinessNow}=await page.read(row.task_id);
     patternTasks.set(row.route_instance_id,{taskId,sourceId,orderId,assigneeName,state,blockedReason,slaHours,enteredAt,completedAt,dueAt,warningAt,
      ...(deadlineExclusive===undefined?{}:{deadlineExclusive}),
      ...(acceptanceBusinessNow===undefined?{}:{acceptanceBusinessNow})});
    }
   }
   const items=readable.map(row=>{
    const orderId=row.production_order_id as string,preparationId=preparationIds.get(orderId)??null;
    return {orderId,designStyleNo:row.design_style_no,customer:row.customer_code,...(rush.has(`order:${orderId}`)?{orderRush:true as const}:{}),card:{preparationId,
     reasons:reasons.get(orderId)??[],facts:preparationId?facts.get(preparationId)??[]:[],
     task:preparationId?patternTasks.get(preparationId)??null:null,lines:lines.get(orderId)??[]}};
   });
   await db.query('COMMIT');return {page:filter.page,pageSize:15,total,items};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async command(actor:TrustedActorContext,id:string,action:string,input:unknown,key:string,work:(db:PoolClient)=>Promise<void>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');const db=await this.database.connect();try{
   await db.query('BEGIN');await lock(db);await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
   await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[id]);
   if(action==='materials-dispatch'&&(!await this.warehouseAllowed(db,actor,id)||!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'warehouse_receiver')))digitalForbidden();
   const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),command=`bulk:${id}:${action}`;
   const prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)fail('操作标识已用于不同内容');
   if(prior){await db.query('COMMIT');return prior.response as BulkPreparationSheet;}
   const state=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1",[id])).rows[0]?.state;if(state&&state!=='active')fail('母单已暂停或取消');
   const sourceId=(await db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[id])).rows[0]?.source_id;
   if(sourceId&&(await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1 AND state<>'active'",[sourceId])).rowCount)fail('开发来源已暂停或取消，不能保存预派或派交');
   if((await db.query("SELECT to_regclass('digital_order_closures') AS relation")).rows[0]?.relation&&(await db.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[id])).rowCount)fail('母单已特殊结案，不能保存预派或派交；原安排与历史保留');
   await work(db);const result=await this.read(actor,id,db);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_bulk_preparation',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,action,id,JSON.stringify(input)]);
   await db.query('COMMIT');return result;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async dispatch(actor:TrustedActorContext,id:string,input:BulkDispatch,key:string){
  if(!isDigitalLeader(actor)&&!isDigitalTechnicalManager(actor)&&!actor.actorRoles.includes('development_clerk'))digitalForbidden();
  return this.command(actor,id,'dispatch',input,key,async db=>{
   const before=(await db.query('SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0];if((before?.version??0)!==input.expectedVersion)fail('派工已更新，请刷新');
   if(!isDigitalLeader(actor)&&(input.warehouseWorkerId!==undefined&&input.warehouseWorkerId!==(before?.warehouse_worker_id??null)||input.cuttingWorkerId!==undefined&&input.cuttingWorkerId!==(before?.cutting_worker_id??null)))digitalForbidden();
   const warehouse=input.warehouseWorkerId===undefined?before?.warehouse_worker_id??null:input.warehouseWorkerId,cutting=input.cuttingWorkerId===undefined?before?.cutting_worker_id??null:input.cuttingWorkerId;
   for(const [person,role] of [[input.patternWorkerId,'pattern_room_worker'],[warehouse,'warehouse_receiver'],[cutting,'cutting_worker']] as const)if(person&&!await new DigitalProductionAccessPolicy(db).activeRole(person,role))fail('主办人必须为在职有效对应岗位');
   await db.query(`INSERT INTO digital_bulk_dispatch(production_order_id,pattern_worker_id,warehouse_worker_id,cutting_worker_id,changed_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(production_order_id) DO UPDATE SET version=digital_bulk_dispatch.version+1,pattern_worker_id=$2,warehouse_worker_id=$3,cutting_worker_id=$4,changed_by=$5,changed_at=CURRENT_TIMESTAMP`,[id,input.patternWorkerId,warehouse,cutting,actor.actorId]);
   await this.sync(db,actor,id);const g=await this.gates(db,id),prep=await this.current(db,id,g);
   if(input.deliverPattern&&(!prep||!input.patternWorkerId))fail([...g.reasons,...(!input.patternWorkerId?['尚未选择大货纸样师：请文员在本页预派与交付选择有效纸样师']:[])].join('；')||'本轮产前准备尚未生成：请刷新本页核对客户样板、当前选厂批准及有效制单；仍未生成时联系本单管理人员');
   if(!prep)return;
   const tasks=await this.routeTasks(db,prep.preparation_id);
   for(const t of tasks){
    if(t.task_kind==='bulk_cutting_external')continue;
    const assignee=t.task_kind==='bulk_pattern'?input.patternWorkerId:t.task_kind==='warehouse_preshrink'?warehouse:cutting;
    if(!assignee&&t.assignee_id&&!['completed','cancelled'].includes(t.state))fail('已生成任务不能清空主办，请直接改派到在职对应岗位');
    if(assignee&&assignee!==t.assignee_id&&!['completed','cancelled'].includes(t.state))await this.tasks().reassignWithClient(db,actor,t.task_id,assignee);
    if(t.task_kind==='warehouse_preshrink'&&warehouse&&t.state==='pending')await this.tasks().setConditionWithClient(db,actor,t.task_id,'handover_received',true,undefined,'预缩主办已到位');
    if(t.task_kind==='bulk_pattern'&&input.deliverPattern&&t.state==='pending'){
     await this.fact(db,actor,prep.preparation_id,'纸样派交',t.task_id);await this.tasks().setConditionWithClient(db,actor,t.task_id,'handover_received',true,undefined,'文员已派交大货纸样唛架');
    }
   }
  });
 }
 private async warehouseAllowed(db:DB,actor:TrustedActorContext,id:string){
  if(isRootActor(actor))return true;
  const policy=new DigitalProductionAccessPolicy(db);
  if(!actor.actorRoles.some(r=>['warehouse_receiver','warehouse_supervisor'].includes(r))||!await policy.activeRole(actor.actorId,'warehouse_receiver'))return false;
  if(!await preparationAdoption(db,{kind:'order',id}))return true;
  return (await preparationResponsibility(db,await preparationContext(db,{kind:'order',id}))).warehouseWorkerId===actor.actorId;
 }
 async dispatchMaterials(actor:TrustedActorContext,id:string,input:BulkMaterialsDispatch,key:string){
  input=BulkMaterialsDispatchSchema.parse(input);
  return this.command(actor,id,'materials-dispatch',input,key,async db=>{
   const g=await this.gates(db,id);
   if(!g.instructionValid||g.instruction?.version!==input.instructionVersion||!g.approval||g.approval.supplier_id!==input.supplierId)fail('制单或批准加工厂已变化，请刷新本单材料信息');
   if(Date.parse(input.occurredAt)>businessNow().getTime()||Date.parse(input.occurredAt)<new Date(g.instruction.published_at).getTime())fail('实际发出时间不能在未来或早于本版制单发布');
   if(new Set(input.items.map(i=>i.materialId)).size!==input.items.length)fail('本次辅料不可重复');
   const active=(await preparationAdoption(db,{kind:'order',id}))?(await readWarehouseInstructionDemands(db,[id])).get(id):undefined;
   const hasScopedItems=input.items.some(item=>active?.demand.tracked.includes(item.materialId));
   if(hasScopedItems&&!g.ownerApproved)fail('当前加工厂审批已失效，请核对');
   const scopedState=hasScopedItems&&active?await new ProductionReadinessService(this.database).read(actor,{kind:'order',id},db):null;
   const availableFabric=g.fabric?.usable&&'warehouseCoverageCurrent' in g.fabric&&g.fabric.warehouseCoverageCurrent?g.fabric.report?.receiptBatches as BulkFabricReport['receiptBatches']:undefined;
   const scoped=active&&scopedState?materialIssueOptions(scopedState,active,await originalMaterialIssueHistory(db,id),businessNow().toISOString(),
    await readMaterialIssueDestination(db,id,g.approval,scopedState.lines.map(line=>line.lineId)),undefined,availableFabric):undefined;
   const items=input.items.map(item=>{
    const accessory=g.instruction.document.accessories.find((m:InstructionDocument['accessories'][number])=>m.id===item.materialId);
    const fabric:InstructionDocument['fabrics'][number]|undefined=item.scope?g.instruction.document.fabrics.find((m:InstructionDocument['fabrics'][number])=>m.id===item.materialId):undefined;
    const material=accessory??fabric;
    if(!material||accessory&&fabric)fail('面辅料必须来自本单当前制单，面料须引用当前已有效验布的实际批次');
    const requiresBasis=active?.demand.tracked.includes(item.materialId);
    if(!requiresBasis){if(item.scope)fail('原授权物料批次和采用依据已变化，请刷新');return {...item,name:material.name};}
    const allocation=item.scope;
    if(!allocation)return fail('请选择本项当前实际收料批次，不能按采购数直接发料');
    const eligible=scoped?.get(item.materialId)?.find(value=>value.option.lineId===allocation.lineId&&value.option.scopeRef===allocation.scopeRef);
    if(!eligible?.item.productionRequired||eligible.item.kind!==(fabric?'fabric_receipt':'accessories_ready')||!warehouseIssueFits(eligible.ledger,eligible.item.productionRequired,
     {unit:item.unit,quantity:String(item.quantity)},{occurredAt:input.occurredAt,allocations:allocation.allocations}))return fail('实际批次、单位、时间或可发数量已变化，请核对原收料和本项余量');
    return {...item,name:material.name,warehouseBasis:freezeMaterialIssueBasis(eligible.item.basis),
     ...(fabric?{warehouseFabricReport:{id:g.fabric?.report?.reportId,decisionId:g.fabric?.decision?.decisionId??null}}:{}),
     warehouseDestination:{sourcingCaseId:g.approval.sourcing_case_id,sourcingDecisionId:g.approval.sourcing_decision_id,
      approvalSnapshotId:g.approval.sourcing_approval_snapshot_id,supplierId:g.approval.supplier_id}};
   });
   await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload) VALUES($1,'order',$2,'bulk_materials_dispatched',$3,$4,'补报未核实',$5)`,[randomUUID(),id,actor.actorId,input.occurredAt,JSON.stringify({...input,items})]);
   // A warehouse issue is not a factory receipt, task completion or extra 24h deadline.
  });
 }
 async reportFabric(actor:TrustedActorContext,id:string,input:BulkFabricReport,key:string){
  input=BulkFabricReportSchema.parse(input);
  return this.command(actor,id,'fabric-report',input,key,async db=>{
   const policy=new DigitalProductionAccessPolicy(db);
   if(!await this.warehouseAllowed(db,actor,id))digitalForbidden();
   if(!isRootActor(actor)&&!await policy.lockActiveRole(actor.actorId,'warehouse_receiver'))digitalForbidden();
   for(const at of [input.arrivedAt,input.inspectedAt])if(at&&Date.parse(at)>businessNow().getTime())fail('实际时间不能在未来');
   if(!(await this.gates(db,id)).parallel)fail('旧路线保留原办理方式，不能自动套用新验布规则');
   let receiptRef:{recordId:string;version:number}|null=null;
   const adopted=await preparationAdoption(db,{kind:'order',id});
   if(input.receiptBatches&&!adopted)fail('本单尚无可核的原验布及收料依据');
   if(adopted){
    const priorReceipt=await currentPreparationMaterial(db,id,'fabric_receipt');
    if((priorReceipt?.version??0)!==(input.expectedReceiptVersion??0))fail('实际到仓记录已变化，请刷新当前物料版本');
    if(input.receiptBatches&&(!priorReceipt||!input.inspectedAt||!await warehouseFabricReportLots(db,id,input.receiptBatches,input.inspectedAt,businessNow().toISOString())))
     fail('验布须对应本单当前有效实收批次及原到仓依据，不得用已订正或其他物料的批次');
    if(priorReceipt){if(priorReceipt.state!=='ready'||!priorReceipt.valid||priorReceipt.occurredAt!==input.arrivedAt)fail('请先在原物料记录订正主料实际到仓依据，再办理本次验布');receiptRef={recordId:priorReceipt.recordId,version:priorReceipt.version};}
    else if(input.arrivedAt){const context=await preparationContext(db,{kind:'order',id});receiptRef=await appendPreparationMaterial(db,context,actor.actorId,{kind:'fabric_receipt',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:input.arrivedAt,note:input.note,quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null});await bridgePreparationMaterials(db,context,actor.actorId);}
   }
   const prior=await bulkFabricFacts(db,id);
   if((prior.report?.reportId??null)!==input.expectedReportId)fail('验布报告已更新，请刷新');
   if(prior.report?.receiptBatches&&!input.receiptBatches)fail('原报告引用了实际收料批次，请重新选择本次验布范围');
   await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,corrects_event_id,payload)
     VALUES($1,'order',$2,'bulk_fabric_report',$3,$4,$5,$6,$7)`,[randomUUID(),id,actor.actorId,input.inspectedAt,input.inspectedAt?'补报未核实':'缺失',input.expectedReportId,JSON.stringify({...input,...(receiptRef?{receiptRef}:{}),snapshotId:prior.report?.snapshotId??(await this.gates(db,id)).snapshotId})]);
   await this.sync(db,actor,id);
  });
 }
 async decideFabric(actor:TrustedActorContext,id:string,input:BulkFabricDecision,key:string){
  input=BulkFabricDecisionSchema.parse(input);
  return this.command(actor,id,'fabric-decision',input,key,async db=>{
   const policy=new DigitalProductionAccessPolicy(db);
   if(!isRootActor(actor)&&!await policy.activeRole(actor.actorId,'production_management')&&!await policy.activeRole(actor.actorId,'owner_group'))digitalForbidden();
   const state=await bulkFabricFacts(db,id);
   if(state.report?.reportId!==input.reportId||state.report.result!=='不合格'||(state.decision?.decisionId??null)!==input.expectedDecisionId)fail('验布报告或质量决定已更新，请刷新');
   if('warehouseCoverageCurrent' in state&&state.warehouseCoverageCurrent===false)fail('本报告所用的原实收批次已变化，请重新验布');
   await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
     VALUES($1,'order',$2,'bulk_fabric_decision',$3,$5,'现场登记',$4)`,[randomUUID(),id,actor.actorId,JSON.stringify(input),businessNow().toISOString()]);
   await this.sync(db,actor,id);
  });
 }
 async complete(actor:TrustedActorContext,id:string,input:BulkCompletion,key:string){return this.command(actor,id,'complete',input,key,async db=>{
  const g=await this.gates(db,id),prep=await this.current(db,id,g);if(!prep||prep.preparation_id!==input.preparationId)fail(g.reasons.join('；')||'技术版本已更新，不能沿用旧版完成');
  const tasks=await this.routeTasks(db,prep.preparation_id),task=tasks.find(t=>t.task_kind===(input.kind==='预缩完成'?'warehouse_preshrink':'bulk_pattern'));
  if(!task)fail('本路线不含此任务');await new DigitalProductionAccessPolicy(db).assert(actor,'task',task.task_id,'execute');
  if(input.kind==='预缩完成'&&(await readBulkPreshrinkRequirement(db,prep)).requirement!=='需要预缩')fail('本制单未要求预缩，不能补造预缩完成事实');
  if((await db.query('SELECT 1 FROM digital_bulk_preparation_facts WHERE preparation_id=$1 AND kind=$2',[prep.preparation_id,input.kind])).rowCount)return;
  const readiness=await productionReadiness(db,id);
  if(readiness.adoption){
   if(input.kind==='预缩完成'){if(!readiness.fabric.usable)fail('当前主料尚未通过有效验布或获准使用，请重新核对到仓及验布依据');const tests=await preparationTestReasons(db,id,true);if(tests.length)fail(tests.join('；'));}
   if(input.expectedReadinessRevision!==readiness.revision)fail('实际物料或技术依据已变化，请刷新当前任务');
   if(input.kind!=='预缩完成'){
    const range=input.range;if(!range)return fail('请明确本次已做范围及仍欠物料，不能把局部准备记为整单完成');
    const prior=(await db.query('SELECT version FROM digital_bulk_work_ranges WHERE preparation_id=$1 AND kind=$2 ORDER BY version DESC LIMIT 1',[prep.preparation_id,input.kind])).rows[0];
    if((prior?.version??0)!==range.expectedVersion)fail('准备范围已更新，请刷新');
    if(new Set(range.lineIds).size!==range.lineIds.length||range.lineIds.some(line=>!readiness.context.lines.some(l=>l.line_id===line)))fail('本次准备范围须为本单款色且不可重复');
    const accessoryIds=(g.instruction.document as InstructionDocument).accessories.map(m=>m.id);
    const sourceMaterialIds=(readiness.document?.document.materials??[]).filter((m:{category:string})=>m.category==='辅料').map((m:{materialId:string})=>m.materialId);
    if(range.pendingMaterialIds.some(id=>!accessoryIds.includes(id)&&!sourceMaterialIds.includes(id)))fail('欠料须来自当前制单或开发资料，不混入其它单');
    if(range.complete&&(range.lineIds.length!==readiness.context.lines.length||range.pendingMaterialIds.length))fail('整单完成须覆盖全部适用款色且没有本项待补做物料');
    if(range.complete&&(accessoryIds.length||sourceMaterialIds.length)&&!readiness.materials.some(m=>m.kind==='accessories_ready'&&m.scopeRef==='whole'&&m.state==='ready'&&m.valid))fail('尚有辅料未备齐；普通单和急单均可先登记不受影响的局部准备');
    if(task.state!=='ready')fail('任务尚不可办理');
    await new ProductionReadinessService(this.database).bindFiles(db,actor,{kind:'order',id},range.evidenceIds);
    await db.query(`INSERT INTO digital_bulk_work_ranges(range_id,preparation_id,task_id,kind,version,line_ids,complete,pending_material_ids,note,evidence_ids,basis_json,actor_id,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[randomUUID(),prep.preparation_id,task.task_id,input.kind,range.expectedVersion+1,range.lineIds,range.complete,range.pendingMaterialIds,range.note,range.evidenceIds,JSON.stringify({readinessRevision:readiness.revision,technicalRevision:readiness.technical?.revision??null}),actor.actorId,businessNow().toISOString()]);
    if(!range.complete)return;
   }
  }

  if(task.state!=='ready')fail('任务尚不可办理');
  await this.fact(db,actor,prep.preparation_id,input.kind,task.task_id);
  const facts=(await db.query('SELECT kind FROM digital_bulk_preparation_facts WHERE preparation_id=$1',[prep.preparation_id])).rows.map(r=>r.kind);
  if(input.kind==='预缩完成'||facts.includes('纸样完成')&&facts.includes('唛架完成')){
   await this.tasks().setConditionWithClient(db,actor,task.task_id,'business_recorded',true,undefined,'产前完成事实已齐');
   await this.tasks().completeWithClient(db,actor,task.task_id,{note:input.kind},`bulk-complete:${prep.preparation_id}:${task.task_kind}`);
  }
  await this.sync(db,actor,id);
 });}
}
export async function syncBulkSourcing(db:PoolClient,pool:Pool,actor:TrustedActorContext,caseId:string){
 if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return;
 const row=(await db.query("SELECT workflow_generation FROM sourcing_cases WHERE sourcing_case_id=$1",[caseId])).rows[0];
 if(!row||row.workflow_generation!=='digital_production_v1')return;
 const id=await resolveDigitalChild(db,'sourcing',caseId,row.workflow_generation);await new BulkPreparationService(pool).sync(db,actor,id!);
}
export async function digitalCuttingGate(db:DB,pool:Pool,cuttingId:string,requiredQuantity?:number){
 const row=(await db.query("SELECT c.sourcing_case_id,to_jsonb(s)->>'workflow_generation' AS generation FROM cutting_orders c JOIN sourcing_cases s USING(sourcing_case_id) WHERE c.cutting_order_id=$1",[cuttingId])).rows[0];
 if(!row)return null;
 if(row.generation!=='digital_production_v1'){if((await db.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation)await resolveDigitalChild(db,'sourcing',row.sourcing_case_id,'legacy');return null;}
 const id=await resolveDigitalChild(db,'sourcing',row.sourcing_case_id,'digital_production_v1');
 const g=await new BulkPreparationService(pool).gates(db,id!);
 const authority={orderId:id!,external:g.approval?.cutting_process==='outsourced',primaryMerchandiserId:g.order.primary_merchandiser_id as string|null};
 const labelLines=(await db.query("SELECT line_id FROM digital_production_child_lines WHERE module='cutting' AND child_id=$1 AND production_order_id=$2",[cuttingId,id])).rows.map(r=>r.line_id as string);
 const alreadyCut=Boolean((await db.query('SELECT 1 FROM cutting_records WHERE cutting_order_id=$1',[cuttingId])).rowCount);
 const testReasons=alreadyCut?[]:await preparationTestReasons(db,id!);if(testReasons.length)return {...authority,ready:false,reason:testReasons.join('；')};
 const labelReason=alreadyCut?null:await styleLabelCuttingReason(db,id!,labelLines,requiredQuantity);if(labelReason)return {...authority,ready:false,reason:labelReason};
 if(g.reasons.length)return {...authority,ready:false,reason:g.reasons.join('；')};
 const task=(await db.query(`SELECT t.state,t.task_id,p.preparation_id FROM digital_bulk_preparations p JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id JOIN digital_production_task_access a USING(task_id)
  WHERE p.production_order_id=$1 AND p.instruction_version=$2 AND p.source_round=$3 AND a.task_kind IN ('bulk_cutting','bulk_cutting_external')`,[id,g.instruction.version,g.source!.round_number])).rows[0];
 return {orderId:id!,external:g.approval.cutting_process==='outsourced',primaryMerchandiserId:g.order.primary_merchandiser_id as string|null,taskId:task?.task_id as string|undefined,preparationId:task?.preparation_id as string|undefined,ready:task?.state==='ready'||task?.state==='completed',reason:task?.state==='ready'||task?.state==='completed'?'':'纸样、唛架及预缩条件未齐'};
}
