import {journeyTaskSummaries} from './journey-task-summary.js';
import type { Pool, PoolClient } from "pg";
import type { JourneyFilter, JourneyNode, JourneyRecord, JourneyState, OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalTechnicalManager } from "./access-policy.js";
import { isRootActor } from "../access/business-authority.js";
import { assertIdentityActor, digitalDateText } from "./identity-service.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import { OrderClosureService } from "./order-closure-service.js";
import { developmentRoute } from "./development-route.js";
import { bulkCockpitProgress } from "./cockpit-progress.js";
import { JOURNEY_NODES, journeyDefinition } from "./journey-catalog.js";
import { journeyCompletion, journeyStages, selectJourneys } from "./journey-projection.js";
import { canReadProductionReporting, productionVisibility, productionVisibilityArgs } from "../sourcing/production-reporting-service.js";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { journeyReworkHistoryUrl } from "./journey-rework-record.js";
import { readOrderPoDeliveryDates } from "./po-delivery-query.js";
import { poDeliveryRisks } from "@dx-rework/contracts";
import { assertBusinessExportAllowed } from "../access/export-authority.js";

const iso = (value: Date|string|null|undefined) => value == null ? null : new Date(value).toISOString();
type Candidate = { source: {development_type:string;source_id:string;created_by:string;design_style_no:string;temporary_style_no:string|null;customer_code:string|null;created_at:string}|null;
  order: {production_order_id:string;source_id:string|null;created_by:string;primary_merchandiser_id:string|null;design_style_no:string;temporary_style_no:string|null;customer_code:string;product_group:string;contract_delivery_date:string|null;created_at:string}|null };
const record = (domain:string,id:string,url:string|null,version:number|null=null):JourneyRecord => ({domain,id,url,version,lineId:null,mode:"read"});
const taskUrl = (id:string) => `/ui/digital-production?task=${encodeURIComponent(id)}`;
const developmentUrl = (id:string,round?:number) => `/ui/digital-production?development=${id}${round === undefined ? "" : `&round=${round}`}`;
const emptyNode = (key:string,state:JourneyState,round:number|null=null):JourneyNode => {
  const definition=journeyDefinition(key)!;
  return {key,instanceId:`${key}:${round??0}`,label:definition.label,stage:definition.stage,state,round,occurrence:null,current:true,unavailableReason:state==="unavailable"?"permission":null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedPrecision:state==="unavailable"?"unavailable":"missing",expectedKind:state==="unavailable"?"unavailable":"unset",actualAt:null,actualQuality:state==="unavailable"?"unavailable":"missing",enteredAt:null,sla:state==="unavailable"?"unavailable":state==="not_applicable"?"not_set":"not_started",completionResult:state==="completed"?"unknown":null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:definition.count&&!["not_applicable","unavailable","inherited"].includes(state)};
};

/** Additive query API. No writes, new lifecycle, quantities or wage materialization. */
export class DigitalJourneyQuery {
  constructor(private readonly database:Pool) {}
  private async snapshot<T>(work:(db:PoolClient,asOf:string)=>Promise<T>) {
    const db=await this.database.connect();
    try { await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const asOf=iso((await db.query("SELECT CURRENT_TIMESTAMP AS as_of")).rows[0].as_of)!;
      const result=await work(db,asOf);await db.query("COMMIT");return result;
    } catch(error) { await db.query("ROLLBACK");throw error; } finally {db.release();}
  }
  private async candidates(db:PoolClient,actor:TrustedActorContext,id:string|null=null):Promise<Candidate[]> {
    const leader=isDigitalLeader(actor)||isDigitalTechnicalManager(actor);
    // Only current live roles and legitimate task assignments add scope. No style-string join.
    return (await db.query(`WITH live_roles AS (
      SELECT a.role_code FROM user_role_assignments a JOIN app_users u ON u.id=a.user_id
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE a.user_id=$1 AND a.revoked_at IS NULL AND u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
      AND a.role_code=ANY($2::text[]) AND EXISTS(SELECT 1 FROM identity_mappings m WHERE m.user_id=u.id AND m.active AND m.employed)
    ) SELECT row_to_json(s) AS source,row_to_json(o) AS "order"
    FROM digital_production_sources s FULL JOIN digital_production_orders o ON o.source_id=s.source_id
    WHERE ($4::uuid IS NULL OR s.source_id=$4 OR o.production_order_id=$4) AND ($3
      OR ('sample_designer' IN (SELECT role_code FROM live_roles) AND $1 IN (s.created_by,o.created_by))
      OR ('order_merchandiser' IN (SELECT role_code FROM live_roles) AND o.primary_merchandiser_id=$1)
      OR ('development_clerk' IN (SELECT role_code FROM live_roles) AND (o.source_id IS NOT NULL OR EXISTS(SELECT 1 FROM digital_production_task_access a WHERE a.source_id=s.source_id AND a.task_kind LIKE 'development_%')))
      OR EXISTS(SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
        WHERE (a.source_id=s.source_id OR a.production_order_id=o.production_order_id) AND a.assignee_id=$1 AND (a.required_role IN (SELECT role_code FROM live_roles) OR a.required_role='warehouse_receiver' AND 'warehouse_supervisor' IN (SELECT role_code FROM live_roles)))
)
    ORDER BY coalesce(s.created_at,o.created_at) DESC,coalesce(s.source_id,o.production_order_id) DESC`,[actor.actorId,actor.actorRoles,leader,id])).rows;
  }
  async list(actor:TrustedActorContext,filter:JourneyFilter,exportAll=false,selectPage?: (items:OrderJourney[])=>OrderJourney[],options:{details?:boolean}={}) {
    assertIdentityActor(actor);
    return this.snapshot(async(db,asOf)=>{
      // Internal workspace selection runs after all authorized facts, before detail hydration.
      const summaryOnly=options.details===false||!exportAll||Boolean(selectPage);
      const items:OrderJourney[]=[],candidates=new Map<string,Candidate>();
      for(const row of await this.candidates(db,actor)) { const item=await this.project(db,actor,row,asOf,undefined,summaryOnly);if(item){items.push(item);candidates.set(item.id,row);} }
      const facets = {
        customers: [...new Set(items.map(item=>item.customer).filter((value):value is string=>Boolean(value)))].sort(),
        categories: [...new Set(items.map(item=>item.category).filter((value):value is string=>Boolean(value)))].sort(),
        merchandisers: [...new Map(items.flatMap(item=>item.merchandisers).map(person=>[person.id,person])).values()],
      };
      const result=selectJourneys(items,filter,asOf,!exportAll);
      if(summaryOnly&&options.details!==false){
        const details:OrderJourney[]=[];
        for(const summary of selectPage?selectPage(result.items):result.items){const detail=await this.project(db,actor,candidates.get(summary.id)!,asOf);if(detail)details.push({...detail,hitReasons:summary.hitReasons});}
        result.items=details;
      }
      return {...result,canManagePolicies:isDigitalLeader(actor),facets};
    });
  }
  async export(actor:TrustedActorContext,filter:JourneyFilter) {
    assertBusinessExportAllowed(actor.actorRoles);
    const result=await this.list(actor,{...filter,page:1},true);
    return {ruleVersion:result.ruleVersion,asOf:result.asOf,total:result.total,summary:result.summary,items:result.items};
  }
  async read(actor:TrustedActorContext,id:string,round?:number) {
    assertIdentityActor(actor);
    return this.snapshot(async(db,asOf)=>{
      const row=(await this.candidates(db,actor,id))[0]??digitalNotFound();
      const item=await this.project(db,actor,row,asOf,round);return item??digitalNotFound();
    });
  }
  /** Read the original pending assignment fact without exposing its prices or altering digital tasks. */
  async pendingPatternAssignments(actor:TrustedActorContext,sourceIds:string[]):Promise<Array<{sourceId:string;orderId:string}>> {
    assertIdentityActor(actor);
    if(!isRootActor(actor)&&!isDigitalTechnicalManager(actor))digitalForbidden();
    if(!sourceIds.length)return [];
    return this.snapshot(async db=>{
      const requested=new Set(sourceIds);
      const authorized=(await this.candidates(db,actor)).flatMap(row=>row.source&&requested.has(row.source.source_id)?[row.source.source_id]:[]);
      if(!authorized.length)return [];
      return (await db.query(`SELECT l.source_id AS "sourceId",o.order_id AS "orderId"
        FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id)
        JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
        WHERE l.source_id=ANY($1::uuid[]) AND o.deleted_at IS NULL
          AND o.status='pending_assignment' AND r.status='pending_assignment'`,[authorized])).rows;
    });
  }
  private async project(db:PoolClient,actor:TrustedActorContext,row:Candidate,asOf:string,selectedRound?:number,summaryOnly=false):Promise<OrderJourney|null> {
    const policy=new DigitalProductionAccessPolicy(db),source=row.source,order=row.order;
    const sid=source?.source_id??null,oid=order?.production_order_id??null;
    const attached=Boolean(sid&&oid&&(await db.query("SELECT 1 FROM audit_events WHERE entity_type='digital_production' AND entity_id=$1 AND action='digital_source_attached' AND after_state->>'sourceId'=$2 LIMIT 1",[oid,sid])).rowCount);
    const canonicalId=attached?oid!:(sid??oid!);
    const sourceAccess=Boolean(sid&&await policy.allowed(actor,"source",sid,"technical"));
    const orderAccess=Boolean(oid&&await policy.allowed(actor,"order",oid,"technical"));
    // Order access through one assigned technical task must not expose its sibling task metadata.
    const fullOrder=orderAccess&&(isDigitalLeader(actor)||isDigitalTechnicalManager(actor)
      || actor.actorRoles.includes("sample_designer")&&order?.created_by===actor.actorId
      || actor.actorRoles.includes("order_merchandiser")&&order?.primary_merchandiser_id===actor.actorId
      || actor.actorRoles.includes("development_clerk"));
    const tasks=(await db.query(`SELECT a.task_id,a.task_kind,a.source_id,a.production_order_id,a.assignee_id,a.required_role,t.route_version,t.occurrence,t.completed_quality,t.route_instance_id,
      EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned
      FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
      WHERE a.source_id=$1 OR a.production_order_id=$2 ORDER BY t.route_version,t.created_at,t.task_id`,[sid,oid])).rows;
    const visibleTasks: typeof tasks=[];
    for(const task of tasks) {
      const direct=task.assignee_id===actor.actorId&&await policy.activeRole(actor.actorId,task.required_role);
      if((task.source_id?sourceAccess:fullOrder)||direct)visibleTasks.push(task);
    }
    if(!sourceAccess&&!orderAccess&&!visibleTasks.length)return null;
    if(selectedRound!==undefined&&!sourceAccess)digitalNotFound();
    const document=sid&&sourceAccess?(await db.query("SELECT * FROM digital_development_documents WHERE source_id=$1",[sid])).rows[0]:null;
    const revisions=sid&&sourceAccess?(await db.query("SELECT * FROM digital_development_rounds WHERE source_id=$1 ORDER BY round_number",[sid])).rows:[];
    const latestRound=revisions.at(-1)?.round_number??(document?1:null);
    const effectiveRound=sid?(await db.query("SELECT coalesce(max(round_number),1)::int AS round FROM digital_development_rounds WHERE source_id=$1",[sid])).rows[0].round:null;
    const round=selectedRound??latestRound??effectiveRound;
    if(selectedRound!==undefined&&selectedRound!==1&&!revisions.some(revision=>revision.round_number===selectedRound))digitalNotFound();
    const currentDocument=round&&round>1?revisions.find(revision=>revision.round_number===round):document;
    const declared=currentDocument?.document?round===1?["development_materials",...developmentRoute(currentDocument.document as DevelopmentDocument)]:currentDocument.route_nodes as string[]:null;
    const inherited=currentDocument?.inherited??{};
    const currentPrep=oid?(await db.query(`SELECT p.preparation_id FROM digital_bulk_preparations p
      JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
      WHERE p.production_order_id=$1 AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
      ORDER BY p.created_at DESC LIMIT 1`,[oid])).rows[0]?.preparation_id:null;
    const instruction=oid&&fullOrder?(await db.query(`SELECT v.version,v.source_round,v.published_at,v.published_by FROM digital_instruction_documents d
      JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[oid])).rows[0]:null;
    const policies=(await db.query("SELECT DISTINCT ON(node_key) node_key,sla_seconds FROM digital_production_deadline_policies ORDER BY node_key,version DESC")).rows;
    const baseNodes=JOURNEY_NODES.map(definition=>{
      const allowed=definition.stage==="creation"?sourceAccess||fullOrder:definition.stage==="development"?sourceAccess||fullOrder&&!sid:fullOrder;
      let state:JourneyState=allowed?"uncreated":"unavailable";
      if(!oid&&!["creation","development"].includes(definition.stage))state="not_applicable";
      if(definition.stage==="development"&&declared&&!declared.includes(definition.key)&&!inherited[definition.key])state="not_applicable";
      const node=emptyNode(definition.key,state,definition.stage==="development"?round:null);
      if(state!=="unavailable")node.sla=policies.find(policy=>policy.node_key===definition.key)?.sla_seconds==null?"not_set":"not_started";
      return node;
    });
    const replace=(key:string,node:JourneyNode)=>{const index=baseNodes.findIndex(value=>value.key===key);if(index>=0)baseNodes[index]=node;else baseNodes.push(node);};
    const setFact=(key:string,state:JourneyState,records:JourneyRecord[]=[],actualAt:string|null=null,owner:JourneyNode["owner"]=null)=>{
      const node=emptyNode(key,state);node.records=records;node.actualAt=actualAt;node.actualQuality=actualAt?"verified":"missing";node.completionResult=state==="completed"?"unknown":null;node.owner=owner;node.operator=state==="completed"?owner:null;replace(key,node);return node;
    };
    const chosenIdentity=orderAccess?order!:(source??order!);
    const creator=source?.created_by??order!.created_by;
    const designer=(await db.query("SELECT display_name FROM app_users WHERE id=$1",[creator])).rows[0]?.display_name??null;
    if(sourceAccess&&sid) {
      setFact("product_development","completed",[record("development",sid,developmentUrl(sid,currentDocument?round??1:undefined),currentDocument?.version??currentDocument?.document_version??null)],iso(source!.created_at),{id:creator,name:designer});
      setFact("development_publish",currentDocument?(document?.status==="published"||round&&round>1?"completed":"active"):"uncreated",[record("development",sid,developmentUrl(sid,currentDocument?round??1:undefined),currentDocument?.version??currentDocument?.document_version??null)],iso(currentDocument?.published_at),{id:creator,name:designer}).operator=currentDocument?.published_by?{id:currentDocument.published_by,name:null}:null;
      for(const [key,reference] of Object.entries(inherited) as Array<[string,{taskId:string;roundNumber:number}]>) {
        if(!journeyDefinition(key))continue;
        const value=emptyNode(key,"inherited",round);value.inheritedFrom={taskId:reference.taskId,round:reference.roundNumber};
        // Source-scoped permission covers source task history, but never an arbitrary inherited identity.
        if(visibleTasks.some(task=>task.task_id===reference.taskId))value.records=[record("task",reference.taskId,taskUrl(reference.taskId),reference.roundNumber)];
        replace(key,value);
      }
    }
    if(fullOrder&&oid)setFact("order_information","completed",[record("order",oid,`/ui/digital-production?instruction=${oid}`)],iso(order!.created_at),{id:order!.created_by,name:designer});
    if(!oid)replace("order_information",emptyNode("order_information","uncreated"));
    const taskService=new DigitalProductionTaskService(this.database),taskDtos=[];
    const summaries=summaryOnly?await journeyTaskSummaries(db,visibleTasks.map(task=>task.task_id)):null;
    for(const raw of visibleTasks) {
      const definition=journeyDefinition(raw.task_kind);if(!definition)continue;
      const task=summaries?summaries.get(raw.task_id)!:await taskService.read(actor,raw.task_id,db);taskDtos.push(task);
      const state:JourneyState=task.paused&&!["completed","cancelled"].includes(task.state)?"blocked":task.state==="ready"?"active":task.state;
      const node=emptyNode(definition.key,state,task.routeVersion);node.instanceId=task.taskId;node.occurrence=task.occurrence;
      node.expectedAt=task.dueAt;node.expectedPrecision=task.dueAt?"instant":"missing";node.expectedKind=task.dueAt?"sla":"unset";node.enteredAt=task.enteredAt;
      node.sla=task.slaHours===null?"not_set":["completed","cancelled"].includes(state)?"finished":task.enteredAt?"running":"not_started";
      node.current=raw.source_id?task.routeVersion===round&&!raw.returned:raw.task_kind==="sourcing_preparation"?task.state!=="cancelled":raw.route_instance_id===currentPrep;
      node.actualAt=task.completedAt;node.actualQuality=raw.completed_quality==="现场登记"||raw.completed_quality==="已核实"?"verified":raw.completed_quality==="补报未核实"?"unverified":"missing";
      const completion=journeyCompletion(node.expectedAt,node.actualAt,node.actualQuality==="verified");node.completionResult=state==="completed"?completion.result:null;node.overdueSeconds=state==="completed"?completion.overdueSeconds:null;
      const events=summaryOnly?[]:(await db.query(`SELECT e.*,u.display_name AS actor_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
        WHERE task_id=$1 AND event_kind IN ('created','reassigned','completed') ORDER BY recorded_at,event_id`,[task.taskId])).rows;
      const assignments=summaryOnly?[]:(await db.query("SELECT created_at,actor_id,before_state,after_state FROM audit_events WHERE entity_type='digital_task' AND entity_id=$1 AND action='digital_task_reassigned' ORDER BY created_at,id",[task.taskId])).rows;
      node.assignmentHistory=assignments.map(event=>({at:iso(event.created_at)!,actorId:event.actor_id,from:event.before_state?.assigneeId??null,to:event.after_state?.assigneeId??null}));
      const taskSummary=summaries?.get(task.taskId);
      const done=summaryOnly?taskSummary?.completion:events.filter(event=>event.event_kind==="completed").at(-1);
      node.operator=done?{id:done.actor_id,name:done.actor_name}:null;
      let ownerId=task.assigneeId;
      if(done) { const later=summaryOnly?taskSummary?.laterOwner?{before_state:taskSummary.laterOwner}:null:assignments.find(event=>new Date(event.created_at)>new Date(done.recorded_at));if(later)ownerId=later.before_state?.assigneeId??null; }
      node.owner=ownerId?{id:ownerId,name:ownerId===task.assigneeId?task.assigneeName:summaryOnly?taskSummary?.previousOwnerName??null:(await db.query("SELECT display_name FROM app_users WHERE id=$1",[ownerId])).rows[0]?.display_name??null}:null;
      node.records=[{...record("task",task.taskId,taskUrl(task.taskId),task.routeVersion),mode:task.canExecute&&!["completed","cancelled"].includes(task.state)?"handle":"read"}];
      const conditions=summaryOnly?(taskSummary?.conditionKeys??[]).map(condition_key=>({condition_key})):(await db.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND NOT satisfied",[task.taskId])).rows;
      const labels:Record<string,string>={business_recorded:"尚缺原业务完成事实",handover_received:"尚未收到实物/资料交接",materials_ready:"物料尚未齐备",owner_approved:"原外发老板批准尚未通过",pattern_ready:"纸样/唛架尚未完成",pattern_assignment_ready:"等待主管确认原打板正式派工",preshrink_ready:"预缩条件尚未齐备",craft_returned:"工艺尚未回仓",qc_approved:"整款工艺QC尚未通过",customer_confirmed:"客户样板尚未确认",all_po_complete:"全部PO/颜色尚未完成",washing_finished:"洗水尚未完成",factory_arrived:"尚缺工厂到料事实"};
      node.blockers=conditions.map(condition=>({key:condition.condition_key,label:labels[condition.condition_key]??condition.condition_key,ownerId:null,record:node.records[0]!}));
      if(task.paused)node.blockers.push({key:"resource_paused",label:"原业务已暂停",ownerId:null,record:node.records[0]!});
      if(task.blockedReason)node.blockers.push({key:"recorded_block",label:task.blockedReason,ownerId:task.assigneeId,record:node.records[0]!});
      if(["active","blocked"].includes(state)) {
        if(task.dueAt&&Date.parse(task.dueAt)<=Date.parse(asOf)){node.risks.push("overdue");node.overdueSeconds=(Date.parse(asOf)-Date.parse(task.dueAt))/1000;}
        else if(task.warningAt&&Date.parse(task.warningAt)<=Date.parse(asOf))node.risks.push("due_soon");
        if(state==="blocked")node.risks.push("blocked");
        if(!task.enteredAt)node.risks.push("unknown");
      }
      if(state==="completed"&&node.actualQuality!=="verified")node.risks.push("unknown");
      node.countsInProgress=definition.count&&!raw.returned;
      const defaultNode=baseNodes.find(value=>value.key===definition.key);
      if(node.current&&defaultNode&&defaultNode.instanceId===`${definition.key}:${defaultNode.round??0}`)replace(definition.key,node);else baseNodes.push(node);
    }
    // Each original material carries its own plan. Never infer a whole-flow target
    // from delivery dates, creation time or an SLA that has not started.
    if (sid && sourceAccess && currentDocument?.document) {
      const materialEvents = (await db.query<{material_id:string;action:string;expected_date:string|null}>(
        "SELECT material_id,action,expected_date::text FROM digital_development_material_events WHERE source_id=$1 AND route_version<=$2 ORDER BY sequence", [sid, round ?? 1])).rows;
      const today = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
      const materials = (currentDocument.document as DevelopmentDocument).materials.filter(material => material.requiredThisRound);
      const supplyPlaceholder = baseNodes.findIndex(value => value.key === "development_material_supply" && value.instanceId === `development_material_supply:${value.round ?? 0}`);
      if (!materials.length && supplyPlaceholder >= 0) baseNodes[supplyPlaceholder] = emptyNode("development_material_supply", "not_applicable", round);
      materials.forEach((material, index) => {
        const events = materialEvents.filter(event => event.material_id === material.materialId);
        const arrived = material.available || events.some(event => ["到货", "确认代用"].includes(event.action));
        const plannedDate = events.filter(event => event.action === "修改预计日期").at(-1)?.expected_date ?? material.expectedDate;
        const node = emptyNode("development_material_supply", arrived ? "completed" : currentDocument.status === "published" || (round ?? 1) > 1 ? "pending" : "uncreated", round);
        node.instanceId = `material:${material.materialId}:${round ?? 1}`;
        node.subject = material.label || material.name;
        node.expectedAt = plannedDate;
        node.expectedKind = plannedDate ? "plan" : "unset";
        node.expectedPrecision = plannedDate ? "date" : "missing";
        node.sla = "not_set";
        node.records = [record("development_material", material.materialId, `${developmentUrl(sid, round ?? 1)}#material-${material.materialId}`, currentDocument.version ?? currentDocument.document_version ?? null)];
        if (!arrived && plannedDate && plannedDate < today) node.risks.push("overdue");
        // Event registration time is not the actual arrival time.
        const placeholder = index === 0 ? supplyPlaceholder : -1;
        // A real supply task retains its lifecycle, owner and original handling URL.
        if (placeholder >= 0) baseNodes.splice(placeholder, 1, node); else baseNodes.push(node);
      });
    }
    if(baseNodes.some(node=>node.key==="development_material_recheck"&&node.current&&node.state!=="not_applicable")) {
      const replaced=baseNodes.findIndex(node=>node.key==="development_materials"&&node.instanceId===`development_materials:${round??0}`);
      if(replaced>=0)baseNodes.splice(replaced,1);
    }
    // Future and applicable nodes stay visible; historical instances do not disappear after revision.
    const progress:OrderJourney["progress"]={development:null,bulk:null};
    const devTask=taskDtos.find(task=>task.sourceId===sid&&task.routeVersion===round);
    if(sourceAccess&&document?.status==="published"&&devTask)progress.development={applicable:devTask.routeProgress.applicable,completed:devTask.routeProgress.completed};
    const lines=orderAccess&&oid?(await db.query(`SELECT l.line_id AS id,l.po_number AS po,l.color,l.formal_style_no AS "formalStyleNo",l.temporary_style_no AS "temporaryStyleNo",coalesce(sum(s.quantity),0)::int AS "orderedQuantity"
      FROM digital_production_po_lines l LEFT JOIN digital_production_po_sizes s USING(line_id) WHERE l.production_order_id=$1 GROUP BY l.line_id ORDER BY l.position`,[oid])).rows:[];
    const links:JourneyRecord[]=[];
    const merchandisers:OrderJourney["merchandisers"]=[],orderNumbers:string[]=[];
    if(orderAccess&&order?.primary_merchandiser_id)merchandisers.push({id:order.primary_merchandiser_id,name:(await db.query("SELECT display_name FROM app_users WHERE id=$1",[order.primary_merchandiser_id])).rows[0]?.display_name??null});
    let styleName:string|null=null;
    if(fullOrder&&oid) {
      const children=(await db.query("SELECT module,child_id FROM digital_production_child_links WHERE production_order_id=$1 ORDER BY module,child_id",[oid])).rows;
      const sourcingAllowed=actor.actorRoles.includes("root_superuser")||(actor.authorizationCapabilities??[]).includes("sourcing:view");
      const sourcing=children.find(child=>child.module==="sourcing");
      // The original detail flow hides logically deleted cases, including approval history and URLs.
      const sourcingFields=sourcing&&sourcingAllowed?(await db.query("SELECT source.additional_merchandiser_user_id,source.style_name_snapshot,source.erp_order_no,current.status FROM sourcing_cases source JOIN current_sourcing_cases current USING(sourcing_case_id) WHERE source.sourcing_case_id=$1 AND source.deleted_at IS NULL",[sourcing.child_id])).rows[0]:null;
      const closureAllowed=actor.actorRoles.some(role=>["root_superuser","owner_group","production_management","order_merchandiser","warehouse_receiver", "warehouse_supervisor","quality_control"].includes(role));
      const childLines=(await db.query("SELECT module,child_id,line_id FROM digital_production_child_lines WHERE production_order_id=$1 ORDER BY module,line_id,child_id",[oid])).rows;
      for(const child of children) {
        let url:string|null=null;
        if(child.module==="sourcing"&&sourcingFields&&child.child_id===sourcing?.child_id)url=`/ui/sourcing/orders/${child.child_id}`;
        if(child.module==="cutting"&&(actor.actorRoles.includes("root_superuser")||(actor.authorizationCapabilities??[]).includes("cutting:orders:view")))url=`/ui/cutting/orders/${child.child_id}`;
        if(child.module==="production"&&canReadProductionReporting(actor)) {
          const allowed=(await db.query(`SELECT production.production_order_id FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id) WHERE production.production_order_id=$5 AND ${productionVisibility}`,[...productionVisibilityArgs(actor),child.child_id])).rowCount;
          if(allowed)url=`/ui/production-dashboard/${child.child_id}`;
        }
        if(child.module==="rework"&&closureAllowed)url=`/ui/tasks/${child.child_id}`;
        if(child.module==="receiving"&&closureAllowed)url=`/ui/digital-production?closure=${oid}#receipt-${child.child_id}`;
        // No generic module-home URL is substituted for unsupported exact-record routes.
        if(url) {
          const mapped=childLines.filter(line=>line.module===child.module&&line.child_id===child.child_id);
          if(mapped.length)for(const line of mapped)links.push({...record(child.module,child.child_id,url),lineId:line.line_id});
          else links.push(record(child.module,child.child_id,url));
        }
      }
      const bulk=await new BulkPreparationService(this.database).read(actor,oid,db);
      const gates=await new BulkPreparationService(this.database).gates(db,oid);
      const bulkUrl=`/ui/digital-production?bulk=${oid}`;
      setFact("customer_sample",bulk.customerConfirmed?"completed":"pending",sid?[record("development",sid,developmentUrl(sid,gates.source?bulk.sourceRound??round??1:currentDocument?round??1:undefined),bulk.sourceRound)]:[]);
      setFact("production_instruction",bulk.instructionValid?"completed":"pending",instruction?[record("instruction",oid,`/ui/digital-production?instruction=${oid}&instructionVersion=${instruction.version}`,instruction.version)]:[],iso(instruction?.published_at),instruction?.published_by?{id:instruction.published_by,name:null}:null);
      const gate=setFact("cutting_gate",bulk.reasons.length?"pending":bulk.tasks.some(task=>["bulk_cutting","bulk_cutting_external"].includes(task.taskKind))?"completed":"pending",[record("preparation",oid,bulkUrl,bulk.instructionVersion)]);
      gate.blockers=bulk.reasons.map((label,index)=>({key:`domain_gate_${index}`,label,ownerId:null,record:gate.records[0]!}));
      const cuttingTask=taskDtos.find(task=>["bulk_cutting","bulk_cutting_external"].includes(task.taskKind)&&visibleTasks.find(raw=>raw.task_id===task.taskId)?.route_instance_id===currentPrep);
      if(!cuttingTask) {
        const patternTask=taskDtos.find(task=>task.taskKind==="bulk_pattern"&&visibleTasks.find(raw=>raw.task_id===task.taskId)?.route_instance_id===currentPrep);
        const shrinkTask=taskDtos.find(task=>task.taskKind==="warehouse_preshrink"&&visibleTasks.find(raw=>raw.task_id===task.taskId)?.route_instance_id===currentPrep);
        if(patternTask?.state!=="completed")gate.blockers.push({key:"pattern_ready",label:"纸样/唛架尚未全部完成",ownerId:patternTask?.assigneeId??null,record:patternTask?record("task",patternTask.taskId,taskUrl(patternTask.taskId)):gate.records[0]!});
        if(bulk.preshrink!=="无需预缩"&&shrinkTask?.state!=="completed")gate.blockers.push({key:"preshrink_ready",label:"预缩条件尚未齐备",ownerId:shrinkTask?.assigneeId??null,record:shrinkTask?record("task",shrinkTask.taskId,taskUrl(shrinkTask.taskId)):gate.records[0]!});
      }
      gate.state=!gate.blockers.length&&cuttingTask?"completed":"pending";
      // A released cutting task and original all-line cutting facts are historical
      // convergence evidence. Current write restrictions cannot undo that fact.
      if(cuttingTask&&bulk.cutting.completed) {
        gate.state="completed";
        gate.blockers=[];
      }
      gate.completionResult=gate.state==="completed"?"unknown":null;
      const prepFacts=currentPrep?(await db.query("SELECT kind FROM digital_bulk_preparation_facts WHERE preparation_id=$1",[currentPrep])).rows:[];
      const marker=prepFacts.some(fact=>fact.kind==="唛架完成");setFact("bulk_marker",marker?"completed":currentPrep?"pending":"uncreated",[record("preparation",oid,`/ui/digital-pattern-room?section=bulk&bulkOrder=${oid}`,bulk.instructionVersion)]);
      if(bulk.preshrink==="无需预缩")replace("warehouse_preshrink",emptyNode("warehouse_preshrink","not_applicable"));
      const budgetAllowed=await policy.allowed(actor,"order",oid,"budget");
      if(budgetAllowed) {const budget=(await db.query("SELECT version,status,published_at FROM digital_budget_documents WHERE production_order_id=$1",[oid])).rows[0];setFact("budget",budget?.status==="published"?"completed":budget?"active":"uncreated",budget?[record("budget",oid,`/ui/digital-production?budget=${oid}${budget.status==="published"?`&budgetVersion=${budget.version}`:""}`,budget.version)]:[],iso(budget?.published_at));}
      else replace("budget",emptyNode("budget","unavailable"));
      if(sourcing&&!sourcingAllowed)for(const key of ["sourcing_ie","sourcing_director","sourcing_owner"])replace(key,emptyNode(key,"unavailable"));
      if(sourcing&&sourcingFields) {
        const fields=sourcingFields;styleName=fields.style_name_snapshot??null;if(fields.erp_order_no)orderNumbers.push(fields.erp_order_no);
        if(fields?.additional_merchandiser_user_id)merchandisers.push({id:fields.additional_merchandiser_user_id,name:(await db.query("SELECT display_name FROM app_users WHERE id=$1",[fields.additional_merchandiser_user_id])).rows[0]?.display_name??null});
        setFact("sourcing_preparation","completed",[record("sourcing",sourcing.child_id,`/ui/sourcing/orders/${sourcing.child_id}`)]);
        const target=record("sourcing",sourcing.child_id,`/ui/sourcing/orders/${sourcing.child_id}`,gates.approval?.decision_version??null);
        const decision=gates.approval?.sourcing_decision_id;
        const ie=(await db.query(`SELECT q.sourcing_ie_quote_id,q.quote_version,q.quoted_by,q.quoted_at FROM sourcing_ie_quotes q
          WHERE q.sourcing_case_id=$1 AND ($2::uuid IS NULL OR q.sourcing_ie_quote_id=(SELECT source_ie_quote_id FROM sourcing_decisions WHERE sourcing_decision_id=$2)) ORDER BY quote_version DESC LIMIT 1`,[sourcing.child_id,decision??null])).rows[0];
        setFact("sourcing_ie",ie?"completed":"pending",[{...target,version:ie?.quote_version??null,url:ie?`${target.url}?view=node-history&node=ie_quote&entryId=${ie.sourcing_ie_quote_id}`:target.url}],iso(ie?.quoted_at),ie?{id:ie.quoted_by,name:null}:null);
        const management=(await db.query("SELECT sourcing_decision_id,decision_version,decided_at,decided_by FROM sourcing_decisions WHERE sourcing_case_id=$1 AND ($2::uuid IS NULL OR sourcing_decision_id=$2) ORDER BY decision_version DESC LIMIT 1",[sourcing.child_id,decision??null])).rows[0];
        const managementCompleted=Boolean(management&&fields.status!=="pending_management_decision");
        setFact("sourcing_director",managementCompleted?"completed":"pending",[{...target,version:management?.decision_version??null,url:management?`${target.url}?view=node-history&node=management&entryId=${management.sourcing_decision_id}`:target.url}],managementCompleted?iso(management?.decided_at):null,managementCompleted?{id:management!.decided_by,name:null}:null);
        const ownerDecision=management?(await db.query("SELECT sourcing_owner_decision_id,decision,decision_reason,decided_at,decided_by FROM sourcing_owner_decisions WHERE sourcing_decision_id=$1",[management.sourcing_decision_id])).rows[0]:null;
        const ownerRecord={...target,version:management?.decision_version??null,url:ownerDecision?`${target.url}?view=node-history&node=owner&entryId=${ownerDecision.sourcing_owner_decision_id}`:target.url};
        const ownerNode=setFact("sourcing_owner",bulk.ownerApproved?"completed":ownerDecision?.decision==="rejected"?"blocked":"pending",[ownerRecord],bulk.ownerApproved?iso(ownerDecision?.decided_at):null,ownerDecision?{id:ownerDecision.decided_by,name:null}:null);
        if(ownerDecision?.decision==="rejected") {
          ownerNode.operator=ownerNode.owner;ownerNode.risks.push("blocked");
          ownerNode.blockers.push({key:"original_owner_rejected",label:ownerDecision.decision_reason,ownerId:null,record:ownerRecord});
        }
      }
      const closure=await new OrderClosureService(this.database).read(actor,oid,db);
      const closureRecord=record("closure",oid,`/ui/digital-production?closure=${oid}`);
      const received=closure.lines.length>0&&closure.lines.every(line=>line.receiptCount>0&&line.actualQuantity>=line.orderedQuantity&&(line.actualQuantity===line.documentQuantity||Boolean(line.receivingResolution)));
      setFact("receipts",received?"completed":closure.lines.some(line=>line.receiptCount>0)?"active":"uncreated",[closureRecord]);
      setFact("packing",closure.stage==="本期装箱完成"?"completed":closure.lines.some(line=>line.packingRevisionId)?"active":"uncreated",[closureRecord]);
      setFact("quantity_difference",closure.lines.some(line=>line.receiptCount>0&&line.actualQuantity!==line.documentQuantity&&!line.receivingResolution||line.packingQuantity!==null&&line.packingQuantity!==line.actualQuantity&&!line.packingResolution)?"pending":"not_applicable",[closureRecord]);
      if(closure.closed) {
        const original=(await db.query<{closed_by:string}>("SELECT closed_by FROM digital_order_closures WHERE production_order_id=$1",[oid])).rows[0]!;
        setFact("special_closure","completed",[closureRecord],closure.closed.closedAt,{id:original.closed_by,name:closure.closed.closedBy});
      }
      else replace("special_closure",emptyNode("special_closure","not_applicable"));
      for(const line of closure.lines)for(const rework of line.reworks){const node=emptyNode("rework",rework.status==="completed"?"completed":rework.status==="cancelled"?"cancelled":"active");node.instanceId=rework.reworkId;node.records=[{...record("rework",rework.reworkId,closure.canOpenRework?`/ui/tasks/${rework.reworkId}`:null),lineId:line.lineId}];baseNodes.push(node);}
      if(currentPrep&&gates.instruction&&gates.source)progress.bulk=bulkCockpitProgress({preshrink:bulk.preshrink??"",secondaryCraft:gates.instruction.document.secondaryCraft==="沿用开发"?gates.source.document.craft:gates.instruction.document.secondaryCraft,externalCutting:gates.approval?.cutting_process==="outsourced",tasks:taskDtos.filter(task=>visibleTasks.find(raw=>raw.task_id===task.taskId)?.route_instance_id===currentPrep),received,packed:closure.stage==="本期装箱完成",specialClosed:Boolean(closure.closed)});
      for(const key of ["receiving_inspection","rework_review","responsibility"]) {const node=emptyNode(key,"unavailable");node.unavailableReason="fact_not_recorded";replace(key,node);}
      if(closure.canOpenRework)for(const line of closure.lines)for(const rework of line.reworks) {
        const url=`/ui/tasks/${rework.reworkId}`;
        const append=(key:string,state:JourneyState,id:string,actualAt:string|null,ownerId:string|null,recordUrl:string|null)=>{
          const node=emptyNode(key,state);node.instanceId=id;node.actualAt=actualAt;node.actualQuality=actualAt?"verified":"missing";
          node.owner=ownerId?{id:ownerId,name:null}:null;node.operator=state==="completed"&&actualAt?node.owner:null;node.records=[{...record("rework",rework.reworkId,recordUrl),lineId:line.lineId}];
          const placeholder=baseNodes.find(value=>value.key===key&&value.instanceId===`${key}:0`);
          if(placeholder)replace(key,node);else baseNodes.push(node);
        };
        const report=(await db.query("SELECT tail_inspection_report_id,submitted_by,submitted_at,operation_event_id FROM rework_tail_inspection_reports WHERE rework_order_id=$1 AND status='submitted' ORDER BY submitted_at DESC,tail_inspection_report_id DESC LIMIT 1",[rework.reworkId])).rows[0];
        if(report)append("receiving_inspection","completed",report.tail_inspection_report_id,iso(report.submitted_at),report.submitted_by,await journeyReworkHistoryUrl(db,actor,rework.reworkId,"work_reporting",report.tail_inspection_report_id,report.operation_event_id));
        const reviewed=(await db.query("SELECT order_review_id,reviewed_by,reviewed_at FROM rework_order_reviews WHERE rework_order_id=$1",[rework.reworkId])).rows[0];
        if(reviewed)append("rework_review","completed",reviewed.order_review_id,iso(reviewed.reviewed_at),reviewed.reviewed_by,await journeyReworkHistoryUrl(db,actor,rework.reworkId,["whole_order_review","final_quantity_ie_review"],reviewed.order_review_id));
        else if(rework.status==='pending_order_review')append("rework_review","pending",`review:${rework.reworkId}`,null,null,`${url}?node=whole_order_review`);
        const determination=(await db.query("SELECT determination_id,stage,handler_user_id,operation_event_id FROM rework_responsibility_determinations WHERE rework_order_id=$1 ORDER BY determination_version DESC LIMIT 1",[rework.reworkId])).rows[0];
        // A finalized determination does not finish its responsibility handling or settle wages.
        if(determination)append("responsibility",rework.status==='completed'?"completed":rework.status==='cancelled'?"cancelled":"active",determination.determination_id,null,determination.handler_user_id,await journeyReworkHistoryUrl(db,actor,rework.reworkId,"responsibility",determination.determination_id,determination.operation_event_id));
      }
      const factoryFacts=currentPrep?(await db.query("SELECT * FROM digital_factory_facts WHERE preparation_id=$1 ORDER BY sequence",[currentPrep])).rows:[];
      const arrival=factoryFacts.find(fact=>fact.kind==="工厂到料");
      setFact("factory_arrival",arrival?"completed":factoryFacts.some(fact=>fact.kind==="仓库实际发厂")?"pending":"uncreated",[record("factory",oid,`/ui/digital-production?factory=${oid}`,bulk.instructionVersion)],iso(arrival?.occurred_at),arrival?{id:arrival.actor_id,name:null}:null);
      if(gates.instruction&&gates.source) {
        const craft=gates.instruction.document.secondaryCraft==="沿用开发"?gates.source.document.craft:gates.instruction.document.secondaryCraft;
        if(craft==="无")for(const key of ["process_logistics","bulk_qc"])replace(key,emptyNode(key,"not_applicable"));
      }
      const native=children.find(child=>child.module==="production");
      if(native&&links.some(link=>link.domain==="production"&&link.id===native.child_id)) {
        const transition=(await db.query("SELECT sourcing_factory_order_status($1) AS status,business_date::text,actor_id FROM sourcing_production_transitions WHERE production_order_id=$1 ORDER BY created_at DESC,production_transition_id DESC LIMIT 1",[native.child_id])).rows[0];
        // A business date has day precision only, so it is not invented as an exact completion timestamp.
        const value=setFact("production_reporting",transition?.status==="production_completed"||transition?.status==="shipped"?"completed":"active",[record("production",native.child_id,`/ui/production-dashboard/${native.child_id}`)]);
        if(value.state==="completed")value.risks.push("unknown");
      } else if(native) replace("production_reporting",emptyNode("production_reporting","unavailable"));
    }
    const linkedNode:Record<string,string>={cutting:"bulk_cutting",receiving:"receipts",rework:"rework",sourcing:"sourcing_preparation"};
    for(const link of links) {
      const node=baseNodes.find(node=>node.current&&node.key===linkedNode[link.domain]);
      if(node&&node.state!=="unavailable"&&!node.records.some(record=>record.domain===link.domain&&record.id===link.id&&record.lineId===link.lineId))node.records.push(link);
    }
    // Resolve only people already referenced by authorized facts, never a staff directory.
    const personIds = [...new Set(baseNodes.flatMap(node => [node.owner?.id, node.operator?.id,
      ...node.assignmentHistory.flatMap(item => [item.actorId, item.from, item.to])]).filter((id): id is string => Boolean(id)))];
    const names = new Map<string, string>((personIds.length ? (await db.query(
      "SELECT id,display_name FROM app_users WHERE id=ANY($1::uuid[])", [personIds])).rows : []).map(person => [person.id, person.display_name]));
    for (const node of baseNodes) {
      for (const person of [node.owner, node.operator]) if (person && !person.name) person.name = names.get(person.id) ?? null;
      for (const item of node.assignmentHistory) {
        item.actorName = names.get(item.actorId) ?? null;
        item.fromName = item.from ? names.get(item.from) ?? null : null;
        item.toName = item.to ? names.get(item.to) ?? null : null;
      }
    }
    // Mutated nodes remain in the shared base list; all seven stages are always returned.
    const poDeliveryDates=orderAccess&&oid?await readOrderPoDeliveryDates(db,oid,lines.map(line=>line.id)):[];
    const finalClosed=baseNodes.some(node=>node.current&&['packing','special_closure'].includes(node.key)&&node.state==='completed');
    const terminal=orderAccess&&oid&&(await db.query("SELECT 1 WHERE EXISTS(SELECT 1 FROM digital_order_closures WHERE production_order_id=$1) OR EXISTS(SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1 AND state='cancelled')",[oid])).rowCount;
    const promiseDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
    // A hidden reporting node cannot stand in for the whole order's authoritative completion.
    // Read only this boolean for an already authorized mother; retain all reporting visibility gates.
    const factoryFinished=Boolean(orderAccess&&oid&&(await db.query(`SELECT coalesce(bool_and(sourcing_factory_order_status(p.production_order_id) IN ('production_completed','shipped')),false) AS finished
      FROM digital_production_child_links l JOIN sourcing_production_orders p ON p.production_order_id=l.child_id
      WHERE l.production_order_id=$1 AND l.module='production'`,[oid])).rows[0]?.finished);
    const deliveryRisks=poDeliveryRisks(poDeliveryDates,promiseDay,{finished:finalClosed||Boolean(terminal),factoryFinished,sampleFinished:baseNodes.some(node=>node.current&&node.key==='bulk_ship_sample'&&node.state==='completed')});
    const sourceImage=sourceAccess?currentDocument?.document?.files?.find((file:{kind:string})=>file.kind==='款图'):null;
    const instructionImages=!sourceImage&&orderAccess?(await db.query(`SELECT v.document->'images' AS images FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[oid])).rows[0]?.images:null;
    const instructionImage=instructionImages?.find((file:{kind:string})=>file.kind==='款图');
    const styleImageUrl=sourceImage&&sid?`/api/digital-production/sources/${sid}/development/attachments/${sourceImage.attachmentId}`:instructionImage&&oid?`/api/digital-production/orders/${oid}/instruction/attachments/${instructionImage.attachmentId}`:null;
    return {asOf,styleImageUrl,developmentType:sourceAccess?source?.development_type??null:null,requiredCompletionDate:sourceAccess?currentDocument?.document?.returnDate??null:null,id:canonicalId,sourceId:sid,orderId:orderAccess?oid:null,designStyleNo:chosenIdentity.design_style_no,temporaryStyleNo:chosenIdentity.temporary_style_no,customer:chosenIdentity.customer_code,category:currentDocument?.document.template??(orderAccess?order?.product_group:null)??null,styleName,designer,merchandisers,orderNumbers,createdAt:iso(sourceAccess?source!.created_at:orderAccess?order!.created_at:(source?.created_at??order!.created_at))!,deliveryDate:orderAccess?digitalDateText(order?.contract_delivery_date??null):null,poDeliveryDates,deliveryRisks,selectedRound:round,adoptedRound:instruction?.source_round??null,sourceVersion:currentDocument?.version??currentDocument?.document_version??null,instructionVersion:instruction?.version??null,lines,links,stages:journeyStages(baseNodes),progress,hitReasons:[]};
  }
}
