import {readTechnicalTaskListPage} from './journey-selection-access.js';
import {developmentRushKey,readDevelopmentOrderRush} from './development-order-rush.js';
import {attachDevelopmentRegistrations,developmentResponsibilityWindow} from './development-responsibility-window.js';
import {readTaskPageFacts,readTaskPageHistory,taskWithParentsSql,effectiveTaskDeadlineSql} from './task-page-read-context.js';
import {taskReadBatches} from './journey-selection-access.js';
import {readTaskCompletionOccurrence,type TaskCompletionReadContext} from './task-completion-occurrence.js';
import {taskCraftDisplay} from './task-craft-display.js';
import {attachFactoryTaskCompletions,factoryCompletionSource} from './factory-task-completion.js';
import {factoryCompletionOccurrence} from './factory-completion-occurrence.js';
import {assembleQuotation} from './quotation-assembly.js';
import {SlaSettingsSetsService} from './sla-settings-sets.js';
import {SpecialCraftLibraryService} from './special-craft-library.js';
import {OrderTimeSettingsService} from './order-time-settings-service.js';
import {ORDER_TIME_MODEL_ENABLED} from './order-time-activation.js';
import type {SlaApplicationCandidatesQuery} from '@dx-rework/contracts/sla-settings-history';
import {SlaSettingsDraftService} from './sla-settings-drafts.js';
import {SlaSettingsHistoryService} from './sla-settings-history.js';
import type {SlaHistoryQuery} from '@dx-rework/contracts/sla-settings-history';
import type {SlaDraftGroup} from '@dx-rework/contracts/sla-settings-drafts';
import {SlaCalculationService} from './sla-calculation-service.js';
import {assertCurrentFactoryTask,isRetiredFactoryTask,FACTORY_RECEIPT_RETIREMENT} from './retired-factory-nodes.js';
import {SlaSettingsService,type StandardDraft} from './sla-settings-service.js';
import {SlaOrderApplicationService} from './sla-order-application.js';
import {businessNow,assertAcceptanceAssignee,acceptanceBusinessContext,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {factoryProductionFacts,factoryProductionScopes} from './factory-production-facts.js';
import {shipSampleTargets} from './ship-sample-timing.js';
import {factoryTaskTiming,factoryBatchTiming} from './factory-batch-timing.js';
import {bulkTaskTiming} from "./bulk-task-timing.js";
import {DEVELOPMENT_ARRANGEABLE_KINDS} from "@dx-rework/contracts/development-arrangement";
import {developmentTaskTiming} from "./development-task-timing.js";
import {nativeTaskReadiness,nativeCuttingReadiness,NATIVE_READINESS_KINDS} from './task-readiness-facts.js';
import {prepareFixedTaskPosition,insertFixedTaskPosition} from './fixed-task-route.js';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {fixedTaskTargets,type FixedTaskWorkBinding} from './fixed-task-targets.js';
import {currentTaskPlanTargets} from './current-task-plan-targets.js';
import {fixedCraftTiming,FIXED_DEVELOPMENT_CRAFT_TASKS} from './fixed-craft-timing.js';
import {developmentSlaPlan,developmentWorkflowVersion} from "./development-sla-enrollment.js";
import {developmentNativeRoute} from './development-native-route.js';
import {isNativeRootSewingRecipient} from './development-native-recipient.js';
import {authorizePatternOrder} from '../pattern-room/order-authority.js';
import {orderTimeNativeTiming} from './order-time-native-timing.js';
import {orderTimeAdmission} from './order-time-admission.js';
import {activateInitialDevelopmentExecution} from "./development-native-activation.js";
import {TodoService} from "../todos/service.js";
import {taskDocuments,resourceDocuments} from "./task-documents.js";
import {developmentTaskBlockers} from "./development-task-blockers.js";
import {materialReadiness} from "./development-material-readiness.js";
import { hasWarehouseReceivingRole } from "@dx-rework/contracts";
import {FactoryFlowService} from "./factory-flow-service.js";
import type { DigitalTaskState, DigitalTimeQuality } from "@dx-rework/contracts/digital-production-tasks";
import {savedDevelopmentRoute} from "./development-sla-enrollment.js";
import { createHash, randomUUID } from "node:crypto";
import {readBulkPreshrinkRequirement,retiredBulkPreshrinkTaskIds} from './bulk-preshrink-requirement.js';
import {isDeepStrictEqual} from "node:util";
import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader,  isDigitalTechnicalManager } from "./access-policy.js";
import { createDigitalTaskAccess, reassignDigitalTask, type DigitalTaskKind } from "./task-access-repository.js";
import { digitalDeadline } from "@dx-rework/domain/digital-task-deadline";
import { ProductionOrderNodeClockRepository } from "./node-clock-repository.js";
import { DIGITAL_SLA_PARAMETERS } from "@dx-rework/contracts/digital-sla";
import { SlaConfigurationRepository, SlaVersionConflict } from "./sla-configuration-repository.js";
import { SlaConfigurationService } from "./sla-configuration-service.js";
import { slaParameterKey } from "./sla-policy-values.js";
import { frozenSlaTaskPolicy } from "./sla-task-policy.js";

type Resource = { kind: "order" | "source"; id: string };
type TimeQuality = "现场登记" | "补报未核实" | "已核实" | "缺失";
const fail = (message: string): never => { throw new ApplicationError("DIGITAL_TASK_CONFLICT", message, 409); };
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const requiresDevelopmentAssignee = async (client:PoolClient,task: { source_id: string | null; task_kind: string }) => Boolean(task.source_id) && (["development_pattern","development_cutting","development_sewing","development_positioning","development_size_review","development_patch","development_patch_tail_check","development_patch_confirmation"].includes(task.task_kind)||(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind)&&Boolean((await client.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation));
export const DIGITAL_CONDITION_KEYS = ["customer_confirmed", "owner_approved", "materials_ready", "handover_received", "pattern_ready", "preshrink_ready", "qc_approved", "all_po_complete", "factory_arrived", "washing_finished", "pattern_assignment_ready", "business_recorded"] as const;
const REQUIRED_ACTIVATION: Partial<Record<DigitalTaskKind, readonly typeof DIGITAL_CONDITION_KEYS[number][]>> = {
  development_pattern: ["materials_ready", "handover_received"], development_cutting: ["handover_received"], development_sewing: ["materials_ready", "handover_received"],
  development_washing: ["handover_received"], development_tail_check: ["washing_finished"], bulk_pattern: ["owner_approved"], warehouse_preshrink: ["owner_approved"],
  bulk_cutting: ["owner_approved", "pattern_ready", "preshrink_ready"], bulk_cutting_external: ["owner_approved", "pattern_ready", "preshrink_ready"], warehouse_dispatch: ["qc_approved", "all_po_complete"], factory_material_count: ["factory_arrived"],
};
export class DigitalProductionTaskService {
  constructor(private readonly database: Pool,private readonly previewSecret?:string,private readonly orderTimeEnabled=ORDER_TIME_MODEL_ENABLED) {}
  async syncSourcingAssignee(client: PoolClient, actor: TrustedActorContext, orderId: string, assigneeId: string) {
    if (!(await client.query("SELECT to_regclass('digital_budget_preparations') AS relation")).rows[0]?.relation) return;
    const tasks = (await client.query(`SELECT a.task_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
      WHERE a.production_order_id=$1 AND a.task_kind IN ('sourcing_preparation','bulk_cutting_external','bulk_ship_sample') AND t.state NOT IN ('completed','cancelled')`, [orderId])).rows;
    for (const task of tasks) {
      await reassignDigitalTask(client, actor, task.task_id, assigneeId);
      await this.event(client, actor, task.task_id, { kind: "order", id: orderId }, "reassigned", businessNow().toISOString(), "现场登记", { assigneeId });
    }
  }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // One short lifecycle lock keeps policy coverage, completion and successor release atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const result = await action(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  private async command<T>(client: PoolClient, actor: TrustedActorContext, command: string, key: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识");
    const target=command.match(/^(?:task-(?:complete|handover|block|reassign|time)|priority):([0-9a-f-]{36})$/i);
    if(target)assertCurrentFactoryTask((await this.task(client,target[1]!)).task_kind);
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const prior = (await client.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key])).rows[0];
    if (prior) { if (prior.payload_hash !== hash) fail("操作标识已用于不同内容"); return prior.response as T; }
    const result = await action();
    await client.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(result)]);
    return result;
  }
  private async task(client: PoolClient | Pick<Pool, "query">, id: string, lock = false) {
    const task=(await client.query(`${taskWithParentsSql} WHERE t.task_id=$1 ${lock ? "FOR UPDATE OF t,a" : ""}`, [id])).rows[0] ?? digitalNotFound();
    if(lock)assertCurrentFactoryTask(task.task_kind);
    return task;
  }
  private resource(task: { production_order_id: string | null; source_id: string | null }): Resource {
    return task.production_order_id ? { kind: "order", id: task.production_order_id } : { kind: "source", id: task.source_id! };
  }
  private async executionBlock(client: Pick<Pool, "query">, resource: Resource): Promise<string | null> {
    const parent=(await client.query(`SELECT to_jsonb(p)->>'order_time_managed' AS managed FROM ${resource.kind==='source'?'digital_production_sources':'digital_production_orders'} p WHERE ${resource.kind==='source'?'source_id':'production_order_id'}=$1`,[resource.id])).rows[0];
    if(parent?.managed==='true'&&!orderTimeAdmission(client)){
      const subject=(await client.query(`SELECT effective FROM digital_order_time_subjects WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2`,[resource.kind,resource.id])).rows[0];
      if(subject?.effective===false)return '本单时效尚未生效，请先处理本单时效申请';
    }
    if(resource.kind==='order'&&(await client.query("SELECT to_regclass('digital_order_closures') AS relation")).rows[0]?.relation&&(await client.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[resource.id])).rowCount)return '母单已特殊结案';
    const state = (await client.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0]?.state ?? "active";
    return state === "active" ? null : state === "paused" ? "订单已暂停" : "订单已取消";
  }
  private async active(client: PoolClient, resource: Resource) {
    const blocked=await this.executionBlock(client,resource);if(blocked)fail(blocked);
  }
  private async conditionsReady(client: PoolClient, id: string, completion = false) {
    const unmet = await client.query(`SELECT 1 FROM digital_production_task_conditions WHERE task_id=$1 AND NOT satisfied AND (stage='activation' OR $2::boolean)
      UNION ALL SELECT 1 FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id WHERE d.task_id=$1 AND p.state<>'completed' AND p.node_key<>'factory_material_count' LIMIT 1`, [id, completion]);
    return !unmet.rowCount;
  }
  private async event(client: PoolClient, actor: TrustedActorContext, taskId: string | null, resource: Resource, kind: string, occurredAt: string | null, quality: TimeQuality, payload: unknown = {}, corrects: string | null = null) {
    const eventId = randomUUID();
    await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload,corrects_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [eventId, taskId, resource.kind, resource.id, kind, actor.actorId, occurredAt, quality, JSON.stringify(payload), corrects]);
    await client.query("INSERT INTO digital_production_event_intents(event_id,task_id,event_kind) VALUES($1,$2,$3)", [eventId, taskId, kind]);
    return eventId;
  }
  private async policy(client: PoolClient | Pick<Pool, "query">, key: string, taskId?: string) {
    if (taskId) {
      const frozen = await frozenSlaTaskPolicy(client, taskId, key);
      if (frozen) return frozen;
    }
    return (await client.query("SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version DESC LIMIT 1", [key])).rows[0] ?? digitalNotFound();
  }
  /** The original task and its occurrence stay put. Only open tasks gain a
   * formal responsibility window when this same source is confirmed. */
  async adoptPreorderTaskTimingWithClient(client:PoolClient,actor:TrustedActorContext,sourceId:string){
    const admission=orderTimeAdmission(client);
    if(admission?.operation.kind!=='confirm_order'||admission.operation.sourceId!==sourceId)fail('仅正式确认事务可采用原预下单任务时效');
    const tasks=(await client.query<{task_id:string;task_kind:string;entered_at:Date|string}>(`SELECT t.task_id,a.task_kind,t.entered_at
      FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
      WHERE a.source_id=$1 AND t.state IN ('ready','blocked') AND t.entered_at IS NOT NULL
      ORDER BY t.task_id FOR UPDATE OF t`,[sourceId])).rows;
    for(const task of tasks){
      const event=await this.event(client,actor,task.task_id,{kind:'source',id:sourceId},'formal_preorder_adopted',admission!.time.now,'现场登记');
      await this.revision(client,actor,task.task_id,await this.policy(client,task.task_kind,task.task_id),iso(task.entered_at),'policy',event);
    }
  }
  private async revision(client: PoolClient, actor: TrustedActorContext, taskId: string, policy: { node_key: string; version: number; sla_seconds: string | number | null; warning_ratio: string | number;sla_application_basis?:Record<string,unknown> }, enteredAt: string | null, reason: string, eventId: string, timingOverride?:Awaited<ReturnType<typeof factoryTaskTiming>>,readyCorrection?:{at:string|null;eventId:string},refreshDerivedStart=false) {
    const task=await this.task(client,taskId);
    if(task.task_kind==='bulk_ship_sample'&&task.production_order_id){
      const targets=await shipSampleTargets(client,task.production_order_id,task.order_time_managed===true);
      if(targets.snapshotId){
        const remaining=targets.lines.filter(l=>!l.sent);
        const dueAt=(remaining.length?remaining:targets.lines).map(l=>l.dueAt).filter((d):d is string=>d!==null).sort()[0]??null;
        const deadline={warningAt:null,dueAt};
        await client.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by,sla_basis,deadline_kind)
          VALUES($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,'date_target')`,[taskId,policy.node_key,policy.version,dueAt,reason,eventId,actor.actorId,JSON.stringify({snapshotId:targets.snapshotId,parameterKey:'ship_sample_advance',precision:'date',exclusive:true,targets:targets.lines})]);
        return deadline;
      }
    }
    const nativeTiming=timingOverride??await developmentTaskTiming(client,task)??await bulkTaskTiming(client,task)??await factoryTaskTiming(client,task);
    const timing=await orderTimeNativeTiming(client,task,nativeTiming,enteredAt,readyCorrection,refreshDerivedStart);
    if(timing){
      const deadline=digitalDeadline(timing.enteredAt,timing.seconds,timing.warningRatio);
      if('calendarRef'in timing&&timing.calendarRef&&timing.enteredAt&&timing.seconds!==null){
        deadline.dueAt=new Date(shiftFixedTimeline(timing.enteredAt,timing.seconds/60,timing.calendarRef));
        deadline.warningAt=new Date(shiftFixedTimeline(timing.enteredAt,timing.seconds/60*timing.warningRatio,timing.calendarRef));
      }
      // Preserve the native typed time boundary. Muting the node's reminder
      // is handled by its persisted preference, not by deleting clock facts.
      await client.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by,sla_basis)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[taskId,policy.node_key,policy.version,timing.enteredAt,deadline.warningAt,deadline.dueAt,reason,eventId,actor.actorId,JSON.stringify(timing)]);
      return deadline;
    }
    const deadline = digitalDeadline(enteredAt, policy.sla_seconds === null ? null : Number(policy.sla_seconds), Number(policy.warning_ratio));
    if(policy.sla_application_basis){
      await client.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by,sla_basis)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[taskId,policy.node_key,policy.version,enteredAt,deadline.warningAt,deadline.dueAt,reason,eventId,actor.actorId,JSON.stringify({...policy.sla_application_basis,enteredAt,basis:[`task:${taskId}`]})]);
    }else{
    await client.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [taskId, policy.node_key, policy.version, enteredAt, deadline.warningAt, deadline.dueAt, reason, eventId, actor.actorId]);
    }
    return deadline;
  }
  /** Fixed technical adapters refresh a real event basis; assignment never resets its clock. */
  async refreshDevelopmentDeadlineWithClient(client:PoolClient,actor:TrustedActorContext,taskId:string){
    const task=await this.task(client,taskId);
    if(!task.source_id)return;
    await new DigitalProductionAccessPolicy(client).assert(actor,'source',task.source_id,'technical');
    const timing=await developmentTaskTiming(client,task);if(!timing)return;
    const prior=(await client.query('SELECT sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1',[taskId])).rows[0]?.sla_basis;
    if(isDeepStrictEqual(prior,timing))return;
    const event=await this.event(client,actor,taskId,{kind:'source',id:task.source_id},'technical_basis_recorded',businessNow().toISOString(),'现场登记',{basis:timing.basis});
    await this.revision(client,actor,taskId,await this.policy(client,task.task_kind,taskId),null,'activation',event);
  }
  /** Organization readiness precedes assignment, but never bypasses execution
   * conditions. Capture a current conjunction in this native write transaction;
   * do not infer historical overlap from unrelated old timestamps.
   */
  private async captureNativeReadiness(client:PoolClient,actor:TrustedActorContext,task:{task_id:string;task_kind:string;source_id:string|null;production_order_id:string|null;route_instance_id:string;route_version:number;state:string},physicalCut?:{cuttingOrderId:string;actualCutCount:number}){
    const craft=Boolean(task.source_id&&FIXED_DEVELOPMENT_CRAFT_TASKS.has(task.task_kind));
    if(!NATIVE_READINESS_KINDS.has(task.task_kind)&&!craft||['completed','cancelled'].includes(task.state))return;
    const saved=(await nativeTaskReadiness(client,[task.task_id])).get(task.task_id);
    if(!saved?.tracked)return;
    if(craft){
      if(saved.eventId)return;
      const timing=await fixedCraftTiming(client,task,{prerequisitesOnly:true});if(!timing?.enteredAt)return;
      const eventId=randomUUID();
      await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
        VALUES($1,$2,'source',$3,'ready',$4,$5,'现场登记',$6)`,[eventId,task.task_id,task.source_id,actor.actorId,timing.enteredAt,
        JSON.stringify({readinessOnly:true,nativeReadiness:{version:1,scopeRef:`task:${task.task_id}:route:${task.route_instance_id}:${task.route_version}`,basis:timing.basis}})]);
      return eventId;
    }
    const sewing=task.task_kind==='development_sewing'||task.task_kind==='development_sewing_transfer';
    if(sewing&&saved.eventId)return;
    const ignored=sewing?['handover_received','pattern_assignment_ready','materials_ready']:[];
    const unmet=await client.query(`SELECT 1 FROM digital_production_task_conditions
      WHERE task_id=$1 AND stage='activation' AND NOT satisfied AND NOT(condition_key=ANY($2::text[]))
      UNION ALL SELECT 1 FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id
      WHERE d.task_id=$1 AND p.state<>'completed' AND p.node_key<>'factory_material_count' LIMIT 1`,[task.task_id,ignored]);
    if(unmet.rowCount)return;
    const basis:string[]=[];
    if(sewing){
      if(!task.source_id)return;
      const prerequisites=await developmentTaskTiming(client,task,{prerequisitesOnly:true});
      const materials=await materialReadiness(client,task.source_id,task.route_version);
      if(!prerequisites?.enteredAt||!materials.sewingReady)return;
      basis.push(...prerequisites.basis,`development:${task.source_id}:round:${task.route_version}`,
        ...materials.materials.filter(material=>material.required).map(material=>`material:${material.materialId}:verification:${material.evidenceId}`));
    }
    const conditions=(await client.query(`SELECT c.condition_key,event.event_id,event.payload->>'satisfied' AS evidence_satisfied
      FROM digital_production_task_conditions c LEFT JOIN LATERAL(SELECT e.event_id,e.payload FROM digital_production_task_events e
      LEFT JOIN digital_production_event_intents i USING(event_id)
      WHERE e.task_id=c.task_id AND e.event_kind='condition' AND e.payload->>'condition'=c.condition_key
      ORDER BY (to_jsonb(i)->>'notification_sequence')::bigint DESC NULLS LAST,e.recorded_at DESC,e.event_id DESC LIMIT 1) AS event ON true
      WHERE c.task_id=$1 AND c.stage='activation' AND c.satisfied
       AND NOT(c.condition_key=ANY($2::text[])) ORDER BY c.condition_key`,[task.task_id,ignored])).rows;
    if(conditions.some(condition=>!condition.event_id||condition.evidence_satisfied!=='true'))return;
    basis.push(...conditions.map(condition=>`condition:${condition.event_id}:${condition.condition_key}`));
    if(!sewing){
      if(!task.production_order_id)return;
      // Use the actual cutting service's complete gate, including technical
      // tests and this PO's labels; task activation alone is insufficient.
      const {digitalCuttingGate}=await import('./bulk-preparation-service.js');
      const cuts=(await client.query(`SELECT map.line_id,c.cutting_order_id,c.already_cut FROM digital_production_child_lines map
       JOIN LATERAL(SELECT cut.cutting_order_id,EXISTS(SELECT 1 FROM cutting_records record WHERE record.cutting_order_id=cut.cutting_order_id) AS already_cut
        FROM cutting_orders cut WHERE cut.cutting_order_id=map.child_id) c ON true
       WHERE map.module='cutting' AND map.production_order_id=$1 AND map.child_line_key='record' ORDER BY map.line_id,map.child_id`,[task.production_order_id])).rows;
      const recorded=await nativeCuttingReadiness(client,[task.task_id]);
      if(saved.eventId&&cuts.every(cut=>recorded.some(fact=>fact.lineId===cut.line_id&&fact.cuttingOrderId===cut.cutting_order_id)))return;
      let allReady=cuts.length>0;
      for(const cut of cuts){
        // Only this native cutting write has validated an actual quantity.
        // Sibling scopes still use their own original full-quantity gate.
        const actualCutCount=physicalCut&&physicalCut.cuttingOrderId===cut.cutting_order_id?physicalCut.actualCutCount:undefined;
        const gate=await digitalCuttingGate(client,this.database,cut.cutting_order_id,actualCutCount);
        if(!gate?.ready||gate.taskId!==task.task_id){allReady=false;continue;}
        const scopeRef=`po:${cut.line_id}:cut:${cut.cutting_order_id}`;
        if(recorded.some(fact=>fact.scopeRef===scopeRef))continue;
        // A prior physical cut makes the original gate waive some checks. It
        // is not evidence for reconstructing a missing first-ready timestamp.
        if(cut.already_cut){allReady=false;continue;}
        const {productionReadiness}=await import('./production-readiness-repository.js');
        const readiness=await productionReadiness(client,task.production_order_id);
        const eventId=randomUUID();
        await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
         VALUES($1,$2,'order',$3,'ready',$4,$5,'现场登记',$6)`,[eventId,task.task_id,task.production_order_id,actor.actorId,businessNow().toISOString(),JSON.stringify({readinessOnly:true,nativeReadiness:{version:1,scopeKind:'po',scopeRef,lineId:cut.line_id,cuttingOrderId:cut.cutting_order_id,basis:[...basis,`digitalCuttingGate:${cut.cutting_order_id}:full-current-gate`,...(actualCutCount===undefined?[]:[`actual-cut-quantity:${actualCutCount}`]),`preparation-readiness:${readiness.revision}`]}})]);
      }
      if(!allReady||saved.eventId)return;
      basis.push(...cuts.map(cut=>`digitalCuttingGate:${cut.cutting_order_id}:full-current-gate`));
    }
    // This records a fact, not a ready-state notification or a new task action.
    const eventId=randomUUID();
    await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
      VALUES($1,$2,$3,$4,'ready',$5,$6,'现场登记',$7)`,[eventId,task.task_id,this.resource(task).kind,this.resource(task).id,actor.actorId,businessNow().toISOString(),JSON.stringify({readinessOnly:true,nativeReadiness:{version:1,scopeRef:`task:${task.task_id}:route:${task.route_instance_id}:${task.route_version}`,basis}})]);
    return eventId;
  }
  /** Caller already owns the authorized source command and transaction. */
  async refreshNativeReadinessWithClient(client:PoolClient,actor:TrustedActorContext,id:string,physicalCut?:{cuttingOrderId:string;actualCutCount:number}){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    const task=await this.task(client,id,true);
    const eventId=await this.captureNativeReadiness(client,actor,task,physicalCut);
    if(eventId)await this.applyNativeReadinessClock(client,actor,task,eventId);
  }
  private async applyNativeReadinessClock(client:PoolClient,actor:TrustedActorContext,task:Awaited<ReturnType<DigitalProductionTaskService['task']>>,eventId:string){
    const policy=await this.policy(client,task.task_kind,task.task_id),deadline=await this.revision(client,actor,task.task_id,policy,null,'activation',eventId);
    if(!['bulk_cutting','bulk_cutting_external'].includes(task.task_kind)||task.state!=='ready')return;
    const ready=(await nativeTaskReadiness(client,[task.task_id])).get(task.task_id)!;
    let clockId=task.baseline_clock_id;
    if(!clockId&&ready.firstReadyAt&&deadline.dueAt&&deadline.warningAt){
      await new ProductionOrderNodeClockRepository(client).enter({nodeInstanceId:task.task_id,productionOrderId:task.production_order_id,nodeKey:task.task_kind,occurrence:task.occurrence,
       enteredAt:new Date(ready.firstReadyAt),dueAt:deadline.dueAt,warningAt:deadline.warningAt,deadlinePolicyKey:task.task_kind,deadlinePolicyVersion:policy.version,createdBy:actor.actorId});
      clockId=task.task_id;
    }
    await client.query('UPDATE digital_production_tasks SET entered_at=$2,entered_quality=$3,baseline_clock_id=$4 WHERE task_id=$1',[task.task_id,ready.firstReadyAt,ready.quality??'缺失',clockId]);
  }
  private async activate(client: PoolClient, actor: TrustedActorContext, id: string, occurredAt: string | null, quality: TimeQuality) {
    const task = await this.task(client, id, true);
    const readinessEvent=await this.captureNativeReadiness(client,actor,task);
    if(readinessEvent)await this.applyNativeReadinessClock(client,actor,task,readinessEvent);
    if (await requiresDevelopmentAssignee(client,task) && (!task.assignee_id||(await client.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation&&!await new DigitalProductionAccessPolicy(client).activeRole(task.assignee_id,task.required_role)&&!(['development_sewing','development_patch'].includes(task.task_kind)&&task.source_id&&await isNativeRootSewingRecipient(client,task.source_id,task.assignee_id)))) return false;
    if(task.task_kind==="development_sewing"&&await activateInitialDevelopmentExecution(client,actor,id,new TodoService(this.database))){
      const activatedAt=businessNow().toISOString();
      await client.query("UPDATE digital_production_task_conditions SET satisfied=true,occurred_at=$2 WHERE task_id=$1 AND condition_key='pattern_assignment_ready'",[id,activatedAt]);
      await this.event(client,actor,id,this.resource(task),"condition",activatedAt,"现场登记",{condition:"pattern_assignment_ready",satisfied:true,note:"本轮安排与实际前置齐备，首次执行已衔接"});
    }
    const restoring=task.state==='blocked'&&task.blocked_reason==='前置条件未满足';
    if ((task.state !== "pending"&&!restoring) || !await this.conditionsReady(client, id)) return false;
    const lifecycle = (await client.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [this.resource(task).kind, this.resource(task).id])).rows[0]?.state;
    if (lifecycle === "paused" || lifecycle === "cancelled") return false;
    if(restoring){
      await client.query("UPDATE digital_production_tasks SET state='ready',blocked_reason=NULL WHERE task_id=$1",[id]);
      await this.event(client,actor,id,this.resource(task),'unblocked',businessNow().toISOString(),'现场登记',{note:'业务前置恢复，保留原进入时间'});
      if(['bulk_cutting','bulk_cutting_external'].includes(task.task_kind))await this.refreshNativeReadinessWithClient(client,actor,id);
      return true;
    }
    const facts = (await client.query(`SELECT count(*)::int AS count,bool_or(moment IS NULL) AS has_unknown,max(moment) AS latest_at,
      bool_or(coalesce(quality,'缺失') NOT IN ('现场登记','已核实')) AS has_unverified,bool_and(quality='已核实') AS all_verified FROM (
      SELECT c.occurred_at AS moment,(SELECT e.time_quality FROM digital_production_task_events e
        LEFT JOIN digital_production_event_intents i USING(event_id)
        WHERE e.task_id=c.task_id AND e.event_kind='condition' AND e.payload->>'condition'=c.condition_key
        ORDER BY (to_jsonb(i)->>'notification_sequence')::bigint DESC NULLS LAST,e.recorded_at DESC,e.event_id DESC LIMIT 1) AS quality
      FROM digital_production_task_conditions c WHERE c.task_id=$1 AND c.stage='activation' AND c.satisfied
      UNION ALL SELECT p.completed_at,p.completed_quality FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id WHERE d.task_id=$1 AND p.node_key<>'factory_material_count'
      UNION ALL SELECT occurred_at,time_quality FROM digital_production_task_events
        WHERE task_id=$1 AND event_kind='reassigned' AND $2::boolean
      ) facts`, [id, await requiresDevelopmentAssignee(client,task)])).rows[0];
    if (facts.has_unknown) occurredAt = null;
    else if (facts.count > 0) {occurredAt = iso(facts.latest_at);quality=facts.has_unverified?'补报未核实':facts.all_verified?'已核实':'现场登记';}
    if (occurredAt === null) quality = "缺失";
    else if (quality === "缺失") quality = "补报未核实";
    const bulkTiming=await bulkTaskTiming(client,task)??await factoryTaskTiming(client,task);
    if(bulkTiming){occurredAt=bulkTiming.enteredAt;quality=bulkTiming.timeQuality as TimeQuality;}
    if(NATIVE_READINESS_KINDS.has(task.task_kind)||task.source_id&&FIXED_DEVELOPMENT_CRAFT_TASKS.has(task.task_kind)){
      const readiness=(await nativeTaskReadiness(client,[id])).get(id);
      if(readiness?.tracked){occurredAt=readiness.firstReadyAt;quality=(readiness.quality??'缺失') as TimeQuality;}
    }
    const policy = await this.policy(client, task.task_kind, task.task_id);
    const eventId = await this.event(client, actor, id, this.resource(task), "ready", occurredAt, quality);
    const deadline = await this.revision(client, actor, id, policy, occurredAt, "activation", eventId);
    let clockId: string | null = null;
    if (task.production_order_id && occurredAt && deadline.dueAt && deadline.warningAt) {
      clockId = id;
      await new ProductionOrderNodeClockRepository(client).enter({ nodeInstanceId: id, productionOrderId: task.production_order_id, nodeKey: task.task_kind, occurrence: task.occurrence,
        enteredAt: new Date(occurredAt), dueAt: deadline.dueAt, warningAt: deadline.warningAt, deadlinePolicyKey: task.task_kind, deadlinePolicyVersion: policy.version, createdBy: actor.actorId });
    }
    await client.query("UPDATE digital_production_tasks SET state='ready',entered_at=$2,entered_quality=$3,baseline_clock_id=$4 WHERE task_id=$1", [id, occurredAt, quality, clockId]);
    if(['bulk_cutting','bulk_cutting_external'].includes(task.task_kind))await this.refreshNativeReadinessWithClient(client,actor,id);
    return true;
  }
  // Called by fixed business adapters inside their own transaction; no public task-builder route.
  async createWithClient(client: PoolClient, actor: TrustedActorContext, input: { resource: Resource; authorizingTaskId?: string; kind: DigitalTaskKind; routeId: string; routeVersion: number; occurrence: number; routePosition?:number; assigneeId: string | null; predecessors?: string[]; conditions?: typeof DIGITAL_CONDITION_KEYS[number][]; occurredAt?: string | null }) {
    assertCurrentFactoryTask(input.kind);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    await this.active(client, input.resource);
    const context=acceptanceBusinessContext();if(context)await context.assertScope(input.resource);
    await assertAcceptanceAssignee(input.assigneeId);
    if (input.authorizingTaskId) {
      const origin = await this.task(client, input.authorizingTaskId);
      if (this.resource(origin).kind !== input.resource.kind || this.resource(origin).id !== input.resource.id) digitalForbidden();
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", input.authorizingTaskId, "execute");
    } else await new DigitalProductionAccessPolicy(client).assert(actor, input.resource.kind, input.resource.id, "technical");
    const column = input.resource.kind === "order" ? "production_order_id" : "source_id";
    const fixed=await prepareFixedTaskPosition(client,input),occurrence=fixed?.occurrence??input.occurrence;
    const existing = (await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.${column}=$1 AND a.task_kind=$2 AND t.occurrence=$3`, [input.resource.id, input.kind, occurrence])).rows[0];
    if (existing) fail("本轮该节点任务已经存在");
    for (const predecessor of input.predecessors ?? []) {
      const prior = await this.task(client, predecessor);
      if (this.resource(prior).kind !== input.resource.kind || this.resource(prior).id !== input.resource.id || prior.route_instance_id !== input.routeId) fail("前置任务必须属于同一业务轮次");
    }
    const id = await createDigitalTaskAccess(client, actor, { kind: input.kind, assigneeId: input.assigneeId, ...(input.resource.kind === "order" ? { orderId: input.resource.id } : { sourceId: input.resource.id }) });
    await client.query("INSERT INTO digital_production_tasks(task_id,node_key,route_instance_id,route_version,occurrence) VALUES($1,$2,$3,$4,$5)", [id, input.kind, input.routeId, input.routeVersion, occurrence]);
    if(fixed)await insertFixedTaskPosition(client,id,fixed);
    for (const prior of input.predecessors ?? []) await client.query("INSERT INTO digital_production_task_dependencies(task_id,predecessor_id) VALUES($1,$2)", [id, prior]);
    let activation=REQUIRED_ACTIVATION[input.kind]??[];
    if(input.resource.kind==='order'&&['bulk_pattern','warehouse_preshrink'].includes(input.kind)){
      const prep=(await client.query('SELECT preparation_id,workflow_version,preshrink FROM digital_bulk_preparations WHERE preparation_id=$1 AND production_order_id=$2',[input.routeId,input.resource.id])).rows[0];
      if(input.kind==='warehouse_preshrink'&&prep&&(await readBulkPreshrinkRequirement(client,prep)).requirement!=='需要预缩')fail('本制单未要求预缩，不能创建预缩任务');
      if(prep?.workflow_version===2)activation=input.kind==='bulk_pattern'?['customer_confirmed']:['materials_ready'];
    }
    for (const condition of new Set([...activation, ...(input.conditions ?? []), "business_recorded" as const])) {
      if (!DIGITAL_CONDITION_KEYS.includes(condition)) fail("未知前置条件");
      await client.query("INSERT INTO digital_production_task_conditions(task_id,condition_key,stage) VALUES($1,$2,$3)", [id, condition, condition === "business_recorded" ? "completion" : "activation"]);
    }
    // Enroll only native SLA routes. Older order-scoped development tasks and
    // manually created legacy routes keep their original clock contract.
    // An execution-only route keeps the actual native ready event. There is
    // no frozen source SLA from which to derive an earlier policy window.
    const timingRoute=fixed?.saved.input as {executionOnly?:string}|undefined;
    const trackReadiness=Boolean(input.resource.kind==='source'&&fixed?.position.stepId&&!timingRoute?.executionOnly)||NATIVE_READINESS_KINDS.has(input.kind)&&(input.kind.startsWith('development_')
      ?input.resource.kind==='source'&&Boolean(await developmentSlaPlan(client,input.resource.id))
      :input.resource.kind==='order'&&Boolean((await client.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)
       &&Boolean((await client.query('SELECT 1 FROM digital_bulk_preparations WHERE preparation_id=$1 AND production_order_id=$2 AND workflow_version=2 AND sla_snapshot_id IS NOT NULL',[input.routeId,input.resource.id])).rowCount));
    const createdEvent=await this.event(client, actor, id, input.resource, "created", businessNow().toISOString(), "现场登记",trackReadiness?{readinessCaptureVersion:1}:{});
    const activated=await this.activate(client, actor, id, input.occurredAt === undefined ? businessNow().toISOString() : input.occurredAt, input.occurredAt === null ? "缺失" : input.occurredAt === undefined ? "现场登记" : "补报未核实");
    if(!activated&&(await developmentTaskTiming(client,await this.task(client,id))||await bulkTaskTiming(client,await this.task(client,id))||await factoryTaskTiming(client,await this.task(client,id))))
      await this.revision(client,actor,id,await this.policy(client,input.kind,id),null,'activation',createdEvent);
    return { taskId: id };
  }
  async documents(actor:TrustedActorContext,id:string){
    const db=await this.database.connect();
    try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await taskDocuments(db,actor,id);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async resourceDocuments(actor:TrustedActorContext,kind:'source'|'order',id:string){
    const db=await this.database.connect();
    try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await resourceDocuments(db,actor,kind,id);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  // Only omission denotes the server's live business action. Explicit dates remain backreports.
  async setConditionWithClient(client: PoolClient, actor: TrustedActorContext, id: string, condition: typeof DIGITAL_CONDITION_KEYS[number], satisfied: boolean, occurredAt: string | null | undefined = undefined, note = "") {
    const at=occurredAt===undefined?businessNow().toISOString():occurredAt;
    const quality:TimeQuality=at===null?'缺失':occurredAt===undefined?'现场登记':'补报未核实';
    return this.conditionFactWithClient(client,actor,id,condition,satisfied,at,quality,note);
  }
  // A fixed server adapter reads the inherited fact; no client can supply a trusted quality.
  async inheritWashingConditionWithClient(client:PoolClient,actor:TrustedActorContext,id:string,inheritedTaskId:string,note:string){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    const task=await this.task(client,id,true),original=await this.task(client,inheritedTaskId);
    if(task.task_kind!=='development_tail_check'||original.task_kind!=='development_washing'||original.state!=='completed'||!task.source_id||task.source_id!==original.source_id)fail('继承洗水完成证据不属于该开发单');
    const at=iso(original.completed_at),quality:TimeQuality=at===null?'缺失':original.completed_quality;
    return this.conditionFactWithClient(client,actor,id,'washing_finished',true,at,quality,note,{inheritedTaskId});
  }
  private async conditionFactWithClient(client:PoolClient,actor:TrustedActorContext,id:string,condition:typeof DIGITAL_CONDITION_KEYS[number],satisfied:boolean,at:string|null,quality:TimeQuality,note:string,provenance:Record<string,string>={}){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    const task = await this.task(client, id, true);
    if (["completed", "cancelled"].includes(task.state)) fail("已结束任务不能重写条件");
    if(condition==='pattern_assignment_ready'&&satisfied)await this.refreshDevelopmentMaterialCondition(client,actor,id);
    if (at !== null && (!Number.isFinite(new Date(at).getTime()) || new Date(at).getTime() > businessNow().getTime())) fail("条件发生时间无效");
    const updated = await client.query("UPDATE digital_production_task_conditions SET satisfied=$3,occurred_at=$4 WHERE task_id=$1 AND condition_key=$2 RETURNING task_id", [id, condition, satisfied, at]);
    if (!updated.rowCount) fail("任务不包含该前置条件");
    await this.event(client, actor, id, this.resource(task), "condition", at, quality, { condition, satisfied, note,...provenance });
    if (!satisfied && task.state === "ready") await client.query("UPDATE digital_production_tasks SET state='blocked',blocked_reason='前置条件未满足' WHERE task_id=$1", [id]);
    // A negative completion-stage fact must remain blocked even when activation conditions are ready.
    return satisfied ? this.activate(client, actor, id, at, quality) : false;
  }
  async complete(actor: TrustedActorContext, id: string, input: { occurredAt?: string | null | undefined; note: string }, key: string) {
    return this.transaction(client => this.completeWithClient(client, actor, id, input, key));
  }
  // Fixed business adapters may create successors and complete in the same transaction.
  async completeWithClient(client: PoolClient, actor: TrustedActorContext, id: string, input: { occurredAt?: string | null | undefined; note: string }, key: string) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "execute");
      return this.command(client, actor, `task-complete:${id}`, key, input, async () => {
        const task = await this.task(client, id, true);
        if (task.state === "completed") return { taskId: id, state: "completed" };
        if(task.task_kind==='warehouse_preshrink'){
          const prep=(await client.query('SELECT preparation_id,preshrink FROM digital_bulk_preparations WHERE preparation_id=$1 AND production_order_id=$2',[task.route_instance_id,task.production_order_id])).rows[0];
          if(prep&&(await readBulkPreshrinkRequirement(client,prep)).requirement!=='需要预缩')fail('当前有效制单要求无需预缩，不能补造预缩完成事实');
        }
        await this.active(client, this.resource(task));
        if (task.state !== "ready" || !await this.conditionsReady(client, id, true)) {
          const blockers=await developmentTaskBlockers(client,task,false,true);
          fail(blockers.length?blockers.map(item=>`${item.name}：${item.missing}。${item.action??'请本任务负责岗位在当前办理页核对'}`).join('；'):task.state==='cancelled'?'本任务已取消，不能提交完成；请从我的待办打开当前有效任务':task.blocked_reason&&task.blocked_reason!=='前置条件未满足'?`本任务已登记问题：${task.blocked_reason}。请在当前办理页处理问题并解除登记后再提交`:'尚未取得本任务可完成的状态，具体原因未能确认；请重新读取当前办理页，仍未恢复时将任务链接交给本单管理人员核查');
        }
        const occurredAt = input.occurredAt === undefined ? businessNow().toISOString() : input.occurredAt;
        if (occurredAt && (new Date(occurredAt).getTime() > businessNow().getTime() || (task.entered_at && new Date(occurredAt) < new Date(task.entered_at)))) fail("发生时间不能晚于当前或早于任务进入");
        const quality: TimeQuality = occurredAt === null ? "缺失" : input.occurredAt === undefined ? "现场登记" : "补报未核实";
        const eventId = await this.event(client, actor, id, this.resource(task), "completed", occurredAt, quality, { note: input.note });
        await this.revision(client, actor, id, await this.policy(client, task.task_kind, task.task_id), iso(task.entered_at), "completion", eventId);
        await client.query("UPDATE digital_production_tasks SET state='completed',completed_at=$2,completed_quality=$3,terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1", [id, occurredAt, quality]);
        if(task.source_id&&await developmentTaskTiming(client,task)){
          const pending=(await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
            WHERE a.source_id=$1 AND t.route_version=$2 AND t.state IN ('pending','ready','blocked') ORDER BY t.task_id`,[task.source_id,task.route_version])).rows;
          for(const next of pending){
            const nextTask=await this.task(client,next.task_id),timing=await developmentTaskTiming(client,nextTask);
            if(!timing)continue;
            const previous=(await client.query("SELECT sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1",[next.task_id])).rows[0]?.sla_basis;
            if(!isDeepStrictEqual(previous,timing))await this.revision(client,actor,next.task_id,await this.policy(client,nextTask.task_kind,nextTask.task_id),null,'activation',eventId);
          }
        }
        if (task.baseline_clock_id && occurredAt) {
          const clock = (await client.query("SELECT entered_at,completed_at FROM production_order_node_clocks WHERE node_instance_id=$1", [id])).rows[0];
          if (clock && !clock.completed_at && new Date(occurredAt) >= new Date(clock.entered_at)) await new ProductionOrderNodeClockRepository(client).complete(id, new Date(occurredAt));
        }
        const next = await client.query("SELECT task_id FROM digital_production_task_dependencies WHERE predecessor_id=$1 ORDER BY task_id", [id]);
        for (const row of next.rows) await this.activate(client, actor, row.task_id, occurredAt, quality);
        return { taskId: id, state: "completed" };
      });
  }
  async completeCuttingFactWithClient(client:PoolClient,actor:TrustedActorContext,id:string,physical?:{cuttingOrderId:string;cuttingRecordId:string}){
    const task=await this.task(client,id,true);
    if(!['bulk_cutting','bulk_cutting_external'].includes(task.task_kind))fail('不是整款实裁任务');
    const native=(await client.query(`SELECT o.primary_merchandiser_id,p.preparation_id FROM digital_bulk_preparations p JOIN digital_production_orders o USING(production_order_id) WHERE p.preparation_id=$1 AND o.production_order_id=$2`,[task.route_instance_id,task.production_order_id])).rows[0];
    if(!native)fail('实裁任务来源不完整');
    const root=actor.actorRoles.includes('root_superuser');
    if(!root){
      if(task.task_kind==='bulk_cutting_external'){
        if(native.primary_merchandiser_id!==actor.actorId||!actor.actorRoles.includes('order_merchandiser')||!await new DigitalProductionAccessPolicy(client).activeRole(actor.actorId,'order_merchandiser'))digitalForbidden();
      }else if(!actor.actorRoles.some(r=>['cutting_worker','cutting_supervisor'].includes(r))||!(actor.authorizationCapabilities??[]).includes('cutting:records:create'))digitalForbidden();
    }
    if(physical&&await new FixedTimelineAdoptionRepository(client).existing({kind:'order',id:task.production_order_id!})){
      const scopes=(await client.query(`SELECT map.line_id,po.po_number FROM digital_production_child_lines map JOIN digital_production_po_lines po ON po.line_id=map.line_id AND po.production_order_id=map.production_order_id JOIN cutting_records record ON record.cutting_order_id=map.child_id WHERE map.module='cutting' AND map.child_line_key='record' AND map.production_order_id=$1 AND map.child_id=$2 AND record.cutting_record_id=$3`,[task.production_order_id,physical.cuttingOrderId,physical.cuttingRecordId])).rows;
      if(scopes.length===1&&!(await client.query("SELECT 1 FROM digital_production_task_events WHERE task_id=$1 AND event_kind='cutting_scope_completed' AND payload->>'cuttingRecordId'=$2",[id,physical.cuttingRecordId])).rowCount){
        await this.active(client,this.resource(task));
        await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload) VALUES($1,$2,'order',$3,'cutting_scope_completed',$4,$5,'现场登记',$6)`,[randomUUID(),id,task.production_order_id,actor.actorId,businessNow().toISOString(),JSON.stringify({lineId:scopes[0]!.line_id,cuttingOrderId:physical.cuttingOrderId,cuttingRecordId:physical.cuttingRecordId,note:`PO ${scopes[0]!.po_number??'号码尚未取得'} 原实裁登记完成`})]);
      }
    }
    const coverage=(await client.query(`SELECT count(*)::int AS total,count(r.cutting_record_id)::int AS completed FROM digital_production_po_lines po LEFT JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id AND l.production_order_id=po.production_order_id LEFT JOIN cutting_records r ON r.cutting_order_id=l.child_id WHERE po.production_order_id=$1`,[task.production_order_id])).rows[0];
    if(!coverage.total||coverage.completed!==coverage.total)return false;
    if(task.state==='completed')return true;
    await this.active(client,this.resource(task));
    if(task.state!=='ready'||!await this.conditionsReady(client,id))fail('整款开裁未就绪');
    const at=businessNow().toISOString();
    await this.setConditionWithClient(client,actor,id,'business_recorded',true,undefined,'所有PO原实裁记录已齐');
    const eventId=await this.event(client,actor,id,this.resource(task),'completed',at,'现场登记',{note:'全部PO原实裁登记完成'});
    await this.revision(client,actor,id,await this.policy(client,task.task_kind,task.task_id),iso(task.entered_at),'completion',eventId);
    await client.query("UPDATE digital_production_tasks SET state='completed',completed_at=$2,completed_quality='现场登记',terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1",[id,at]);
    if(task.baseline_clock_id)await new ProductionOrderNodeClockRepository(client).complete(id,new Date(at));
    await client.query('INSERT INTO digital_bulk_cutting_completions(preparation_id,production_order_id,task_id,completed_by,completed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(preparation_id) DO NOTHING',[native.preparation_id,task.production_order_id,id,actor.actorId,at]);
    for(const next of (await client.query('SELECT task_id FROM digital_production_task_dependencies WHERE predecessor_id=$1',[id])).rows)await this.activate(client,actor,next.task_id,at,'现场登记');
    await new FactoryFlowService(this.database).sync(client,actor,task.production_order_id);
    return true;
  }
  async refreshShipSampleTimingWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string){
    const row=(await client.query("SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",[orderId])).rows[0];
    if(!row)return;const task=await this.task(client,row.task_id);if(['completed','cancelled'].includes(task.state))return;
    const targets=await shipSampleTargets(client,orderId,task.order_time_managed===true),remaining=targets.lines.filter(l=>!l.sent);
    if(!targets.snapshotId||!remaining.length)return;
    const dueAt=remaining.map(l=>l.dueAt).filter((d):d is string=>d!==null).sort()[0]??null;
    const prior=(await client.query('SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1',[row.task_id])).rows[0];
    if(iso(prior?.due_at??null)===dueAt)return;
    const eventId=await this.event(client,actor,row.task_id,this.resource(task),'ship_sample_window',null,'缺失',{remainingLineIds:remaining.map(l=>l.lineId)});
    await this.revision(client,actor,row.task_id,await this.policy(client,task.task_kind,row.task_id),null,'correction',eventId);
  }
  async applySlaVersionWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string,applicationId:string,keys:string[]){
    const rows=(await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
      WHERE (a.production_order_id=$1 OR a.source_id=(SELECT source_id FROM digital_production_orders WHERE production_order_id=$1)) AND t.state NOT IN ('completed','cancelled')`,[orderId])).rows;
    for(const row of rows){
      const task=await this.task(client,row.task_id),parameter=slaParameterKey(task.task_kind);
      const relevant=keys.includes(parameter)||DIGITAL_SLA_PARAMETERS.find(p=>p.key===parameter)?.includedIn?.some(k=>keys.includes(k))||keys.includes('warning_ratio')||task.task_kind==='process_logistics'&&keys.some(k=>['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(k))||task.task_kind==='bulk_ship_sample'&&keys.includes('ship_sample_advance');
      if(!relevant)continue;
      const policy=await this.policy(client,task.task_kind,task.task_id);
      const event=await this.event(client,actor,task.task_id,this.resource(task),'sla_application_reference',null,'缺失',{applicationId});
      await this.revision(client,actor,task.task_id,policy,iso(task.entered_at),'policy',event);
    }
  }
  async refreshFactoryBatchTimingWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string){
    const prepared=await factoryBatchTiming(client,orderId);if(!prepared)return;
    const rows=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN ('process_logistics','bulk_qc','warehouse_dispatch') AND t.state<>'cancelled'",[orderId])).rows;
    for(const row of rows){const task=await this.task(client,row.task_id),timing=await factoryTaskTiming(client,task,prepared);if(!timing)continue;
      const previous=(await client.query('SELECT sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1',[row.task_id])).rows[0]?.sla_basis;
      if(previous&&JSON.stringify(previous.basis)===JSON.stringify(timing.basis)&&previous.enteredAt===timing.enteredAt&&previous.seconds===timing.seconds)continue;
      const eventId=await this.event(client,actor,row.task_id,this.resource(task),'factory_batch_window',timing.enteredAt,timing.timeQuality as TimeQuality,{basis:timing.basis});
      await this.revision(client,actor,row.task_id,await this.policy(client,task.task_kind,task.task_id),timing.enteredAt,'correction',eventId,timing);
    }
  }
  async completeFactoryDispatchFactsWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string,factId:string){
    const fact=(await client.query(`SELECT f.* FROM digital_factory_facts f JOIN digital_factory_routes r USING(preparation_id) WHERE r.production_order_id=$1 AND f.fact_id=$2 AND f.kind='仓库实际发厂' AND f.actor_id=$3`,[orderId,factId,actor.actorId])).rows[0];
    if(!fact||!(actor.actorRoles.includes('root_superuser')||hasWarehouseReceivingRole(actor.actorRoles)))digitalForbidden();
    const tasks=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 AND a.task_kind IN ('process_logistics','bulk_qc','warehouse_dispatch')",[fact.preparation_id])).rows;
    const source=await factoryCompletionSource(client,orderId);
    const positions=source&&'craftSteps'in source?(await client.query('SELECT task_id,step_id FROM digital_timeline_task_positions WHERE task_id=ANY($1::uuid[])',[tasks.map(row=>row.task_id)])).rows:[];
    for(const row of tasks){
      const task=await this.task(client,row.task_id,true);if(task.state==='completed')continue;
      await this.active(client,this.resource(task));if(task.state!=='ready'||!await this.conditionsReady(client,task.task_id))fail('发厂相关任务尚未就绪');
      const completion=factoryCompletionOccurrence(task,source,positions.find(position=>position.task_id===task.task_id)?.step_id);
      const at=completion.kind==='known'?completion.at:null,quality:TimeQuality=at?'现场登记':'缺失';
      await this.setConditionWithClient(client,actor,task.task_id,'business_recorded',true,undefined,'QC事实及实际发厂已齐');
      const eventId=await this.event(client,actor,task.task_id,this.resource(task),'completed',at,quality,{factId,actualSource:'factory-scoped-occurrence-v1',note:'实际发厂收口，QC判定人仍由原检查事实保留'});
      await this.revision(client,actor,task.task_id,await this.policy(client,task.task_kind,task.task_id),iso(task.entered_at),'completion',eventId);
      await client.query("UPDATE digital_production_tasks SET state='completed',completed_at=$2,completed_quality=$3,terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1",[task.task_id,at,quality]);
      if(task.baseline_clock_id&&at)await new ProductionOrderNodeClockRepository(client).complete(task.task_id,new Date(at));
    }
  }
  async refreshBusinessConditionsWithClient(client:PoolClient,actor:TrustedActorContext,id:string){
    const task=await this.task(client,id,true);await this.active(client,this.resource(task));
    if(task.state==='pending'||task.state==='blocked'&&task.blocked_reason==='前置条件未满足'){await this.activate(client,actor,id,null,'缺失');return;}

  }
  async handover(actor: TrustedActorContext, id: string, input: { occurredAt?: string | null | undefined; note: string }, key: string) {
    return this.transaction(async client => {
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "execute");
      return this.command(client, actor, `task-handover:${id}`, key, input, async () => {
        const task = await this.task(client, id, true);
        if(["bulk_pattern","warehouse_preshrink"].includes(task.task_kind))fail("请在产前准备页面由授权岗位派交");
        if (["completed", "cancelled"].includes(task.state)) fail("已结束任务不能补交接");
        await this.setConditionWithClient(client, actor, id, "handover_received", true, input.occurredAt, input.note);
        return { taskId: id };
      });
    });
  }
  async feedback(actor: TrustedActorContext, id: string, reason: string, blocked: boolean, key: string) {
    return this.transaction(async client => {
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "execute");
      return this.command(client, actor, `task-block:${id}`, key, { reason, blocked }, async () => {
        const task = await this.task(client, id, true); await this.active(client, this.resource(task));
        if (!['ready','blocked'].includes(task.state) || (!blocked && !await this.conditionsReady(client, id))) fail("当前任务不能更改阻断状态");
        await client.query("UPDATE digital_production_tasks SET state=$2,blocked_reason=$3 WHERE task_id=$1", [id, blocked ? "blocked" : "ready", blocked ? reason : null]);
        await this.event(client, actor, id, this.resource(task), blocked ? "blocked" : "unblocked", businessNow().toISOString(), "现场登记", { reason });
        return { taskId: id, state: blocked ? "blocked" : "ready" };
      });
    });
  }
  async reassign(actor: TrustedActorContext, id: string, assigneeId: string, key: string) {
    await assertAcceptanceAssignee(assigneeId);
    return this.transaction(async client => {
      const task = await this.task(client, id, true);
      if(task.task_kind==='development_patch')fail('本次补做人员与金额请在原计件执行单派工或转交，不能只改任务归属');
      if(task.task_kind==='development_cutting'&&task.source_id&&await developmentWorkflowVersion(client,task.source_id))fail('开发裁板使用固定人员，请在本单人员安排查看固定岗位设置，不逐单分派');
      if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor) && !actor.actorRoles.includes("development_clerk")) digitalForbidden();
      if((DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind)&&(await client.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation)fail("请在本单总委派页改派，填写原因并核对当前安排。");
      return this.command(client, actor, `task-reassign:${id}`, key, { assigneeId }, async () => {
        const currentFactoryScopePending = task.task_kind === "factory_production_qc" && task.state === "completed" && task.production_order_id && (!(await factoryProductionFacts(client, task.production_order_id)).complete || (await factoryProductionScopes(client,task.production_order_id)).some(scope=>scope.execution_status==='in_production'));
        if (task.state === "cancelled" || (task.state === "completed" && !currentFactoryScopePending)) fail("已结束任务不可日常改派");
        const result = await reassignDigitalTask(client, actor, id, assigneeId);
        await this.event(client, actor, id, this.resource(task), "reassigned", businessNow().toISOString(), "现场登记", { previousAssigneeId: task.assignee_id, assigneeId });
        if(task.source_id&&['development_pattern','development_printing','development_embroidery'].includes(task.task_kind))await assembleQuotation(client,task.source_id,actor.actorId);
        await this.refreshDevelopmentMaterialCondition(client,actor,id);
        if (await requiresDevelopmentAssignee(client,task)) await this.activate(client, actor, id, businessNow().toISOString(), "现场登记");
        return result;
      });
    });
  }
  private async refreshDevelopmentMaterialCondition(client:PoolClient,actor:TrustedActorContext,id:string){
    const task=await this.task(client,id);
    if(!['development_pattern','development_cutting','development_sewing'].includes(task.task_kind)||['completed','cancelled'].includes(task.state))return;
    if(!(await client.query("SELECT to_regclass('digital_development_execution_facts') AS relation")).rows[0]?.relation)return;
    if(!(await client.query("SELECT 1 FROM digital_development_documents WHERE source_id=$1 AND status='published'",[task.source_id])).rowCount)return;
    const readiness=await materialReadiness(client,task.source_id,task.route_version);
    await client.query("INSERT INTO digital_production_task_conditions(task_id,condition_key,stage) VALUES($1,'materials_ready','activation') ON CONFLICT DO NOTHING",[id]);
    const ready=task.task_kind==='development_sewing'?readiness.sewingReady:readiness.earlyReady;
    const before=(await client.query("SELECT satisfied FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='materials_ready'",[id])).rows[0];
    if(before.satisfied!==ready||(!ready&&task.state==='ready'))await this.setConditionWithClient(client,actor,id,'materials_ready',ready,undefined,'派工前核实本轮材料事实');
  }
  async previewSlaOrder(actor:TrustedActorContext,input:Parameters<SlaOrderApplicationService['preview']>[1]){return new SlaOrderApplicationService(this.database,this.previewSecret).preview(actor,input);}
  async applySlaOrder(actor:TrustedActorContext,input:Parameters<SlaOrderApplicationService['apply']>[1],key:string){return new SlaOrderApplicationService(this.database,this.previewSecret).apply(actor,input,key);}
  settingsSets(){return new SlaSettingsSetsService(this.database,this.previewSecret);}
  specialCraftLibrary(){return new SpecialCraftLibraryService(this.database);}
  orderTimeSettings(){return new OrderTimeSettingsService(this.database,this.orderTimeEnabled);}
  async readSlaDraft(actor:TrustedActorContext,group:SlaDraftGroup){return new SlaSettingsDraftService(this.database).read(actor,group);}
  async saveSlaDraft(actor:TrustedActorContext,input:unknown,key:string){return new SlaSettingsDraftService(this.database).save(actor,input,key);}
  async discardSlaDraft(actor:TrustedActorContext,input:unknown,key:string){return new SlaSettingsDraftService(this.database).discard(actor,input,key);}
  async copySlaVersion(actor:TrustedActorContext,input:unknown,key:string){return new SlaSettingsDraftService(this.database).copyVersion(actor,input,key);}
  async slaHistory(actor:TrustedActorContext,input:SlaHistoryQuery){return new SlaSettingsHistoryService(this.database).list(actor,input);}
  async slaApplicationCandidates(actor:TrustedActorContext,input:SlaApplicationCandidatesQuery){return new SlaSettingsHistoryService(this.database).candidates(actor,input);}
  async slaHistoryVersion(actor:TrustedActorContext,version:number){return new SlaSettingsHistoryService(this.database).version(actor,version);}
  async slaSettings(actor:TrustedActorContext,version?:number){
    return this.transaction(client=>new SlaSettingsService(this.previewSecret).read(client,actor,version));
  }
  async slaCalculationPreview(actor:TrustedActorContext,input:unknown){return new SlaCalculationService(this.database).preview(actor,input);}
  async previewSlaSettings(actor:TrustedActorContext,input:StandardDraft){
    return this.transaction(client=>new SlaSettingsService(this.previewSecret).preview(client,actor,input));
  }
  async publishSlaSettings(actor:TrustedActorContext,input:StandardDraft&{previewToken:string;savedDraftRevision?:number|undefined},key:string){
    return this.transaction(client=>new SlaSettingsService(this.previewSecret).publish(client,actor,input,key));
  }
  async policies(actor: TrustedActorContext) {
    if (!isDigitalLeader(actor)) digitalForbidden();
    return this.transaction(async client => {
      const unified = Boolean((await client.query("SELECT to_regclass('digital_sla_configurations') AS relation")).rows[0]?.relation);
      const config = unified ? await new SlaConfigurationRepository(client).current() : null;
      return (await client.query(`SELECT DISTINCT ON(node_key) node_key AS "nodeKey",label,version,sla_seconds/3600.0 AS "slaHours",warning_ratio AS "warningRatio",changed_at AS "changedAt",changed_by AS "changedBy",note
        FROM digital_production_deadline_policies WHERE node_key<>'factory_material_count' ORDER BY node_key,version DESC`)).rows.map(row => {
        const parameter = unified ? DIGITAL_SLA_PARAMETERS.find(p => p.key === slaParameterKey(row.nodeKey)) : undefined;
        const warning = config?.values.warning_ratio;
        const resolved = parameter ? config?.values[parameter.key] ?? (row.version === 1 ? parameter.defaultValue : undefined) : undefined;
        return { ...row, slaHours: resolved ? "minutes" in resolved ? resolved.minutes / 60 : null : row.slaHours === null ? null : Number(row.slaHours), warningRatio: parameter ? warning?.kind === "ratio" ? warning.percent / 100 : 0.7 : Number(row.warningRatio),
          ...(parameter ? { applicationScope: "new_orders", warningRatioEditable: false, durationRequired: ["duration", "included", "estimate"].includes(parameter.defaultValue.kind), durationEditable: ["duration", "included", "estimate"].includes(parameter.defaultValue.kind) } : {}) };
      });
    });
  }
  async changePolicy(actor: TrustedActorContext, nodeKey: string, input: { expectedVersion: number; slaHours: number | null; warningRatio: number; note: string }, key: string) {
    assertCurrentFactoryTask(nodeKey);
    if (!isDigitalLeader(actor)) digitalForbidden();
    const slaSeconds = input.slaHours === null ? null : input.slaHours * 3600;
    digitalDeadline(null, slaSeconds, input.warningRatio);
    return this.transaction(client => this.command(client, actor, `task-policy:${nodeKey}`, key, input, async () => {
      if (DIGITAL_SLA_PARAMETERS.some(p => p.key === slaParameterKey(nodeKey)) && (await client.query("SELECT to_regclass('digital_sla_configurations') AS relation")).rows[0]?.relation) {
        try { return await new SlaConfigurationService().changeLegacyPolicy(client, actor, nodeKey, input, key); }
        catch (error) { if (error instanceof SlaVersionConflict) fail(error.message); throw error; }
      }
      const prior = await this.policy(client, nodeKey);
      if (prior.version !== input.expectedVersion) fail("时效参数已更新，请刷新");
      const version = prior.version + 1;
      await client.query("INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio,changed_by,note) VALUES($1,$2,$3,$4,$5,$6,$7)", [nodeKey, version, prior.label, slaSeconds, input.warningRatio, actor.actorId, input.note]);
      const nextPolicy = await this.policy(client, nodeKey);
      const tasks = await client.query("SELECT t.task_id FROM digital_production_tasks t WHERE node_key=$1 AND state IN ('ready','blocked') ORDER BY task_id FOR UPDATE", [nodeKey]);
      for (const row of tasks.rows) {
        const task = await this.task(client, row.task_id);
        const eventId = await this.event(client, actor, task.task_id, this.resource(task), "policy_changed", businessNow().toISOString(), "现场登记", { previousVersion: prior.version, version });
        await this.revision(client, actor, task.task_id, nextPolicy, iso(task.entered_at), "policy", eventId);
      }
      await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
        VALUES($1,$2,$3,'digital_deadline_policy_changed','digital_deadline_policy',$4,$5,$6)`, [randomUUID(), actor.requestId, actor.actorId, nodeKey, JSON.stringify(prior), JSON.stringify({ ...input, version, affectedTasks: tasks.rowCount })]);
      return { nodeKey, version, affectedTasks: tasks.rowCount };
    }));
  }
  /** Re-evaluate only causal native windows. A time correction never creates
   * readiness/work facts, activates tasks or rewrites completed work/P0. */
  private async refreshDevelopmentCorrectionWindows(client:PoolClient,actor:TrustedActorContext,sourceId:string,originTaskId:string,eventId:string){
    if(!await developmentSlaPlan(client,sourceId))return;
    const rows=(await client.query(`WITH RECURSIVE affected(task_id) AS (
      SELECT task_id FROM digital_production_task_dependencies WHERE predecessor_id=$2
      UNION SELECT d.task_id FROM digital_production_task_dependencies d JOIN affected parent ON d.predecessor_id=parent.task_id
    ) SELECT t.task_id,EXISTS(SELECT 1 FROM affected WHERE affected.task_id=t.task_id) AS descendant,
      current.entered_at,current.sla_basis FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
      LEFT JOIN LATERAL(SELECT entered_at,sla_basis FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1) current ON true
      WHERE a.source_id=$1 AND t.task_id<>$2 AND t.state<>'cancelled' ORDER BY t.route_version,t.created_at,t.task_id`,[sourceId,originTaskId])).rows;
    const reference=`task:${originTaskId}:completed`;
    for(const row of rows){
      const next=await this.task(client,row.task_id),native=await developmentTaskTiming(client,next);if(!native)continue;
      const priorRefs=Array.isArray(row.sla_basis?.basis)?row.sla_basis.basis:[];
      if(!row.descendant&&!native.basis.includes(reference)&&!priorRefs.includes(reference))continue;
      const resolved=await orderTimeNativeTiming(client,next,native,iso(next.entered_at),undefined,true);
      if(resolved&&!isDeepStrictEqual(row.sla_basis,JSON.parse(JSON.stringify(resolved))))await this.revision(client,actor,next.task_id,await this.policy(client,next.task_kind,next.task_id),iso(next.entered_at),'correction',eventId,undefined,undefined,true);
    }
  }
  async correctTime(actor: TrustedActorContext, id: string, input: { eventId: string; occurredAt: string | null; reason: string }, key: string) {
    if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor)) digitalForbidden();
    return this.transaction(async client => {
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "technical");
      return this.command(client, actor, `task-time:${id}`, key, input, async () => {
        const task = await this.task(client, id, true);
        const original = (await client.query("SELECT * FROM digital_production_task_events WHERE event_id=$1 AND task_id=$2 AND event_kind IN ('ready','completed','cutting_scope_completed')", [input.eventId, id])).rows[0] ?? digitalNotFound();
        if (task.state === "cancelled") fail("已取消任务不能订正办理时间");
        const corrected = input.occurredAt === null ? null : new Date(input.occurredAt);
        if (corrected && (!Number.isFinite(corrected.getTime()) || corrected.getTime() > businessNow().getTime())) fail("请填写过去真实时间或明确未知");
        const poCut=original.event_kind==='cutting_scope_completed',cutReady=poCut?(await nativeCuttingReadiness(client,[id])).find(ready=>ready.lineId===original.payload.lineId&&ready.cuttingOrderId===original.payload.cuttingOrderId):null;
        const entry = original.event_kind === 'ready' ? corrected : poCut?cutReady?.firstReadyAt?new Date(cutReady.firstReadyAt):null:task.entered_at?new Date(task.entered_at):null;
        const completion = original.event_kind === "completed"||poCut ? corrected : task.completed_at ? new Date(task.completed_at) : null;
        if (entry && completion && completion < entry) fail("完成时间不能早于进入时间");
        const poReady=original.payload?.nativeReadiness?.scopeKind==='po';
        const readiness=!poReady&&original.event_kind==='ready'&&(NATIVE_READINESS_KINDS.has(task.task_kind)||Boolean(task.source_id&&FIXED_DEVELOPMENT_CRAFT_TASKS.has(task.task_kind)))?(await nativeTaskReadiness(client,[id])).get(id):null;
        const correctedReference=readiness?.eventId??input.eventId;
        const eventId = await this.event(client, actor, id, this.resource(task), "time_corrected", input.occurredAt, corrected ? "已核实" : "缺失", { reason: input.reason, originalKind: original.event_kind,...(correctedReference!==input.eventId?{requestedEventId:input.eventId}:{}) }, correctedReference);
        if(poReady||poCut)return {taskId:id,eventId};
        if (original.event_kind === "ready") await client.query("UPDATE digital_production_tasks SET entered_at=$2,entered_quality=$3 WHERE task_id=$1", [id, corrected, corrected ? "已核实" : "缺失"]);
        else await client.query("UPDATE digital_production_tasks SET completed_at=$2,completed_quality=$3 WHERE task_id=$1", [id, corrected, corrected ? "已核实" : "缺失"]);
        let policy = await this.policy(client, task.task_kind, task.task_id);
        if (task.state === "completed") {
          const snapshot = (await client.query(`SELECT p.* FROM digital_production_deadline_revisions r JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version
            WHERE r.task_id=$1 ORDER BY r.revision_id DESC LIMIT 1`, [id])).rows[0];
          if (snapshot) policy = snapshot;
        }
        await this.revision(client, actor, id, policy, entry?.toISOString() ?? null, "correction", eventId,undefined,original.event_kind==='ready'?{at:input.occurredAt,eventId}:undefined);
        if(task.source_id&&original.event_kind==='completed')await this.refreshDevelopmentCorrectionWindows(client,actor,task.source_id,id,eventId);
        return { taskId: id, eventId };
      });
    });
  }
  async controlResource(actor: TrustedActorContext, resource: Resource, action: "pause" | "resume" | "cancel", reason: string, key: string) {
    return this.transaction(async client => {
      const column = resource.kind === "order" ? "production_order_id" : "source_id";
      const table = resource.kind === "order" ? "digital_production_orders" : "digital_production_sources";
      const record = (await client.query(`SELECT * FROM ${table} WHERE ${column}=$1 FOR UPDATE`, [resource.id])).rows[0] ?? digitalNotFound();
      if (!isDigitalLeader(actor) && !(resource.kind === "order" && actor.actorRoles.includes("order_merchandiser") && record.primary_merchandiser_id === actor.actorId)
        && !(resource.kind === "source" && actor.actorRoles.includes("sample_designer") && record.created_by === actor.actorId)) digitalForbidden();
      return this.command(client, actor, `task-resource:${resource.kind}:${resource.id}`, key, { action, reason }, async () => {
        const current = (await client.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0]?.state ?? "active";
        if (current === "cancelled") fail("已取消业务不能重新启动");
        if (action === "resume" && current !== "paused") fail("当前业务未暂停");
        const actionAt=businessNow().toISOString();
        const state = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "active";
        await client.query(`INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by,reason) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(resource_kind,resource_id) DO UPDATE SET state=EXCLUDED.state,changed_by=EXCLUDED.changed_by,reason=EXCLUDED.reason,changed_at=CURRENT_TIMESTAMP`, [resource.kind, resource.id, state, actor.actorId, reason]);
        const tasks = await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.${column}=$1 AND t.state NOT IN ('completed','cancelled') ORDER BY t.task_id FOR UPDATE OF t`, [resource.id]);
        for (const row of tasks.rows) {
          if (action === "cancel") await client.query("UPDATE digital_production_tasks SET state='cancelled',terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1", [row.task_id]);
          await this.event(client, actor, row.task_id, resource, action, actionAt, "现场登记", { reason });
        }
        if (action === "resume") for (const row of tasks.rows) await this.activate(client, actor, row.task_id, null, "缺失");
        if (!tasks.rowCount) await this.event(client, actor, null, resource, action, actionAt, "现场登记", { reason });
        else if(action==='cancel')await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
          VALUES($1,NULL,$2,$3,'cancel',$4,$5,'现场登记',$6)`,[randomUUID(),resource.kind,resource.id,actor.actorId,actionAt,JSON.stringify({reason,scope:'whole_resource'})]);
        return { ...resource, state };
      });
    });
  }
  async read(actor: TrustedActorContext, id: string, db: Pick<Pool, "query"> = this.database,completionContext?:TaskCompletionReadContext) {
    return this.readTaskDetail(actor,id,db,completionContext);
  }
  async readWorkItem(actor:TrustedActorContext,id:string){
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const task=await this.read(actor,id,db);
      const identity=developmentRushKey(task);
      const orderRush=task.identity&&identity&&(await readDevelopmentOrderRush(db,[task])).has(identity);
      await db.query('COMMIT');
      return orderRush?{...task,orderRush:true as const}:task;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Read the final page of task details on a caller-owned read snapshot. */
  async readPage(actor:TrustedActorContext,ids:readonly string[],db:PoolClient,completions?:ReadonlyMap<string,TaskCompletionReadContext>){
    const page=await this.prepareReadPage(actor,ids,db),results=new Map<string,Awaited<ReturnType<DigitalProductionTaskService['read']>>>();
    for(const id of new Set(ids))if(page.allowed(id))results.set(id,await page.read(id,completions?.get(id)));
    return results;
  }
  async prepareReadPage(actor:TrustedActorContext,ids:readonly string[],db:PoolClient,includeHistory=false){
    const byTask=new Map<string,Awaited<ReturnType<typeof readTaskPageFacts>>>();
    const history=includeHistory?await readTaskPageHistory(db,[]):null;
    type ScopedTask=Parameters<typeof attachFactoryTaskCompletions>[1][number]&{source_id:string|null};
    const scopedTasks=new Map<string,ScopedTask[]>(),loaded=new Set<string>();
    const key=(task:{production_order_id:string|null;source_id:string|null})=>{
      const scope=this.resource(task);return `${scope.kind}:${scope.id}`;
    };
    for(const batch of taskReadBatches(ids)){
      const facts=await readTaskPageFacts(db,actor,batch);
      for(const [id,task] of facts.tasks){
        byTask.set(id,facts);
        const group=key(task),rows=scopedTasks.get(group);if(rows)rows.push(task);else scopedTasks.set(group,[task]);
      }
      if(history){
        const part=await readTaskPageHistory(db,[...facts.tasks.keys()]);
        for(const [id,completion] of part.completions)history.completions.set(id,completion);
        for(const [id,assignments] of part.assignments)history.assignments.set(id,assignments);
      }
    }
    return {allowed:(id:string)=>byTask.has(id),
      read:async(id:string,completionContext?:TaskCompletionReadContext)=>{
        const facts=byTask.get(id)??digitalNotFound(),task=facts.tasks.get(id)??digitalNotFound();
        const group=key(task);
        if(!loaded.has(group)){
          const rows=scopedTasks.get(group)!;
          // Keep native derivation inside the caller's per-object savepoint.
          await attachFactoryTaskCompletions(db,rows);await attachDevelopmentRegistrations(db,rows);
          loaded.add(group);
        }
        return this.readTaskDetail(actor,id,db,completionContext,facts);
      },
      completionKeys:(id:string)=>(byTask.get(id)?.conditions.get(id)??[]).filter(row=>row.stage==='completion'&&!row.satisfied).map(row=>row.condition_key),history};
  }
  private async readTaskDetail(actor:TrustedActorContext,id:string,db:Pick<Pool,'query'>,completionContext?:TaskCompletionReadContext,prepared?:Awaited<ReturnType<typeof readTaskPageFacts>>){
    const policy = new DigitalProductionAccessPolicy(db);
    const capabilities=prepared?.authorization.get(id);
    if(prepared){if(!capabilities?.technical)digitalNotFound();}
    else await policy.assert(actor,"task",id,"technical");
    const task=prepared?prepared.tasks.get(id)??digitalNotFound():await this.task(db,id);
    if(!prepared)await attachFactoryTaskCompletions(db,[task]);
    const retired=isRetiredFactoryTask(task.task_kind);
    const effective=prepared?prepared.deadlines.get(id):(await db.query(`SELECT ${effectiveTaskDeadlineSql} WHERE r.task_id=$1 ORDER BY r.revision_id DESC LIMIT 1`,[id])).rows[0];
    const currentPolicy = effective ?? await this.policy(db, task.task_kind, task.task_id);
    const resource = this.resource(task);
    const paused = (await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0]?.state === "paused";
    const parent = (await db.query(resource.kind === "order" ? "SELECT created_by,primary_merchandiser_id,design_style_no,customer_code FROM digital_production_orders WHERE production_order_id=$1" : "SELECT created_by,design_style_no,customer_code FROM digital_production_sources WHERE source_id=$1", [resource.id])).rows[0];
    // Exact source-task authorization also permits its basic identity, matching
    // the development sheet's readable-task fallback without granting source browse access.
    const identity = resource.kind === "source" || (capabilities?capabilities.parentTechnical:await policy.allowed(actor,resource.kind,resource.id,"technical"))
      ? { designStyleNo: parent.design_style_no as string, customerCode: parent.customer_code as string | null } : null;
    const canManage = isDigitalLeader(actor) || ((task.task_kind.startsWith("development_") || task.task_kind === "bulk_pattern") && (isDigitalTechnicalManager(actor) || actor.actorRoles.includes("development_clerk")));
    const canControl = isDigitalLeader(actor) || (resource.kind === "order" ? actor.actorRoles.includes("order_merchandiser") && parent.primary_merchandiser_id === actor.actorId : actor.actorRoles.includes("sample_designer") && parent.created_by === actor.actorId);
    const assignee = task.assignee_id ? (await db.query("SELECT display_name FROM app_users WHERE id=$1", [task.assignee_id])).rows[0]?.display_name ?? null : null;
    let route = (await db.query("SELECT count(*)::int AS applicable,count(*) FILTER(WHERE state='completed')::int AS completed,count(*) FILTER(WHERE state='cancelled')::int AS cancelled FROM digital_production_tasks t WHERE route_instance_id=$1 AND NOT(t.task_id=ANY($2::uuid[])) AND node_key NOT IN ('factory_material_count','development_material_supply','development_craft_dispatch','development_sewing_transfer','development_washing_dispatch') AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')", [task.route_instance_id,await retiredBulkPreshrinkTaskIds(db)])).rows[0];
    if(task.source_id&&(await db.query("SELECT to_regclass('digital_development_documents') AS relation")).rows[0]?.relation){
      const document=(await db.query("SELECT document FROM digital_development_documents WHERE source_id=$1 AND status='published'",[task.source_id])).rows[0];
      if(document){
        const nodes:string[]=task.route_version===1?["development_materials",...await savedDevelopmentRoute(db,task.source_id,document.document)]:(await db.query("SELECT route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2",[task.source_id,task.route_version])).rows[0]?.route_nodes??[];
        const business=nodes.filter(node=>!["development_material_supply","development_craft_dispatch","development_sewing_transfer","development_washing_dispatch"].includes(node));
        const rows=(await db.query("SELECT DISTINCT CASE WHEN node_key='development_material_recheck' THEN 'development_materials' ELSE node_key END AS node,state FROM digital_production_tasks t WHERE route_instance_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')",[task.route_instance_id])).rows;
        route={applicable:business.length,completed:business.filter(node=>rows.some(row=>row.node===node&&row.state==='completed')).length,cancelled:business.filter(node=>rows.some(row=>row.node===node&&row.state==='cancelled')&&!rows.some(row=>row.node===node&&row.state==='completed')).length};
        const workflow=await developmentWorkflowVersion(db,task.source_id);
        if(workflow===2){
          const adopted=await developmentNativeRoute(db,task.source_id,task.route_version);
          if(adopted&&adopted.input.sourceVersions.routeRef===task.route_instance_id){
            const positions=(adopted.input.route??[]).filter(position=>!['development_material_supply','development_craft_dispatch','development_sewing_transfer','development_washing_dispatch'].includes(position.kind));
            const actual=(await db.query(`SELECT p.route_position,t.state FROM digital_timeline_task_positions p JOIN digital_production_tasks t USING(task_id)
              WHERE p.route_ref=$1 AND p.route_version=$2 AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')`,[task.route_instance_id,task.route_version])).rows;
            route={applicable:positions.length,completed:positions.filter(position=>actual.some(row=>row.route_position===position.position&&row.state==='completed')).length,
              cancelled:positions.filter(position=>actual.some(row=>row.route_position===position.position&&row.state==='cancelled')).length};
          }
        }
      }
    }
    const taskConditions=prepared?.conditions.get(id)??[];
    const hasHandover=prepared?taskConditions.some(row=>row.condition_key==='handover_received')
     :Boolean((await db.query("SELECT 1 FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='handover_received'",[id])).rowCount);
    const recordedPriority=prepared?prepared.priorities.get(id):(await db.query("SELECT payload->>'priority' AS priority FROM digital_production_task_events WHERE task_id=$1 AND event_kind='priority_changed' ORDER BY recorded_at DESC,event_id DESC LIMIT 1",[id])).rows[0]?.priority;
    const priority=recordedPriority==='urgent'?'urgent' as const:'normal' as const;
    const unmetConditions=retired?[]:await developmentTaskBlockers(db,task,canManage,false,prepared?{conditions:taskConditions,predecessors:prepared.predecessors.get(id)??[]}:undefined);
    if(paused)unmetConditions.push({condition:'paused',name:'业务暂停',missing:'当前业务已暂停，须先由有权人员恢复',responsibleRole:'业务负责人',action:canControl?'恢复业务':null,evidenceId:null,verified:true});
    if(task.state==='blocked'&&task.blocked_reason&&task.blocked_reason!=='前置条件未满足')unmetConditions.push({condition:'manual_block',name:'任务阻断',missing:task.blocked_reason,responsibleRole:task.required_role,action:canManage?'处理阻断原因':null,evidenceId:null,verified:true});
    const factoryQc=task.task_kind==='factory_production_qc'&&task.production_order_id?await factoryProductionFacts(db,task.production_order_id):null;
    const observed=await new ContextBusinessClock(this.database,db === this.database ? undefined : db as PoolClient).read(resource);
    const stepRef=taskCraftDisplay(task.task_kind,currentPolicy.label as string,effective?.sla_basis).stepRef;
    const frozenStep=stepRef?(await db.query(`SELECT to_jsonb(step)->'special_craft'->'definition'->>'name' AS name,step.sequence,step.craft_kind AS kind,
      (SELECT count(*)::int FROM digital_timeline_craft_steps own WHERE own.route_ref=step.route_ref) AS count
      FROM digital_timeline_craft_steps step WHERE step.step_id=$1 AND (step.source_id=$2 AND step.round_number=$3 AND step.route_ref=$4 OR step.production_order_id=$5)`,[stepRef,task.source_id,task.route_version,task.route_instance_id,task.production_order_id])).rows[0]:null;
    const craftDisplay=taskCraftDisplay(task.task_kind,currentPolicy.label as string,effective?.sla_basis,frozenStep);
    let planBinding:FixedTaskWorkBinding|undefined;
    const plannedTargets=await fixedTaskTargets(db,{taskId:id,resource,round:task.route_version,routeRef:task.route_instance_id,kind:task.task_kind},binding=>{planBinding=binding;},prepared?{position:prepared.positions.get(id)??null}:undefined);
    const currentPlanTargets=await currentTaskPlanTargets(db,{taskId:id,kind:task.task_kind,routeRef:task.route_instance_id,stepRef:craftDisplay.stepRef??null,resource,round:task.route_version,state:task.state,retired},observed,planBinding);

    if(!prepared)await attachDevelopmentRegistrations(db,[task]);
    const responsibility=task.source_id?developmentResponsibilityWindow({...task,native_readiness:effective?.native_readiness},effective?.sla_basis?effective.entered_at:task.entered_at,effective?.sla_basis,effective?.responsibility_proof):null;
    const completion=task.source_id?await readTaskCompletionOccurrence(db,task,observed.now,completionContext):null;
    return { ...craftDisplay,...(effective?.timing_mode?{deadlineMode:effective.timing_mode as "duration"|"date_target"|"unlimited",...(effective.timing_mode==='date_target'?{deadlineExclusive:true}:{})}:{}),...(observed.scenarioId?{acceptanceBusinessNow:observed.now,...(effective?.sla_basis?{deadlineExclusive:effective.sla_basis.exclusive===true}:{})}:{}),unmetConditions, identity, priority,...(retired?{retiredRule:FACTORY_RECEIPT_RETIREMENT}:{}), taskId: id, orderId: task.production_order_id as string | null, sourceId: task.source_id as string | null, taskKind: task.task_kind as string, label: retired?`${currentPolicy.label}（已停用）`:craftDisplay.label,
      ...(plannedTargets?{plannedTargets}:{}),currentPlanTargets,...(completion?{actualCompletion:completion}:{}),routeProgress: route, assigneeName: assignee, requiredRole: task.required_role, hasHandover, canManage:!retired&&canManage, canControl:!retired&&canControl, canCorrect:!retired&&( isDigitalLeader(actor) || isDigitalTechnicalManager(actor)),
      assigneeId: task.assignee_id as string | null, state: (factoryQc&&task.state==='completed'&&!factoryQc.complete?'ready':task.state) as DigitalTaskState, routeVersion: task.route_version as number, occurrence: task.occurrence as number,
      enteredAt: responsibility?responsibility.at:iso(effective?.sla_basis?effective.entered_at:task.entered_at), recordedAt: iso(task.created_at)!, completedAt: factoryQc?factoryQc.complete&&factoryQc.checks.every(c=>c.completedAt)?new Date(Math.max(...factoryQc.checks.map(c=>Date.parse(c.completedAt!)))).toISOString():null:iso(task.completed_at), paused,
      dueAt: retired||responsibility&&!responsibility.at?null:iso(effective?.due_at ?? null), warningAt: retired||responsibility&&!responsibility.at?null:iso(effective?.warning_at ?? null), slaHours: retired||currentPolicy.sla_seconds === null ? null : Number(currentPolicy.sla_seconds) / 3600,
      policyVersion: currentPolicy.version as number, timeQuality: (responsibility?.quality??(effective?.sla_basis?(effective.sla_basis.timeQuality??(effective.entered_at?'现场登记':'缺失')):task.entered_quality)) as DigitalTimeQuality, completedTimeQuality: task.completed_quality as DigitalTimeQuality,
      blockedReason: task.blocked_reason as string | null, canExecute: !retired && !paused && !await this.executionBlock(db,resource) && (capabilities?capabilities.execute:await policy.allowed(actor,"task",id,"execute")) };
  }
  async cancelForSpecialClosureWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string,reason:string){
    if(!(await client.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1 AND closed_by=$2',[orderId,actor.actorId])).rowCount)digitalForbidden();
    const rows=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND t.state NOT IN ('completed','cancelled') FOR UPDATE OF t",[orderId])).rows;
    for(const row of rows){await client.query("UPDATE digital_production_tasks SET state='cancelled',blocked_reason=$2,terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1",[row.task_id,`特殊结案：${reason}`]);await this.event(client,actor,row.task_id,{kind:'order',id:orderId},'cancelled',businessNow().toISOString(),'现场登记',{reason,specialClosure:true});}
  }
  async reassignWithClient(client:PoolClient,actor:TrustedActorContext,id:string,assigneeId:string){
    await assertAcceptanceAssignee(assigneeId);
    const task=await this.task(client,id,true);if(task.task_kind==='development_patch')fail('补做归属须随原计件执行段派工或转交');if(task.state==='cancelled'||task.state==='completed'&&(task.task_kind!=='factory_production_qc'||!(await factoryProductionScopes(client,task.production_order_id)).some(scope=>scope.execution_status==='in_production')))fail("已结束任务不可改派");
    await reassignDigitalTask(client,actor,id,assigneeId);await this.event(client,actor,id,this.resource(task),"reassigned",businessNow().toISOString(),"现场登记",{assigneeId});
    if(task.source_id&&['development_pattern','development_printing','development_embroidery'].includes(task.task_kind))await assembleQuotation(client,task.source_id,actor.actorId);
    await this.refreshDevelopmentMaterialCondition(client,actor,id);
    if (await requiresDevelopmentAssignee(client,task)) await this.activate(client,actor,id,businessNow().toISOString(),"现场登记");
  }
  /** Internal native adapter only. The already-authorized native write and this
   * source/task's exact current segment must agree before any assignment moves. */
  async syncNativeSewingWithClient(client:PoolClient,actor:TrustedActorContext,id:string,orderId:string,assigneeId:string,nativeAction:'assign'|'transfer'){
    await authorizePatternOrder(client,actor,nativeAction==='assign'?'pattern_room:orders:assign':'pattern_room:orders:transfer',true);
    const task=await this.task(client,id,true);
    if(!['development_sewing','development_patch'].includes(task.task_kind)||!task.source_id||['completed','cancelled'].includes(task.state))digitalForbidden();
    const segment=(await client.query(`SELECT 1 FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id)
      JOIN pattern_room_segments s ON s.round_id=o.current_round_id AND s.ended_at IS NULL
      WHERE l.source_id=$1 AND o.order_id=$2 AND s.worker_user_id=$3 AND o.status='in_progress'`,[task.source_id,orderId,assigneeId])).rowCount;
    if(!segment)digitalForbidden();
    if(task.task_kind==='development_patch'&&!(await client.query('SELECT 1 FROM digital_development_patch_tasks p JOIN digital_development_patch_native_rounds n USING(issue_id) JOIN pattern_room_orders o ON o.current_round_id=n.native_round_id WHERE p.task_id=$1 AND o.order_id=$2',[id,orderId])).rowCount)digitalForbidden();
    const policy=new DigitalProductionAccessPolicy(client);
    if(!await policy.lockActiveRole(assigneeId,'pattern_room_worker')&&!(await isNativeRootSewingRecipient(client,task.source_id,assigneeId)))digitalForbidden();
    if(task.assignee_id!==assigneeId){
      await client.query('UPDATE digital_production_task_access SET assignee_id=$2 WHERE task_id=$1',[id,assigneeId]);
      await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
        VALUES($1,$2,$3,'digital_task_reassigned','digital_task',$4,$5,$6)`,[randomUUID(),actor.requestId,actor.actorId,id,JSON.stringify({assigneeId:task.assignee_id}),JSON.stringify({assigneeId,nativeOrderId:orderId})]);
      await this.event(client,actor,id,this.resource(task),'reassigned',businessNow().toISOString(),'现场登记',{previousAssigneeId:task.assignee_id,assigneeId,nativeOrderId:orderId});
    }
    if(task.task_kind==='development_patch')await this.setConditionWithClient(client,actor,id,'pattern_assignment_ready',true,undefined,'本次补做原执行段已实际派工');
    await this.refreshDevelopmentMaterialCondition(client,actor,id);
    await this.activate(client,actor,id,businessNow().toISOString(),'现场登记');
  }
  /** Internal scoped-correction adapter; its caller owns Root authorization and the transaction. */
  async retirePreshrinkWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string,preparationId:string,taskId:string,correctionId:string){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    const task=await this.task(client,taskId,true);
    if(task.production_order_id!==orderId||task.route_instance_id!==preparationId||task.task_kind!=='warehouse_preshrink'||!['pending','ready','blocked'].includes(task.state)||task.completed_at)fail('指定预缩任务的归属或状态已变化');
    if((await client.query("SELECT 1 FROM digital_production_task_events WHERE task_id=$1 AND event_kind='completed'",[taskId])).rowCount)fail('原预缩任务已有实际完成记录');
    await client.query("UPDATE digital_production_tasks SET state='cancelled',blocked_reason='原制单v3明确无需预缩，受限纠正保留原任务历史',terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1",[taskId]);
    return this.event(client,actor,taskId,{kind:'order',id:orderId},'cancelled',businessNow().toISOString(),'现场登记',{reason:'scoped_preshrink_correction',preparationId,correctionId});
  }
  async supersedeBulkTasksWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string){
    // Internal adapter only: the source/approval command already authorized its actor.
    const rows=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN ('bulk_pattern','warehouse_preshrink','bulk_cutting','bulk_cutting_external') AND t.state IN ('pending','ready','blocked') FOR UPDATE OF t",[orderId])).rows;
    for(const row of rows){await client.query("UPDATE digital_production_tasks SET state='cancelled',blocked_reason='批准或技术要求已变更，保留原办理记录',terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1",[row.task_id]);await this.event(client,actor,row.task_id,{kind:"order",id:orderId},"cancelled",businessNow().toISOString(),"现场登记",{reason:"bulk_requirements_changed"});}
  }
  async supersedeSourceTasksWithClient(client:PoolClient,actor:TrustedActorContext,sourceId:string,throughRound:number,authorizingTaskId?:string){
    if(authorizingTaskId){const origin=await this.task(client,authorizingTaskId);if(origin.source_id!==sourceId)digitalForbidden();await new DigitalProductionAccessPolicy(client).assert(actor,"task",authorizingTaskId,"execute");}
    else await new DigitalProductionAccessPolicy(client).assert(actor,"source",sourceId,"technical");
    const pending=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version<=$2 AND t.state IN ('pending','ready','blocked') FOR UPDATE OF t",[sourceId,throughRound])).rows;
    for(const row of pending){await client.query("UPDATE digital_production_tasks SET state='cancelled',blocked_reason='已由新修改轮次接续，保留原记录' WHERE task_id=$1",[row.task_id]);await this.event(client,actor,row.task_id,{kind:"source",id:sourceId},"cancelled",businessNow().toISOString(),"现场登记",{reason:"new_development_round"});}
  }
  async prioritize(actor: TrustedActorContext, id: string, priority: "normal" | "urgent", key: string) {
    return this.transaction(async client => {
      const current = await this.read(actor, id, client);
      if (!current.canManage) digitalForbidden();
      if (["completed", "cancelled"].includes(current.state)) fail("已结束任务不可调整优先级");
      return this.command(client, actor, `priority:${id}`, key, { priority }, async () => {
        await this.event(client, actor, id, this.resource(await this.task(client,id,true)), "priority_changed", businessNow().toISOString(), "现场登记", { before: current.priority, priority });
        return { taskId: id, priority };
      });
    });
  }
  async readAuthorized(actor: TrustedActorContext, ids: readonly string[], db: Pick<Pool, "query"> = this.database) {
    const policy = new DigitalProductionAccessPolicy(db), tasks = [];
    for (const id of ids) if (await policy.allowed(actor, "task", id, "technical")) tasks.push(await this.read(actor, id, db));
    return tasks;
  }
  async list(actor: TrustedActorContext, page: number) {
    const db=await this.database.connect();
    try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const target=await readTechnicalTaskListPage(db,actor,page);
    const items=[...(await this.readPage(actor,target.ids,db)).values()];
    if(items.length!==target.ids.length)throw new ApplicationError('TASK_SCOPE_CHANGED','任务查看范围已变化，请刷新重试',409);
    await db.query('COMMIT');return {items,page,total:target.total};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Internal fixed-route audit only; never records receipt, approval or completion. */
  async recordSystemRouteWithClient(client:PoolClient,actor:TrustedActorContext,id:string,fromId:string){
    const from=await this.task(client,fromId),next=await this.task(client,id);
    if(from.task_kind!=='development_craft_confirmation'||from.state!=='completed'||next.task_kind!=='development_sewing'||!from.source_id||next.source_id!==from.source_id||next.route_version!==from.route_version)digitalForbidden();
    await this.event(client,actor,id,this.resource(next),'system_route',businessNow().toISOString(),'现场登记',{mode:'system_route',fromTaskId:fromId,note:'系统衔接：工艺已由设计师确认，沿用车板安排；尚未登记实际接收'});
  }
  async history(actor: TrustedActorContext, id: string) {
    await new DigitalProductionAccessPolicy(this.database).assert(actor, "task", id, "technical");
    return { events: (await this.database.query("SELECT event_id AS \"eventId\",event_kind AS kind,occurred_at AS \"occurredAt\",recorded_at AS \"recordedAt\",time_quality AS quality,corrects_event_id AS \"correctsEventId\",payload,u.display_name AS \"actorName\" FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id WHERE task_id=$1 ORDER BY recorded_at,event_id", [id])).rows,
      revisions: (await this.database.query("SELECT r.revision_id AS \"revisionId\",r.policy_version AS \"policyVersion\",r.entered_at AS \"enteredAt\",r.warning_at AS \"warningAt\",r.due_at AS \"dueAt\",to_jsonb(r)->>'deadline_kind' AS \"deadlineMode\",r.reason,r.changed_at AS \"changedAt\",((CASE WHEN NULLIF(to_jsonb(r)->'sla_basis','null'::jsonb) IS NOT NULL THEN (to_jsonb(r)->'sla_basis'->>'seconds')::numeric ELSE p.sla_seconds END) IS NOT NULL OR COALESCE(to_jsonb(r)->>'deadline_kind'='date_target',false)) AS \"hasSla\",u.display_name AS \"changedByName\" FROM digital_production_deadline_revisions r JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version JOIN app_users u ON u.id=r.changed_by WHERE r.task_id=$1 ORDER BY r.revision_id", [id])).rows };
  }
}
