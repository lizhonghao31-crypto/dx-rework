import {journeyMeasure,journeySpan,journeyCandidateCount} from '../platform/journey-diagnostic.js';
import {readQcExecutionEvidence} from './qc-progress-evidence.js';
import {readNodeMaterials} from './node-materials.js';
import {styleLabelCuttingReason,preparationTestReasons} from './production-readiness-repository.js';
import {seriesPlanJourney} from './series-plan-journey.js';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {readJourneySupervision} from "./journey-supervision.js";
import {assertBusinessClockUnchanged,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {factoryProductionFacts,factoryProductionCompletion} from './factory-production-facts.js';
import {shipSampleFacts} from './ship-sample-facts.js';
import {developmentReadTables} from "./development-amendment-repository.js";
import {digitalConditionGuidance} from "@dx-rework/contracts/digital-production-tasks";
import {businessRoleLabel} from "@dx-rework/contracts/business-display";
import {PATTERN_GROUPS} from "@dx-rework/contracts/digital-development-workspace";
import {materialReadiness} from "./development-material-readiness.js";
import {reuseJourneySnapshotReads,prepareJourneySnapshotBatches} from "./journey-snapshot-reads.js";
import {journeyTaskSummaries} from './journey-task-summary.js';
import type { Pool, PoolClient } from "pg";
import type { JourneyFilter, JourneyNode, JourneyRecord, JourneyState, OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalManagementReader, isDigitalTechnicalManager } from "./access-policy.js";
import { isRootActor } from "../access/business-authority.js";
import { assertIdentityActor, digitalDateText } from "./identity-service.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import { OrderClosureService } from "./order-closure-service.js";
import {savedDevelopmentRoute} from "./development-sla-enrollment.js";
import { bulkCockpitProgress } from "./cockpit-progress.js";
import { JOURNEY_NODES, journeyDefinition } from "./journey-catalog.js";
import { appendJourneyInstance, journeyCompletion, journeyStages, selectJourneys } from "./journey-projection.js";
import { canReadProductionReporting, productionVisibilityFor, productionVisibilityArgs } from "../sourcing/production-reporting-service.js";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { journeyReworkHistoryUrl } from "./journey-rework-record.js";
import { readOrderPoDeliveryDates } from "./po-delivery-query.js";
import { poDeliveryRisks } from "@dx-rework/contracts";
import { assertBusinessExportAllowed } from "../access/export-authority.js";
import {journeyDisplay} from "./journey-display.js";
import {readJourneyLog} from "./journey-log.js";
import {readJourneyRiskHistory} from "./journey-risk-history.js";
import type {JourneyAuthorizedTask} from "./journey-read-scope.js";
import {journeyBusinessProgress,journeyBusinessQuantities,type RequirementEvidence} from './journey-business-progress.js';
import {readJourneyAdoptedPlan} from './journey-adopted-plan.js';
import {readMaterialSuccessors} from './journey-material-successors.js';
import {factorySlaEvidence} from './factory-sla-evidence.js';
import {attachJourneyFactoryDeadlines} from './journey-factory-deadlines.js';
import {journeyBusinessDates} from './journey-progress-dates.js';
import {journeyVisualProgress} from './journey-visual-progress.js';
import {journeyNodeFactTarget,mergeJourneyNodeFact} from './journey-node-fact.js';
import {minimalJourneyFacts,type JourneyFactModel} from './journey-fact-model.js';
import type {JourneyTimingInputs} from './journey-supervision.js';

const iso = (value: Date|string|null|undefined) => value == null ? null : new Date(value).toISOString();
type Candidate = { source: {development_type:string;source_id:string;created_by:string;design_style_no:string;temporary_style_no:string|null;customer_code:string|null;created_at:string}|null;
  order: {production_order_id:string;source_id:string|null;created_by:string;primary_merchandiser_id:string|null;design_style_no:string;temporary_style_no:string|null;customer_code:string;product_group:string;contract_delivery_date:string|null;created_at:string}|null };
const record = (domain:string,id:string,url:string|null,version:number|null=null):JourneyRecord => ({domain,id,url,version,lineId:null,mode:"read"});
const taskUrl = (id:string) => `/ui/digital-production?task=${encodeURIComponent(id)}`;
const developmentUrl = (id:string,round?:number) => `/ui/digital-production?development=${id}${round === undefined ? "" : `&round=${round}`}`;
const emptyNode = (key:string,state:JourneyState,round:number|null=null):JourneyNode => {
  const definition=journeyDefinition(key)!;
  return {key,instanceId:`${key}:${round??0}`,label:definition.label,stage:definition.stage,state,round,occurrence:null,current:true,ownerStatus:state==="unavailable"?"unavailable":"unknown",unavailableReason:state==="unavailable"?"permission":null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedPrecision:state==="unavailable"?"unavailable":"missing",expectedKind:state==="unavailable"?"unavailable":"unset",actualAt:null,actualQuality:state==="unavailable"?"unavailable":"missing",enteredAt:null,sla:state==="unavailable"?"unavailable":state==="not_applicable"?"not_set":"not_started",completionResult:state==="completed"?"unknown":null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:definition.count&&!["not_applicable","unavailable","inherited"].includes(state)};
};

/** Additive query API. No writes, new lifecycle, quantities or wage materialization. */
export class DigitalJourneyQuery {
  private readonly observations=new WeakMap<PoolClient,Map<string,{scope:BusinessTimeScope;time:BusinessTime}>>();
  private readonly authorizedTasks=new WeakMap<OrderJourney,readonly JourneyAuthorizedTask[]>();
  constructor(private readonly database:Pool) {}
  private async snapshot<T>(work:(db:PoolClient,asOf:string)=>Promise<T>) {
    const db=await this.database.connect(),reads=reuseJourneySnapshotReads(db),observations=new Map<string,{scope:BusinessTimeScope;time:BusinessTime}>();
    this.observations.set(reads,observations);let result:T;
    try { await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const asOf=iso((await db.query("SELECT CURRENT_TIMESTAMP AS as_of")).rows[0].as_of)!;
      result=await work(reads,asOf);await db.query("COMMIT");
    } catch(error) { await db.query("ROLLBACK");throw error; } finally {this.observations.delete(reads);db.release();}
    for(const {scope,time} of observations.values())await journeyMeasure('clock_postcheck',()=>assertBusinessClockUnchanged(new ContextBusinessClock(this.database),scope,time));
    return result;
  }
  private async candidates(db:PoolClient,actor:TrustedActorContext,id:string|null=null,patternKinds:string[]|null=null):Promise<Candidate[]> {
    const leader=isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor);
    // Only current live roles and legitimate task assignments add scope. No style-string join.
    return (await db.query(`WITH live_roles AS (
      SELECT a.role_code FROM user_role_assignments a JOIN app_users u ON u.id=a.user_id
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE a.user_id=$1 AND a.revoked_at IS NULL AND u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
      AND a.role_code=ANY($2::text[]) AND EXISTS(SELECT 1 FROM identity_mappings m WHERE m.user_id=u.id AND m.active AND m.employed)
    ) SELECT row_to_json(s) AS source,row_to_json(o) AS "order"
    FROM digital_production_sources s FULL JOIN digital_production_orders o ON o.source_id=s.source_id
    WHERE ($4::uuid IS NULL OR s.source_id=$4 OR o.production_order_id=$4)
      AND ($5::text[] IS NULL OR EXISTS(SELECT 1 FROM digital_production_task_access board_task WHERE (board_task.source_id=s.source_id OR board_task.production_order_id=o.production_order_id) AND board_task.task_kind=ANY($5::text[]))) AND ($3
      OR ('sample_designer' IN (SELECT role_code FROM live_roles) AND $1 IN (s.created_by,o.created_by))
      OR ('order_merchandiser' IN (SELECT role_code FROM live_roles) AND o.primary_merchandiser_id=$1)
      OR ('development_clerk' IN (SELECT role_code FROM live_roles) AND (o.source_id IS NOT NULL OR EXISTS(SELECT 1 FROM digital_production_task_access a WHERE a.source_id=s.source_id AND a.task_kind LIKE 'development_%')))
      OR EXISTS(SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
        WHERE (a.source_id=s.source_id OR a.production_order_id=o.production_order_id) AND a.assignee_id=$1 AND (a.required_role IN (SELECT role_code FROM live_roles) OR a.required_role='warehouse_receiver' AND 'warehouse_supervisor' IN (SELECT role_code FROM live_roles)))
)
    ORDER BY coalesce(s.created_at,o.created_at) DESC,coalesce(s.source_id,o.production_order_id) DESC`,[actor.actorId,actor.actorRoles,leader,id,patternKinds])).rows;
  }
  async list(actor:TrustedActorContext,filter:JourneyFilter,exportAll=false,selectPage?: (items:OrderJourney[])=>OrderJourney[],options:{details?:boolean;patternBusiness?:"development"|"bulk"|"all"}={}) {
    assertIdentityActor(actor);
    return this.snapshot(async(db,asOf)=>{
      // Internal workspace selection runs after all authorized facts, before detail hydration.
      const summaryOnly=options.details===false||!exportAll||Boolean(selectPage);
      const items:OrderJourney[]=[],candidates=new Map<string,Candidate>();
      const patternKinds=options.patternBusiness?PATTERN_GROUPS.flatMap(group=>[...group.nodes]).filter(kind=>options.patternBusiness==="all"||(options.patternBusiness==="bulk"?kind==="bulk_pattern":kind!=="bulk_pattern")):null;
      const rows=await journeyMeasure('candidates',()=>this.candidates(db,actor,null,patternKinds));journeyCandidateCount(rows.length);
      // The original management policy grants the full read range for these exact candidates.
      // Assigned/technical partial readers retain their original per-object path.
      if(isDigitalManagementReader(actor))prepareJourneySnapshotBatches(db,rows.flatMap(row=>row.order?[row.order.production_order_id]:[]));
      for(const row of rows) { const item=await journeyMeasure('summary_projection',()=>this.project(db,actor,row,asOf,undefined,summaryOnly,patternKinds,false,Boolean(filter.scope)));if(item){items.push(item);candidates.set(item.id,row);} }
      const endFilter=journeySpan('filter_page');
      const facets = {
        customers: [...new Set(items.map(item=>item.customer).filter((value):value is string=>Boolean(value)))].sort(),
        categories: [...new Set(items.map(item=>item.category).filter((value):value is string=>Boolean(value)))].sort(),
        merchandisers: [...new Map(items.flatMap(item=>item.merchandisers).map(person=>[person.id,person])).values()],
      };
      const result=selectJourneys(items,filter,asOf,!exportAll);
      endFilter();
      if(summaryOnly&&options.details!==false&&!filter.scope){
        const details:OrderJourney[]=[];
        for(const summary of selectPage?selectPage(result.items):result.items){const detail=await journeyMeasure('detail_projection',()=>this.project(db,actor,candidates.get(summary.id)!,asOf));if(detail)details.push({...detail,hitReasons:summary.hitReasons});}
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
  async nodeMaterials(actor:TrustedActorContext,id:string,instanceId:string,round?:number) {
    assertIdentityActor(actor);
    return this.snapshot(async(db,asOf)=>{
      const row=(await this.candidates(db,actor,id))[0]??digitalNotFound();
      const item=await this.project(db,actor,row,asOf,round,false,null,true,true);if(!item)return digitalNotFound();
      const node=item.stages.flatMap(stage=>stage.nodes).find(n=>n.instanceId===instanceId);
      if(!node||node.state==='unavailable')return digitalNotFound();
      return readNodeMaterials(this.database,db,actor,item,node,asOf);
    });
  }
  async read(actor:TrustedActorContext,id:string,round?:number,compact=false) {
    assertIdentityActor(actor);
    return this.snapshot(async(db,asOf)=>{
      const row=(await this.candidates(db,actor,id))[0]??digitalNotFound();
      const item=await this.project(db,actor,row,asOf,round,false,null,compact,compact);if(!item)return digitalNotFound();
      const current=round===undefined?item:await this.project(db,actor,row,asOf,undefined,true,null,false,compact);
      if(current){
        if(current.businessProgress)item.businessProgress=current.businessProgress;
        if(current.visualProgress)item.visualProgress=current.visualProgress;
        if(current.identity)item.identity=current.identity;
        if(current.display)item.display=current.display;
        if(current.supervision)item.supervision=current.supervision;
        if(compact)item.flowStages=current.stages.map(stage=>({...stage,nodes:stage.nodes.filter(node=>node.current)}));
        item.currentRiskNodes=current.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&!["completed","cancelled","inherited","not_applicable"].includes(node.state)&&(node.risks.length>0||node.state==="blocked"));
        item.currentDeliveryRisks=current.deliveryRisks??[];
        const authorized=this.authorizedTasks.get(current)??[];
        item.riskHistory=await readJourneyRiskHistory(db,authorized);
        item.operationLog=await readJourneyLog(db,current,asOf,actor.actorId,authorized,undefined,5);
      }
      return item;
    });
  }
  async logs(actor:TrustedActorContext,id:string,cursor?:string) {
    assertIdentityActor(actor);
    return this.snapshot(async(db,asOf)=>{
      const row=(await this.candidates(db,actor,id))[0]??digitalNotFound();
      const current=await this.project(db,actor,row,asOf,undefined,true);
      if(!current)return digitalNotFound();
      return readJourneyLog(db,current,asOf,actor.actorId,this.authorizedTasks.get(current)??[],cursor,20);
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
  /** Internal single-object builder; not registered as a route or a user read.
   * No synthetic actor, Root authority, cached visibility or executable DTO.
   * Caller owns one consistent snapshot and persists only the whitelist below.
   */
  async buildFactsWithClient(db:PoolClient,resource:{kind:'source'|'order';id:string},asOf:string):Promise<JourneyFactModel>{
    const row=(await db.query(`SELECT row_to_json(s) AS source,row_to_json(o) AS "order"
      FROM digital_production_sources s FULL JOIN digital_production_orders o ON o.source_id=s.source_id
      WHERE ($1='order' AND o.production_order_id=$2) OR ($1='source' AND s.source_id=$2 AND o.production_order_id IS NULL)`,[resource.kind,resource.id])).rows[0] as Candidate|undefined;
    if(!row)return digitalNotFound();
    let timing:JourneyTimingInputs={plan:null,original:null,facts:{}};
    let nativeTasks:Array<{id:string;routeInstanceId:string}>=[];
    const item=await this.project(db,null,row,asOf,undefined,true,null,false,true,value=>{timing=value;},tasks=>{nativeTasks=tasks;});
    if(!item)throw new Error('Single-object Journey facts unavailable');
    // Native task identity is collected before setFact() substitutes original
    // business-document links. Presentation records are not a task inventory.
    const ids=nativeTasks.map(task=>task.id);
    const time=await new ContextBusinessClock(this.database,db).read(resource,()=>new Date(asOf));
    const summaries=await journeyTaskSummaries(db,ids,time);
    const dependencies=ids.length?(await db.query<{taskId:string;predecessorId:string}>('SELECT task_id AS "taskId",predecessor_id AS "predecessorId" FROM digital_production_task_dependencies WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,predecessor_id',[ids])).rows:[];
    const tasks=[...summaries.values()].map(task=>({id:task.taskId,kind:task.taskKind,sourceId:task.sourceId,orderId:task.orderId,assigneeId:task.assigneeId,requiredRole:task.requiredRole,
      routeInstanceId:nativeTasks.find(row=>row.id===task.taskId)!.routeInstanceId,routeVersion:task.routeVersion,policyVersion:task.policyVersion,
      enteredAt:task.enteredAt,dueAt:task.dueAt,warningAt:task.warningAt,deadlineMode:task.deadlineMode??null,deadlineExclusive:task.deadlineExclusive===true}));
    return minimalJourneyFacts(item,timing,tasks,dependencies);
  }
  private async project(db:PoolClient,actor:TrustedActorContext|null,row:Candidate,asOf:string,selectedRound?:number,summaryOnly=false,patternKinds:string[]|null=null,compact=false,supervision=false,capture?:(inputs:JourneyTimingInputs)=>void,captureNativeTasks?:(tasks:Array<{id:string;routeInstanceId:string}>)=>void):Promise<OrderJourney|null> {
    const policy=new DigitalProductionAccessPolicy(db),source=row.source,order=row.order;
    const sid=source?.source_id??null,oid=order?.production_order_id??null;
    // Projection time is business time; the outer audit-log snapshot remains real.
    const scope:BusinessTimeScope=oid?{kind:'order',id:oid}:{kind:'source',id:sid!};
    // Use SQL snapshot time only as the ordinary fallback. Guarded context and
    // actual reader results (including null scenario IDs) retain precedence.
    const observed=await journeyMeasure('clock_read',()=>new ContextBusinessClock(this.database,db).read(scope,()=>new Date(asOf)));
    if(observed.scenarioId)this.observations.get(db)?.set(`${scope.kind}:${scope.id}`,{scope,time:observed});
    asOf=observed.now;
    const attached=Boolean(sid&&oid&&(await db.query("SELECT 1 FROM audit_events WHERE entity_type='digital_production' AND entity_id=$1 AND action='digital_source_attached' AND after_state->>'sourceId'=$2 LIMIT 1",[oid,sid])).rowCount);
    const canonicalId=attached?oid!:(sid??oid!);
    const sourceAccess=Boolean(sid&&(!actor||await policy.allowed(actor,"source",sid,"technical")));
    const orderAccess=Boolean(oid&&(!actor||await policy.allowed(actor,"order",oid,"technical")));
    // Order access through one assigned technical task must not expose its sibling task metadata.
    const fullOrder=orderAccess&&(!actor||isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor)
      || actor.actorRoles.includes("sample_designer")&&order?.created_by===actor.actorId
      || actor.actorRoles.includes("order_merchandiser")&&order?.primary_merchandiser_id===actor.actorId
      || actor.actorRoles.includes("development_clerk"));
    const tasks=(await db.query(`SELECT a.task_id,a.task_kind,a.source_id,a.production_order_id,a.assignee_id,a.required_role,t.route_version,t.occurrence,t.completed_quality,t.route_instance_id,t.state AS original_state,
      EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned
      FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
      WHERE a.task_kind<>'factory_material_count' AND (a.source_id=$1 OR a.production_order_id=$2) ORDER BY t.route_version,t.created_at,t.task_id`,[sid,oid])).rows;
    const visibleTasks: typeof tasks=[];
    for(const task of tasks) {
      if(patternKinds&&!patternKinds.includes(task.task_kind))continue;
      const direct=Boolean(actor&&task.assignee_id===actor.actorId&&await policy.activeRole(actor.actorId,task.required_role));
      if((task.source_id?sourceAccess:fullOrder)||direct)visibleTasks.push(task);
    }
    if(!sourceAccess&&!orderAccess&&!visibleTasks.length)return null;
    if(selectedRound!==undefined&&!sourceAccess)digitalNotFound();
    captureNativeTasks?.(visibleTasks.map(task=>({id:task.task_id,routeInstanceId:task.route_instance_id})));
    const documentTables=sid&&sourceAccess?await developmentReadTables(db):null;
    const document=sid&&sourceAccess?(await db.query(`SELECT * FROM ${documentTables!.documents} WHERE source_id=$1`,[sid])).rows[0]:null;
    const revisions=sid&&sourceAccess?(await db.query(`SELECT * FROM ${documentTables!.rounds} WHERE source_id=$1 ORDER BY round_number`,[sid])).rows:[];
    const latestRound=revisions.at(-1)?.round_number??(document?1:null);
    const effectiveRound=sid?(await db.query("SELECT coalesce(max(round_number),1)::int AS round FROM digital_development_rounds WHERE source_id=$1",[sid])).rows[0].round:null;
    const round=selectedRound??latestRound??effectiveRound;
    if(selectedRound!==undefined&&selectedRound!==1&&!revisions.some(revision=>revision.round_number===selectedRound))digitalNotFound();
    const currentDocument=round&&round>1?revisions.find(revision=>revision.round_number===round):document;
    const declared=currentDocument?.document?round===1?["development_materials",...await savedDevelopmentRoute(db,sid!,currentDocument.document as DevelopmentDocument)]:currentDocument.route_nodes as string[]:null;
    const inherited=currentDocument?.inherited??{};
    const currentPrep=oid?(await db.query(`SELECT p.preparation_id FROM digital_bulk_preparations p
      JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
      WHERE p.production_order_id=$1 AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
      ORDER BY p.created_at DESC LIMIT 1`,[oid])).rows[0]?.preparation_id:null;
    const instruction=oid&&fullOrder?(await db.query(`SELECT v.version,v.source_round,v.published_at,v.published_by FROM digital_instruction_documents d
      JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[oid])).rows[0]:null;
    const policies=(await db.query("SELECT DISTINCT ON(node_key) node_key,sla_seconds FROM digital_production_deadline_policies ORDER BY node_key,version DESC")).rows;
    const baseNodes=JOURNEY_NODES.filter(d=>!d.key.startsWith("series_")).map(definition=>{
      const allowed=definition.stage==="creation"?sourceAccess||fullOrder:definition.stage==="development"?sourceAccess||fullOrder&&!sid:fullOrder;
      let state:JourneyState=allowed?"uncreated":"unavailable";
      if(!oid&&!["creation","development"].includes(definition.stage))state="not_applicable";
      if(definition.stage==="development"&&declared&&!declared.includes(definition.key)&&!inherited[definition.key])state="not_applicable";
      const node=emptyNode(definition.key,state,definition.stage==="development"?round:null);
      if(state!=="unavailable")node.sla=policies.find(policy=>policy.node_key===definition.key)?.sla_seconds==null?"not_set":"not_started";
      return node;
    });
    const replace=(key:string,node:JourneyNode)=>{const index=baseNodes.findIndex(value=>value.key===key);if(index>=0)baseNodes[index]=node;else baseNodes.push(node);};
    const setFact=(key:string,state:JourneyState,records:JourneyRecord[]=[],actualAt?:string|null,owner?:JourneyNode["owner"])=>{
      const current=baseNodes.filter(node=>node.key===key&&node.current);
      // A kind-level fact cannot choose one of several real PO/round instances.
      // Keep those instances; only an unambiguous current instance or its own
      // catalogue slot may receive this observation.
      const factRound=journeyDefinition(key)?.stage==='development'?round:null;
      const previous=journeyNodeFactTarget(baseNodes,key,factRound);
      const basis=previous??emptyNode(key,state,factRound);
      const node=mergeJourneyNodeFact(basis,{key,instanceId:basis.instanceId,round:basis.round,current:true,state,
        // Presentation records keep their original native entry. The separate
        // authorized-task set already retains task history and log access.
        records,actualAt,
        countsInProgress:journeyDefinition(key)!.count&&!['not_applicable','unavailable','inherited'].includes(state),
        sla:state==='not_applicable'?'not_set':basis.sla==='not_set'||basis.sla==='unavailable'?basis.sla:state==='completed'?'finished':basis.enteredAt?'running':'not_started',
        ...(actualAt!==undefined?{actualQuality:actualAt?'verified':'missing'}:{}),
        ...(owner!==undefined?{owner,ownerStatus:owner?'assigned':'unassigned',...(state==='completed'?{operator:owner}:{})}:{}),
      })!;
      if(state==='completed'&&actualAt!==undefined){const completion=journeyCompletion(node.expectedAt,node.actualAt,node.actualQuality==='verified');node.completionResult=completion.result;node.overdueSeconds=completion.overdueSeconds;}
      const index=previous?baseNodes.indexOf(previous):-1;
      if(index>=0)baseNodes[index]=node;else if(current.length<=1)baseNodes.push(node);
      return node;
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
        value.progressApplicability=visibleTasks.some(task=>task.task_id===reference.taskId&&task.source_id===sid&&task.route_version===reference.roundNumber&&task.original_state==="completed"&&!task.returned)?"applicable":"unknown";
        // Source-scoped permission covers source task history, but never an arbitrary inherited identity.
        if(visibleTasks.some(task=>task.task_id===reference.taskId))value.records=[record("task",reference.taskId,taskUrl(reference.taskId),reference.roundNumber)];
        replace(key,value);
      }
    }
    if(fullOrder&&oid)setFact("order_information","completed",[record("order",oid,`/ui/digital-production?instruction=${oid}`)],iso(order!.created_at),{id:order!.created_by,name:designer});
    if(!oid)replace("order_information",emptyNode("order_information","uncreated"));
    const materialStates=new Map<number,Awaited<ReturnType<typeof materialReadiness>>>();
    const materialsFor=async(version:number)=>{let value=materialStates.get(version);if(!value){value=await materialReadiness(db,sid!,version);materialStates.set(version,value);}return value;};
    const taskService=new DigitalProductionTaskService(this.database),taskDtos=[];
    const summaries=summaryOnly||compact?await journeyTaskSummaries(db,visibleTasks.map(task=>task.task_id),observed):null;
    for(const raw of visibleTasks) {
      const definition=journeyDefinition(raw.task_kind);if(!definition)continue;
      const task=summaryOnly||!actor?summaries!.get(raw.task_id)!:await taskService.read(actor,raw.task_id,db);taskDtos.push(task);
      const state:JourneyState=task.paused&&!["completed","cancelled"].includes(task.state)?"blocked":task.state==="ready"?"active":task.state;
      const node=emptyNode(definition.key,state,task.routeVersion);node.instanceId=task.taskId;node.occurrence=task.occurrence;
      node.expectedAt=task.dueAt;node.expectedPrecision=task.dueAt?task.deadlineMode==='date_target'?'date':'instant':"missing";node.expectedKind=task.dueAt?"sla":"unset";node.enteredAt=task.enteredAt;
      if(task.deadlineMode!==undefined)node.deadlineMode=task.deadlineMode;
      if(task.deadlineExclusive!==undefined)node.deadlineExclusive=task.deadlineExclusive;
      node.sla=task.slaHours===null?"not_set":["completed","cancelled"].includes(state)?"finished":task.enteredAt?"running":"not_started";
      node.current=raw.source_id?task.routeVersion===round&&!raw.returned:raw.task_kind==="sourcing_preparation"?task.state!=="cancelled":raw.route_instance_id===currentPrep;
      node.actualAt=task.completedAt;node.actualQuality=raw.completed_quality==="现场登记"||raw.completed_quality==="已核实"?"verified":raw.completed_quality==="补报未核实"?"unverified":"missing";
      const completion=journeyCompletion(node.expectedAt,node.actualAt,node.actualQuality==="verified");node.completionResult=state==="completed"?completion.result:null;node.overdueSeconds=state==="completed"?completion.overdueSeconds:null;
      const events=summaryOnly||compact?[]:(await db.query(`SELECT e.*,u.display_name AS actor_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
        WHERE task_id=$1 AND event_kind='completed' ORDER BY recorded_at DESC,event_id DESC LIMIT 1`,[task.taskId])).rows;
      const assignments=summaryOnly||compact?[]:(await db.query("SELECT created_at,actor_id,before_state,after_state FROM audit_events WHERE entity_type='digital_task' AND entity_id=$1 AND action='digital_task_reassigned' ORDER BY created_at,id",[task.taskId])).rows;
      node.assignmentHistory=assignments.map(event=>({at:iso(event.created_at)!,actorId:event.actor_id,from:event.before_state?.assigneeId??null,to:event.after_state?.assigneeId??null}));
      const taskSummary=summaries?.get(task.taskId);
      const done=summaryOnly||compact?taskSummary?.completion:events.filter(event=>event.event_kind==="completed").at(-1);
      node.operator=done?{id:done.actor_id,name:done.actor_name}:null;
      let ownerId=task.assigneeId;
      if(done) { const later=summaryOnly||compact?taskSummary?.laterOwner?{before_state:taskSummary.laterOwner}:null:assignments.find(event=>new Date(event.created_at)>new Date(done.recorded_at));if(later)ownerId=later.before_state?.assigneeId??null; }
      node.owner=ownerId?{id:ownerId,name:ownerId===task.assigneeId?task.assigneeName:summaryOnly||compact?taskSummary?.previousOwnerName??null:(await db.query("SELECT display_name FROM app_users WHERE id=$1",[ownerId])).rows[0]?.display_name??null}:null;
      node.ownerStatus=ownerId?'assigned':'unassigned';
      node.records=[{...record("task",task.taskId,taskUrl(task.taskId),task.routeVersion),mode:task.canExecute&&!["completed","cancelled"].includes(task.state)?"handle":"read"}];
      node.blockers=(task.unmetConditions??[]).filter(detail=>!['paused','manual_block','fabric_quality','development_document'].includes(detail.condition)&&!detail.condition.startsWith('materials_ready:')).map(detail=>({key:detail.condition,label:`${detail.missing}；负责岗位：${businessRoleLabel(detail.responsibleRole)}${detail.action?`；${detail.action}`:''}`,ownerId:null,record:node.records[0]!}));
      const completionKeys=summaryOnly?taskSummary?.completionKeys??[]:(await db.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='completion' AND NOT satisfied",[task.taskId])).rows.map(row=>row.condition_key as string);

      if(raw.source_id&&['development_pattern','development_cutting','development_sewing'].includes(raw.task_kind)&&!['completed','cancelled'].includes(task.state)){
        const materialState=await materialsFor(raw.route_version),missing=raw.task_kind==='development_sewing'?materialState.sewingMissing:materialState.earlyMissing;
        node.blockers=node.blockers.filter(blocker=>blocker.key!=='materials_ready');
        if(materialState.documentMissing)node.blockers.push({key:'development_document',label:'尚无本轮可核验开发资料；负责岗位：设计师；请设计师在本单开发资料核对当前轮次并发布有效资料',ownerId:null,record:node.records[0]!});
        for(const item of missing)node.blockers.push({key:`materials_ready:${item.materialId}`,label:`${item.name}：${item.missing.join('、')}`,ownerId:null,record:node.records[0]!});
        for(const issue of materialState.quality)node.blockers.push({key:`fabric_quality:${issue.id}`,label:'问题面料尚未允许使用：请供应链总监在本单核料／开发办理页「问题面料报告与决定」明确处理；到料不能解除质量阻断',ownerId:null,record:node.records[0]!});
      }
      if(task.paused)node.blockers.push({key:"resource_paused",label:"原业务已暂停",ownerId:null,record:node.records[0]!});
      if(task.blockedReason&&task.blockedReason!=='前置条件未满足')node.blockers.push({key:"recorded_block",label:task.blockedReason,ownerId:task.assigneeId,record:node.records[0]!});
      if(task.state==='ready'&&!task.paused&&!node.blockers.length)for(const key of completionKeys){const detail=digitalConditionGuidance(key,raw.required_role);node.blockers.push({key:`completion:${key}`,label:`完成办理前：${detail.missing}；由${businessRoleLabel(detail.responsibleRole)}在原任务办理页核实并提交，当前记录可查看`,ownerId:task.assigneeId,record:node.records[0]!});}
      if(["active","blocked"].includes(state)) {
        if(task.dueAt&&(task.deadlineExclusive===false?Date.parse(task.dueAt)<Date.parse(asOf):Date.parse(task.dueAt)<=Date.parse(asOf))){node.risks.push("overdue");node.overdueSeconds=(Date.parse(asOf)-Date.parse(task.dueAt))/1000;}
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
        "SELECT material_id,action,expected_date::text FROM digital_development_material_events WHERE source_id=$1 AND route_version=$2 ORDER BY sequence", [sid, round ?? 1])).rows;
      const effectiveMaterials=(await materialsFor(round??1)).materials;
      const today = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
      const materials = (currentDocument.document as DevelopmentDocument).materials.filter(material => effectiveMaterials.some(item=>item.materialId===material.materialId&&item.required));
      const supplyPlaceholder = baseNodes.findIndex(value => value.key === "development_material_supply" && value.instanceId === `development_material_supply:${value.round ?? 0}`);
      if (!materials.length && supplyPlaceholder >= 0) baseNodes[supplyPlaceholder] = emptyNode("development_material_supply", "not_applicable", round);
      materials.forEach((material, index) => {
        const events = materialEvents.filter(event => event.material_id === material.materialId);
        const arrived = effectiveMaterials.find(item=>item.materialId===material.materialId)?.available??false;
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
    let businessQuantities:ReturnType<typeof journeyBusinessQuantities>|undefined;
    const requirementEvidence:RequirementEvidence=new Map();
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
      const sourcingAllowed=!actor||actor.actorRoles.includes("root_superuser")||(actor.authorizationCapabilities??[]).includes("sourcing:view");
      const sourcing=children.find(child=>child.module==="sourcing");
      // The original detail flow hides logically deleted cases, including approval history and URLs.
      const sourcingFields=sourcing&&sourcingAllowed?(await db.query("SELECT source.additional_merchandiser_user_id,source.style_name_snapshot,source.erp_order_no,current.status FROM sourcing_cases source JOIN current_sourcing_cases current USING(sourcing_case_id) WHERE source.sourcing_case_id=$1 AND source.deleted_at IS NULL",[sourcing.child_id])).rows[0]:null;
      const closureAllowed=!actor||actor.actorRoles.some(role=>["root_superuser","owner_group","production_management","pmc","order_merchandiser","warehouse_receiver", "warehouse_supervisor","quality_control"].includes(role));
      const childLines=(await db.query("SELECT module,child_id,line_id FROM digital_production_child_lines WHERE production_order_id=$1 ORDER BY module,line_id,child_id",[oid])).rows;
      for(const child of children) {
        let url:string|null=null;
        if(child.module==="sourcing"&&sourcingFields&&child.child_id===sourcing?.child_id)url=`/ui/sourcing/orders/${child.child_id}`;
        if(child.module==="cutting"&&(!actor||actor.actorRoles.includes("root_superuser")||(actor.authorizationCapabilities??[]).includes("cutting:orders:view")))url=`/ui/cutting/orders/${child.child_id}`;
        if(child.module==="production"&&(!actor||canReadProductionReporting(actor))) {
          const allowed=!actor||(await db.query(`SELECT production.production_order_id FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id) WHERE production.production_order_id=$5 AND ${productionVisibilityFor(actor)}`,[...productionVisibilityArgs(actor),child.child_id])).rowCount;
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
      // Search/owner facets still use the same authorized linking facts. Board
      // cards do not consume budgets, closure detail or downstream domain gates.
      if(sourcingFields){
        styleName=sourcingFields.style_name_snapshot??null;if(sourcingFields.erp_order_no)orderNumbers.push(sourcingFields.erp_order_no);
        if(sourcingFields.additional_merchandiser_user_id)merchandisers.push({id:sourcingFields.additional_merchandiser_user_id,name:(await db.query("SELECT display_name FROM app_users WHERE id=$1",[sourcingFields.additional_merchandiser_user_id])).rows[0]?.display_name??null});
      }
      if(!patternKinds){
      const bulk=await journeyMeasure('bulk',async()=>actor?await new BulkPreparationService(this.database).read(actor,oid,db):await new BulkPreparationService(this.database).readJourneyFactsWithClient(oid,db,observed));
      const gates=await journeyMeasure('bulk',()=>new BulkPreparationService(this.database).gates(db,oid));
      const bulkUrl=`/ui/digital-production?bulk=${oid}`;
      const confirmation=gates.customerSampleFact?.payload;
      let confirmationTime=confirmation&&['现场登记','已核实'].includes(confirmation.timeQuality)&&typeof confirmation.actualCompletedAt==='string'
        &&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(confirmation.actualCompletedAt)&&Number.isFinite(Date.parse(confirmation.actualCompletedAt))
        &&Date.parse(confirmation.actualCompletedAt)<=Date.parse(asOf)?iso(confirmation.actualCompletedAt):null;
      let confirmationOperator=gates.customerSampleFact?.actor_id as string|undefined;
      let confirmationQuality:JourneyNode['actualQuality']='verified';
      if(bulk.customerConfirmed&&gates.technical?.finalCommentRef&&sid&&gates.source){
        // Technical effectiveness permits the route, while the customer's own
        // explicit occurrence (not review/recording time) proves confirmation.
        const comment=(await db.query(`SELECT comment_id,occurred_at,recorded_by FROM digital_development_final_comments
          WHERE source_id=$1 AND round_number=$2 AND comment_id=$3 AND version=$4 AND scope_ref='整款' AND is_final AND decision='approved'`,
          [sid,gates.source.round_number,gates.technical.finalCommentRef.id,gates.technical.finalCommentRef.version])).rows[0];
        if(comment?.occurred_at&&Date.parse(iso(comment.occurred_at)!)<=Date.parse(asOf)){
          confirmationTime=iso(comment.occurred_at);confirmationOperator=comment.recorded_by;confirmationQuality='unverified';
        }
      }
      // Technical readiness is a valid alternate gate, not a timestamp of the
      // separate customer-confirmation event. Old payloads remain time-unknown.
      const customerSample=setFact("customer_sample",bulk.customerConfirmed?"completed":"pending",sid?[record("development",sid,developmentUrl(sid,gates.source?bulk.sourceRound??round??1:currentDocument?round??1:undefined),bulk.sourceRound)]:[],bulk.customerConfirmed?confirmationTime:null);
      if(confirmationTime){customerSample.actualQuality=confirmationQuality;if(confirmationQuality!=='verified'){customerSample.completionResult='unknown';customerSample.overdueSeconds=null;}if(confirmationOperator)customerSample.operator={id:confirmationOperator,name:null};}
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
      if(!bulk.cutting.completed){const physical=await styleLabelCuttingReason(db,oid,bulk.cutting.lines.map(l=>l.lineId));const tests=await preparationTestReasons(db,oid);for(const [index,label] of [...(physical?[physical]:[]),...tests].entries())gate.blockers.push({key:`physical_cutting_${index}`,label,ownerId:physical&&index===0?bulk.readiness?.responsibility.warehouseWorkerId??null:null,record:gate.records[0]!});}
      gate.state=!gate.blockers.length&&cuttingTask?"completed":"pending";
      // A released cutting task and original all-line cutting facts are historical
      // convergence evidence. Current write restrictions cannot undo that fact.
      if(cuttingTask&&bulk.cutting.completed) {
        gate.state="completed";
        gate.blockers=[];
      }
      gate.completionResult=gate.state==="completed"?"unknown":null;
      // The original synchronous completion command records businessNow in this
      // fact (not database ingestion time), scoped to the current preparation.
      const marker=currentPrep?(await db.query("SELECT fact_id,recorded_at FROM digital_bulk_preparation_facts WHERE preparation_id=$1 AND kind='唛架完成'",[currentPrep])).rows[0]:null;
      setFact("bulk_marker",marker?"completed":currentPrep?"pending":"uncreated",[record("preparation",oid,`/ui/digital-pattern-room?section=bulk&bulkOrder=${oid}`,bulk.instructionVersion)],iso(marker?.recorded_at));
      if(bulk.preshrink==="无需预缩"){
        const current=baseNodes.filter(node=>node.key==='warehouse_preshrink'&&node.current);
        if(!current.some(node=>node.state==='completed'||node.actualAt)){
          if(current.length)for(const node of current){node.state='not_applicable';node.countsInProgress=false;node.blockers=[];node.risks=[];}
          else replace('warehouse_preshrink',emptyNode('warehouse_preshrink','not_applicable'));
        }
      }
      const budgetAllowed=!actor||await policy.allowed(actor,"order",oid,"budget");
      if(budgetAllowed) {const budget=(await db.query("SELECT version,status,published_at FROM digital_budget_documents WHERE production_order_id=$1",[oid])).rows[0];setFact("budget",budget?.status==="published"?"completed":budget?"active":"uncreated",budget?[record("budget",oid,`/ui/digital-production?budget=${oid}${budget.status==="published"?`&budgetVersion=${budget.version}`:""}`,budget.version)]:[],iso(budget?.published_at));}
      else replace("budget",emptyNode("budget","unavailable"));
      if(sourcing&&!sourcingAllowed)for(const key of ["sourcing_ie","sourcing_director","sourcing_owner"])replace(key,emptyNode(key,"unavailable"));
      if(sourcing&&sourcingFields) {
        setFact("sourcing_preparation","completed",[record("sourcing",sourcing.child_id,`/ui/sourcing/orders/${sourcing.child_id}`)]);
        const target=record("sourcing",sourcing.child_id,`/ui/sourcing/orders/${sourcing.child_id}`,gates.approval?.decision_version??null);
        // Price reapplication is independent of the original IE / factory-choice
        // approvals. Keep those historical actors and times, not the price reviewer.
        const effectiveDecision=gates.approval?.sourcing_decision_id;
        const decision=effectiveDecision?(await db.query(`WITH RECURSIVE basis AS (
          SELECT sourcing_decision_id,source_type,supersedes_decision_id FROM sourcing_decisions WHERE sourcing_decision_id=$1 AND sourcing_case_id=$2
          UNION ALL SELECT parent.sourcing_decision_id,parent.source_type,parent.supersedes_decision_id
          FROM sourcing_decisions parent JOIN basis child ON child.source_type='price_reapplication' AND parent.sourcing_decision_id=child.supersedes_decision_id
          WHERE parent.sourcing_case_id=$2)
          SELECT sourcing_decision_id FROM basis WHERE source_type<>'price_reapplication' LIMIT 1`,[effectiveDecision,sourcing.child_id])).rows[0]?.sourcing_decision_id:undefined;
        const ie=(await db.query(`SELECT q.sourcing_ie_quote_id,q.quote_version,q.quoted_by,q.quoted_at FROM sourcing_ie_quotes q
          WHERE q.sourcing_case_id=$1 AND ($2::uuid IS NULL OR q.sourcing_ie_quote_id=(SELECT source_ie_quote_id FROM sourcing_decisions WHERE sourcing_decision_id=$2)) ORDER BY quote_version DESC LIMIT 1`,[sourcing.child_id,decision??null])).rows[0];
        setFact("sourcing_ie",ie?"completed":"pending",[{...target,version:ie?.quote_version??null,url:ie?`${target.url}?view=node-history&node=ie_quote&entryId=${ie.sourcing_ie_quote_id}`:target.url}],iso(ie?.quoted_at),ie?{id:ie.quoted_by,name:null}:null);
        const management=(await db.query("SELECT sourcing_decision_id,decision_version,decided_at,decided_by FROM sourcing_decisions WHERE sourcing_case_id=$1 AND ($2::uuid IS NULL OR sourcing_decision_id=$2) ORDER BY decision_version DESC LIMIT 1",[sourcing.child_id,decision??null])).rows[0];
        const managementCompleted=Boolean(management&&sourcingFields.status!=="pending_management_decision");
        setFact("sourcing_director",managementCompleted?"completed":"pending",[{...target,version:management?.decision_version??null,url:management?`${target.url}?view=node-history&node=management&entryId=${management.sourcing_decision_id}`:target.url}],managementCompleted?iso(management?.decided_at):null,managementCompleted?{id:management!.decided_by,name:null}:null);
        const ownerDecision=management?(await db.query("SELECT sourcing_owner_decision_id,decision,decision_reason,decided_at,decided_by FROM sourcing_owner_decisions WHERE sourcing_decision_id=$1",[management.sourcing_decision_id])).rows[0]:null;
        const ownerRecord={...target,version:management?.decision_version??null,url:ownerDecision?`${target.url}?view=node-history&node=owner&entryId=${ownerDecision.sourcing_owner_decision_id}`:target.url};
        const ownerNode=setFact("sourcing_owner",bulk.ownerApproved?"completed":ownerDecision?.decision==="rejected"?"blocked":"pending",[ownerRecord],bulk.ownerApproved?iso(ownerDecision?.decided_at):null,ownerDecision?{id:ownerDecision.decided_by,name:null}:null);
        if(ownerDecision?.decision==="rejected") {
          ownerNode.operator=ownerNode.owner;ownerNode.risks.push("blocked");
          ownerNode.blockers.push({key:"original_owner_rejected",label:ownerDecision.decision_reason,ownerId:null,record:ownerRecord});
        }
      }
      const closure=await journeyMeasure('closure',()=>actor?new OrderClosureService(this.database).read(actor,oid,db):new OrderClosureService(this.database).readFactsWithClient(oid,db));
      const receiptIds=closure.lines.flatMap(line=>line.receipts.map(receipt=>receipt.receiptId));
      const attributed=receiptIds.length?(await db.query<{receipt_id:string}>(`SELECT link.receipt_id
        FROM sourcing_production_receipt_links link JOIN sourcing_production_orders production USING(production_order_id)
        JOIN sourcing_decisions decision ON decision.sourcing_decision_id=coalesce(link.factory_decision_id,production.sourcing_decision_id)
        JOIN digital_production_child_links native ON native.module='production' AND native.child_id=link.production_order_id AND native.production_order_id=$1
        WHERE link.receipt_id=ANY($2::uuid[]) AND decision.supplier_id IS NOT NULL`,[oid,receiptIds])).rows:[];
      businessQuantities=journeyBusinessQuantities(closure,new Set(attributed.map(row=>row.receipt_id)));
      const reworks=closure.lines.flatMap(line=>line.reworks);
      if(!reworks.length)for(const key of ['rework','rework_review','responsibility'])requirementEvidence.set(key,{applicability:'not_applicable',completed:false,reason:'本单原记录中没有适用的做尾或返工业务',instanceIds:[]});
      else {
        requirementEvidence.set('rework',{applicability:'applicable',completed:reworks.every(value=>value.status==='completed'),reason:'按本单全部有效做尾或返工记录核对，不含工资是否结清',instanceIds:reworks.map(value=>value.reworkId)});
      }
      const closureRecord=record("closure",oid,`/ui/digital-production?closure=${oid}`);
      const received=closure.collection?.status==='已收齐';
      const receiptNode=setFact("receipts",received?"completed":closure.lines.some(line=>line.receiptCount>0)?"active":"uncreated",[closureRecord],received?closure.receivingSpan?.collectedAt??null:null);
      if(received&&!receiptNode.actualAt&&closure.receivingSpan?.collectedDate){receiptNode.actualDate=closure.receivingSpan.collectedDate;receiptNode.actualQuality='verified';}
      setFact("packing",closure.stage==="本期装箱完成"?"completed":closure.lines.some(line=>line.packingRevisionId)?"active":"uncreated",[closureRecord]);
      setFact("quantity_difference",closure.lines.some(line=>line.receiptCount>0&&line.actualQuantity!==line.documentQuantity&&!line.receivingResolution||line.packingQuantity!==null&&line.packingQuantity!==line.actualQuantity&&!line.packingResolution)?"pending":"not_applicable",[closureRecord]);
      if(closure.closed) {
        const original=(await db.query<{closed_by:string}>("SELECT closed_by FROM digital_order_closures WHERE production_order_id=$1",[oid])).rows[0]!;
        setFact("special_closure","completed",[closureRecord],closure.closed.closedAt,{id:original.closed_by,name:closure.closed.closedBy});
      }
      else replace("special_closure",emptyNode("special_closure","not_applicable"));
      for(const line of closure.lines)for(const rework of line.reworks){const node=emptyNode("rework",rework.status==="completed"?"completed":rework.status==="cancelled"?"cancelled":"active");node.instanceId=rework.reworkId;node.records=[{...record("rework",rework.reworkId,closure.canOpenRework?`/ui/tasks/${rework.reworkId}`:null),lineId:line.lineId}];appendJourneyInstance(baseNodes,node);}
      if(currentPrep&&gates.instruction&&gates.source)progress.bulk=bulkCockpitProgress({preshrink:bulk.preshrink??"",secondaryCraft:gates.instruction.document.secondaryCraft==="沿用开发"?gates.source.document.craft:gates.instruction.document.secondaryCraft,externalCutting:gates.approval?.cutting_process==="outsourced",tasks:taskDtos.filter(task=>{const raw=visibleTasks.find(item=>item.task_id===task.taskId);return raw?.route_instance_id===currentPrep||(task.taskKind==='bulk_ship_sample'&&raw?.route_instance_id===oid);}),received,packed:closure.stage==="本期装箱完成",specialClosed:Boolean(closure.closed)});
      for(const key of ["receiving_inspection","rework_review","responsibility"]) {const node=emptyNode(key,"unavailable");node.unavailableReason="fact_not_recorded";replace(key,node);}
      const arrivalChecks=closure.quality?.filter(q=>q.quantity>0)??[];
      if(arrivalChecks.length)setFact('receiving_inspection',arrivalChecks.every(q=>q.inspected)&&closure.lines.every(l=>l.actualQuantity>=l.orderedQuantity)?'completed':'active',[closureRecord],arrivalChecks.every(q=>q.completedAt)?new Date(Math.max(...arrivalChecks.map(q=>Date.parse(q.completedAt!)))).toISOString():null);
      if(!actor||closure.canOpenRework)for(const line of closure.lines)for(const rework of line.reworks) {
        const url=`/ui/tasks/${rework.reworkId}`;
        const append=(key:string,state:JourneyState,id:string,actualAt:string|null,ownerId:string|null,recordUrl:string|null)=>{
          const node=emptyNode(key,state);node.instanceId=id;node.actualAt=actualAt;node.actualQuality=actualAt?"verified":"missing";
          node.owner=ownerId?{id:ownerId,name:null}:null;node.operator=state==="completed"&&actualAt?node.owner:null;node.records=[{...record("rework",rework.reworkId,recordUrl),lineId:line.lineId}];
          appendJourneyInstance(baseNodes,node);
        };
        const reviewed=(await db.query("SELECT order_review_id,reviewed_by,reviewed_at FROM rework_order_reviews WHERE rework_order_id=$1",[rework.reworkId])).rows[0];
        if(reviewed)append("rework_review","completed",reviewed.order_review_id,iso(reviewed.reviewed_at),reviewed.reviewed_by,actor?await journeyReworkHistoryUrl(db,actor,rework.reworkId,["whole_order_review","final_quantity_ie_review"],reviewed.order_review_id):null);
        else if(rework.status==='pending_order_review')append("rework_review","pending",`review:${rework.reworkId}`,null,null,`${url}?node=whole_order_review`);
        const determination=(await db.query("SELECT determination_id,stage,handler_user_id,operation_event_id FROM rework_responsibility_determinations WHERE rework_order_id=$1 ORDER BY determination_version DESC LIMIT 1",[rework.reworkId])).rows[0];
        // A finalized determination does not finish its responsibility handling or settle wages.
        if(determination)append("responsibility",rework.status==='completed'?"completed":rework.status==='cancelled'?"cancelled":"active",determination.determination_id,null,determination.handler_user_id,actor?await journeyReworkHistoryUrl(db,actor,rework.reworkId,"responsibility",determination.determination_id,determination.operation_event_id):null);
      }
      if(gates.instruction&&gates.source) {
        const craft=gates.instruction.document.secondaryCraft==="沿用开发"?gates.source.document.craft:gates.instruction.document.secondaryCraft;
        if(craft==="无")for(const key of ["process_logistics","bulk_qc"])replace(key,emptyNode(key,"not_applicable"));
      }
      const native=children.find(child=>child.module==="production");
      if(native&&links.some(link=>link.domain==="production"&&link.id===native.child_id)) {
        const completion=await factoryProductionCompletion(db,oid!);
        const value=setFact("production_reporting",completion.completed?"completed":"active",[record("production",native.child_id,`/ui/production-dashboard/${native.child_id}`)]);
        value.actualDate=completion.actualDate;value.actualQuality=completion.actualDate?'unverified':'missing';
        if(completion.completed){value.completionOperators=completion.operators;value.operator=completion.operators.length===1?completion.operators[0]!:null;}
        if((await db.query("SELECT to_regclass('digital_qc_tracking_starts') AS relation")).rows[0]?.relation){
          const qcEvidence=await readQcExecutionEvidence(db,oid!,asOf);
          const task=qcEvidence[0]?.group.task;
          if(task?.assignee_id){value.owner={id:task.assignee_id,name:null};value.ownerStatus="assigned";}
          value.records.unshift(record('factory',oid!,`/ui/digital-production?factory=${oid}&factoryAction=productionProgress`));
        }
        if(value.state==="completed"&&!value.actualDate)value.risks.push("unknown");
      } else if(native) replace("production_reporting",emptyNode("production_reporting","unavailable"));
    }
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
    for(const node of baseNodes.filter(node=>node.state==='inherited'&&node.inheritedFrom&&node.progressApplicability==='applicable')){
      const original=baseNodes.find(value=>value.instanceId===node.inheritedFrom!.taskId&&value.state==='completed');
      // The immutable round publication atomically adopted the listed original
      // result. Its business timestamp is adoption, not that result's work end.
      const adoptedAt=round&&round>1&&currentDocument?.round_number===round?iso(currentDocument.published_at):null;
      const valid=adoptedAt&&Date.parse(adoptedAt)<=Date.parse(asOf);
      node.inheritedResult={actualAt:original?.actualAt??null,quality:original?.actualQuality??'missing',adoptedAt:valid?adoptedAt:null,
        ...(valid?{adoptedRound:round!,adoptionSourceRef:`development-round:${sid}:${round}`} : {}),
        reason:valid?'本轮发布时沿用原成果；不是本轮重新作业完工':'尚无独立的本轮采用完成时点；原成果时间不作本轮或本阶段完成时间'};
    }
    // Mutated nodes remain in the shared base list; all seven stages are always returned.
    const poDeliveryDates=!patternKinds&&orderAccess&&oid?await readOrderPoDeliveryDates(db,oid,lines.map(line=>line.id)):[];
    const finalClosed=baseNodes.some(node=>node.current&&['packing','special_closure'].includes(node.key)&&node.state==='completed');
    const terminal=!patternKinds&&orderAccess&&oid&&(await db.query("SELECT 1 WHERE EXISTS(SELECT 1 FROM digital_order_closures WHERE production_order_id=$1) OR EXISTS(SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1 AND state='cancelled')",[oid])).rowCount;
    const promiseDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
    // A hidden reporting node cannot stand in for the whole order's authoritative completion.
    // Read only this boolean for an already authorized mother; retain all reporting visibility gates.
    const factoryQcState=!patternKinds&&orderAccess&&oid?await factoryProductionFacts(db,oid):null;
    const factoryFinished=Boolean(factoryQcState?.complete);
    const qcNode=baseNodes.find(n=>n.current&&n.key==='factory_production_qc'&&!['uncreated','unavailable','not_applicable'].includes(n.state));
    if(factoryQcState&&qcNode){
      // Native inspection changes completion facts, never erases the original
      // task identity, assignment, paused state or captured responsibility D.
      qcNode.state=factoryQcState.complete?'completed':qcNode.state==='blocked'?'blocked':'active';
      qcNode.actualAt=factoryQcState.complete&&factoryQcState.checks.every(c=>c.completedAt)?new Date(Math.max(...factoryQcState.checks.map(c=>Date.parse(c.completedAt!)))).toISOString():null;
      qcNode.actualQuality=qcNode.actualAt?factoryQcState.checks.every(c=>['现场登记','已核实'].includes(c.completedQuality??''))?'verified':'unverified':'missing';
      const operators=[...new Map(factoryQcState.checks.flatMap(check=>check.completedBy?[[check.completedBy.id,check.completedBy] as const]:[])).values()];
      qcNode.completionOperators=factoryQcState.complete?operators:[];qcNode.operator=factoryQcState.complete&&operators.length===1?operators[0]!:null;
      const completion=journeyCompletion(qcNode.expectedAt,qcNode.actualAt,qcNode.actualQuality==='verified');qcNode.completionResult=factoryQcState.complete?completion.result:null;qcNode.overdueSeconds=factoryQcState.complete?completion.overdueSeconds:null;
      const nativeRecord=record('factory',oid!,`/ui/digital-production?factory=${oid}&factoryAction=productionQc`);
      if(!qcNode.records.some(value=>value.domain===nativeRecord.domain&&value.url===nativeRecord.url))qcNode.records.push(nativeRecord);
      if((await db.query("SELECT to_regclass('digital_qc_tracking_starts') AS relation")).rows[0]?.relation){
        const evidence=await readQcExecutionEvidence(db,oid!,asOf,finalClosed||Boolean(terminal));
        const windows=evidence.flatMap(scope=>scope.windows.map(window=>({scopeLabel:`${scope.group.rows[0]?.supplier_name_snapshot??'工厂名称尚未取得'} · `+window.lineIds.map(id=>{const line=lines.find(line=>line.id===id);return line?`PO ${line.po??'号码尚未取得'} · ${line.color}`:'PO范围依据尚未取得';}).join(' / '),state:window.clock.state,reason:window.clock.reason,anchor:window.clock.anchor,remindAt:window.clock.remindAt,escalateAt:window.clock.escalateAt})));
        const ended=windows.filter(window=>window.state==='finished').length,unknown=windows.filter(window=>window.state==='unknown').length;
        qcNode.productionSupervision={state:windows.length&&ended===windows.length?'ended':!windows.length||unknown===windows.length?'unknown':ended||unknown?'partial':'active',windows};
      }
    }
    const samples=orderAccess&&oid?await shipSampleFacts(db,oid):[];
    const sampleSentLineIds=new Set(samples.flatMap(r=>r.lineIds));
    if(fullOrder&&lines.length&&lines.every(line=>sampleSentLineIds.has(line.id)))requirementEvidence.set('bulk_ship_sample',{applicability:'applicable',completed:true,reason:'本单全部PO已有原生船样寄出记录；原任务和历史状态保留',instanceIds:samples.map(sample=>sample.eventId)});
    const deliveryRisks=poDeliveryRisks(poDeliveryDates,promiseDay,{finished:finalClosed||Boolean(terminal),factoryFinished,sampleFinished:baseNodes.some(node=>node.current&&node.key==='bulk_ship_sample'&&node.state==='completed')}).filter(r=>r.kind!=='sample'||!sampleSentLineIds.has(r.lineId));
    const sourceImage=!patternKinds&&sourceAccess?currentDocument?.document?.files?.find((file:{kind:string})=>file.kind==='款图'):null;
    const instructionImages=!patternKinds&&!sourceImage&&orderAccess?(await db.query(`SELECT v.document->'images' AS images FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[oid])).rows[0]?.images:null;
    const instructionImage=instructionImages?.find((file:{kind:string})=>file.kind==='款图');
    const styleImageUrl=sourceImage&&sid?`/api/digital-production/sources/${sid}/development/attachments/${sourceImage.attachmentId}`:instructionImage&&oid?`/api/digital-production/orders/${oid}/instruction/attachments/${instructionImage.attachmentId}`:null;
    for(const node of baseNodes){
      if(node.progressApplicability)continue;
      if(node.state==="unavailable")node.progressApplicability="unknown";
      else if(node.state==="not_applicable")node.progressApplicability="not_applicable";
      else if(node.stage==="development"&&!declared)node.progressApplicability="unknown";
      else if(node.stage==="post_cutting"&&!instruction&&node.state==="uncreated")node.progressApplicability="unknown";
      else if(["receiving_inspection","rework","rework_review","responsibility","quantity_difference","special_closure"].includes(node.key)&&node.state==="uncreated")node.progressApplicability=finalClosed?"not_applicable":"unknown";
      else node.progressApplicability="applicable";
    }
    if(!patternKinds&&fullOrder&&oid){const planned=await seriesPlanJourney(db,oid,promiseDay,Boolean(terminal));for(const n of planned){const existing=baseNodes.findIndex(v=>v.key===n.key);if(existing>=0)baseNodes[existing]=n;else baseNodes.push(n);}}
    if((!summaryOnly||!actor)&&fullOrder&&oid&&visibleTasks.some(task=>['process_logistics','bulk_qc','warehouse_dispatch'].includes(task.task_kind))){
      const factory=await factorySlaEvidence(db,oid);
      if(factory)attachJourneyFactoryDeadlines(baseNodes,visibleTasks,factory,lines);
    }
    const stages=journeyStages(baseNodes);
    const item:OrderJourney={seriesPlanVisible:Boolean(!patternKinds&&fullOrder&&oid),asOf,styleImageUrl,developmentType:sourceAccess?source?.development_type??null:null,requiredCompletionDate:sourceAccess?currentDocument?.document?.returnDate??null:null,id:canonicalId,sourceId:sid,orderId:orderAccess?oid:null,designStyleNo:chosenIdentity.design_style_no,temporaryStyleNo:chosenIdentity.temporary_style_no,customer:chosenIdentity.customer_code,category:currentDocument?.document.template??(orderAccess?order?.product_group:null)??null,styleName,designer,merchandisers,orderNumbers,createdAt:iso(sourceAccess?source!.created_at:orderAccess?order!.created_at:(source?.created_at??order!.created_at))!,deliveryDate:orderAccess?digitalDateText(order?.contract_delivery_date??null):null,poDeliveryDates,deliveryRisks,selectedRound:round,adoptedRound:instruction?.source_round??null,sourceVersion:currentDocument?.version??currentDocument?.document_version??null,instructionVersion:instruction?.version??null,lines,links,stages,progress,hitReasons:[]};
    const lifecycle=oid&&orderAccess?{kind:"order",id:oid}:!oid&&sid&&sourceAccess?{kind:"source",id:sid}:null;
    const cancelled=Boolean(!patternKinds&&lifecycle&&(await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2 AND state='cancelled'",[lifecycle.kind,lifecycle.id])).rowCount);
    // Do not expand an assigned worker's single-task read scope to the whole SLA/PO history.
    if(supervision&&!patternKinds&&selectedRound===undefined){
    const timingRoles=['production_management','owner_group','pmc','pattern_room_supervisor','development_clerk'];
    let liveTimingAuthority=!actor||isRootActor(actor);
    if(actor&&!liveTimingAuthority)for(const role of timingRoles)if(actor.actorRoles.includes(role)&&await policy.activeRole(actor.actorId,role)){liveTimingAuthority=true;break;}
    const ownSource=actor&&sourceAccess&&source?.created_by===actor.actorId&&actor.actorRoles.includes('sample_designer')&&await policy.activeRole(actor.actorId,'sample_designer');
    const ownOrder=actor&&(order?.created_by===actor.actorId&&actor.actorRoles.includes('sample_designer')&&await policy.activeRole(actor.actorId,'sample_designer')
      ||order?.primary_merchandiser_id===actor.actorId&&actor.actorRoles.includes('order_merchandiser')&&await policy.activeRole(actor.actorId,'order_merchandiser'));
    if(fullOrder&&(liveTimingAuthority||ownOrder)||!oid&&sourceAccess&&(liveTimingAuthority||ownSource))
      await journeyMeasure('sla',()=>readJourneySupervision(this.database,db,actor,item,observed,visibleTasks.some(task=>task.task_kind==='bulk_cutting_external'),new Set(visibleTasks.map(task=>task.task_id)),capture));
    else item.supervision={asOf:observed.now,status:'limited',originalRevision:null,currentRevision:null,nodes:[],coverage:[{key:'scope',message:'仅有本岗位节点权限，整单SLA未计入；已授权节点照常监督'}],customerReminderDate:null};
    }
    item.display=journeyDisplay(item,asOf,{cancelled,closedAt:baseNodes.find(node=>node.current&&node.key==='special_closure'&&node.state==='completed')?.actualAt??null});
    if(!patternKinds){
      // The original ERP-labelled value can be an external request UUID. It is
      // retained for legacy search, never promoted to a formal business number.
      item.identity={kind:item.orderId?'production':'development',businessNumber:null,reason:item.orderId?'尚未取得本单正式业务号与母单的可信映射':'开发资料视图；尚未取得可见的正式订单'};
      const adopted=fullOrder&&oid?await readJourneyAdoptedPlan(db,oid,lines):oid?'unavailable' as const:null;
      const replacements=sourceAccess&&sid&&visibleTasks.some(task=>task.returned)
        ?await readMaterialSuccessors(db,sid,visibleTasks.map(task=>task.task_id)):[];
      item.businessProgress=journeyBusinessProgress(item,observed.now,adopted,businessQuantities,requirementEvidence,replacements);
      item.businessProgress.dates=journeyBusinessDates(item);
      item.visualProgress=journeyVisualProgress(item,asOf);
    }
    this.authorizedTasks.set(item,visibleTasks.map(task=>({id:task.task_id,key:journeyDefinition(task.task_kind)?.key??task.task_kind,label:journeyDefinition(task.task_kind)?.label??"业务节点",round:task.route_version})));
    return item;
  }
}
