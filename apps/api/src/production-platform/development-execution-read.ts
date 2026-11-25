import type {PoolClient} from "pg";
import type {TrustedActorContext} from "../tools/repositories.js";
import type {DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import type {DigitalTask} from "@dx-rework/contracts/digital-production-tasks";
import type {DevelopmentTechnicalState} from "@dx-rework/contracts/digital-development-technical";
import {isRootActor} from "../access/business-authority.js";
import {DigitalProductionAccessPolicy,isDigitalLeader,isDigitalTechnicalManager} from "./access-policy.js";
import {externalPatternRecords} from "./development-external-pattern-facts.js";
import {fabricCases} from "./development-fabric-cases.js";
import {readMaterialVerification} from "./development-material-verification.js";
import {readArrangement,arrangementsAvailable,plannedRecipient} from "./development-arrangement.js";
import {materialReadiness,type MaterialReadiness} from "./development-material-readiness.js";
import {developmentSlaPlan,savedDevelopmentRoute} from "./development-sla-enrollment.js";
import {developmentNextSteps} from "./development-route.js";
import {fixedDevelopmentCutter,canConfigureDevelopmentCutter} from "./development-fixed-cutting.js";
import {deferredDevelopmentRoute} from './development-native-route.js';

export type DevelopmentExecutionFact={
  factId:string;taskId:string|null;kind:string;payload:Record<string,unknown>;actorId:string;recordedAt:Date;
};
type DevelopmentExecutionRouteFact=Omit<DevelopmentExecutionFact,"actorId">&{routeVersion:number};
type DevelopmentDispatchSnapshot={version:number;patternWorkerId:string|null;cuttingWorkerId:string|null;sewingWorkerId:string|null};
type DevelopmentPatternPreparation={
  status:string;categorySaved:boolean;priceSaved:boolean;version:number;
  roundId:string;roundType:string;workerId:string|null;workerName:string|null;
};

/** Original response shape; dates and nullable/optional historical fields are not normalized here. */
export interface DevelopmentExecutionSnapshot{
  technical:DevelopmentTechnicalState;
  externalPatterns:Awaited<ReturnType<typeof externalPatternRecords>>;
  canRequestExternalPattern:boolean;
  sewingRecipientName:string|null;
  slaEnrolled:boolean;
  deferredTechnicalWorkflow?:true;
  fixedCutting:(Partial<NonNullable<Awaited<ReturnType<typeof fixedDevelopmentCutter>>>>&{canConfigure:boolean})|null;
  reopenMaterialCheck:{taskId:string;supplyTaskId:string;roundNumber:number;expectedDocumentVersion:number;expectedVerificationVersion:number}|null;
  fabricCases:Awaited<ReturnType<typeof fabricCases>>;
  materialVerification:Awaited<ReturnType<typeof readMaterialVerification>>;
  unifiedArrangement:boolean;
  arrangement:Awaited<ReturnType<typeof readArrangement>>;
  canConfirmExecution:boolean;
  sheet:DevelopmentSheet;
  materialReadiness:MaterialReadiness[];
  supplementCheckTaskId:string|null;
  nextSteps:ReturnType<typeof developmentNextSteps>;
  dispatch:DevelopmentDispatchSnapshot|null;
  tasks:DigitalTask[];
  routeFacts:DevelopmentExecutionRouteFact[];
  patternOrder:{orderId:string}|null;
  patternPreparation:DevelopmentPatternPreparation|null;
  facts:DevelopmentExecutionFact[];
  canReportFabric:boolean;
  canDispatch:boolean;
  canDecideFabric:boolean;
}

/** Narrow read capabilities only. Each call receives the caller's same snapshot proxy. */
export interface DevelopmentExecutionReaders{
  readSheet:(actor:TrustedActorContext,sourceId:string,client:PoolClient)=>Promise<DevelopmentSheet>;
  readTasks:(actor:TrustedActorContext,taskIds:readonly string[],client:PoolClient)=>Promise<DigitalTask[]>;
  readTechnical:(actor:TrustedActorContext,sourceId:string,round:number,scope:string,client:PoolClient)=>Promise<DevelopmentTechnicalState>;
  readFacts:(client:PoolClient,sourceId:string)=>Promise<DevelopmentExecutionFact[]>;
}

/** Assemble one authorized read snapshot; the service retains connection/transaction ownership. */
export async function readDevelopmentExecutionSnapshot(
  db:PoolClient,actor:TrustedActorContext,sourceId:string,readers:DevelopmentExecutionReaders,
):Promise<DevelopmentExecutionSnapshot>{
    const sheet=await readers.readSheet(actor,sourceId,db);
    const dispatch=(await db.query<DevelopmentDispatchSnapshot>('SELECT version,pattern_worker_id AS "patternWorkerId",cutting_worker_id AS "cuttingWorkerId",sewing_worker_id AS "sewingWorkerId" FROM digital_development_dispatch WHERE source_id=$1',[sourceId])).rows[0]??null;
    const ids=(await db.query<{task_id:string}>("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 ORDER BY created_at,task_id",[sourceId])).rows;
    const tasks=await readers.readTasks(actor,ids.map(row=>row.task_id),db);
    const routeFacts=(await db.query<DevelopmentExecutionRouteFact>('SELECT fact_id AS "factId",task_id AS "taskId",route_version AS "routeVersion",kind,payload,recorded_at AS "recordedAt" FROM digital_development_route_facts WHERE source_id=$1 ORDER BY sequence',[sourceId])).rows;
    const patternOrder=(await db.query<{orderId:string}>('SELECT order_id AS "orderId" FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0]??null;
    const patternPreparation=patternOrder&&(await db.query("SELECT to_regclass('pattern_room_rounds') AS relation")).rows[0]?.relation?(await db.query<DevelopmentPatternPreparation>(`SELECT o.status,r.category_id IS NOT NULL AS "categorySaved",r.agreed_amount IS NOT NULL AS "priceSaved",
      o.version,r.round_id AS "roundId",r.round_type AS "roundType",s.worker_user_id AS "workerId",s.worker_name AS "workerName" FROM pattern_room_orders o JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
      LEFT JOIN LATERAL(SELECT worker_user_id,worker_name FROM pattern_room_segments WHERE round_id=r.round_id ORDER BY segment_index DESC LIMIT 1)s ON true
      WHERE o.order_id=$1 AND o.deleted_at IS NULL`,[patternOrder.orderId])).rows[0]??null:null;
    const currentRound=sheet.roundNumber??1;
    const plannedSewing=await plannedRecipient(db,sourceId,currentRound,'development_sewing');
    const sewingRecipientId=tasks.find(t=>t.taskKind==='development_sewing'&&t.routeVersion===currentRound)?.assigneeId??(plannedSewing.planned?plannedSewing.id:dispatch?.sewingWorkerId);
    const sewingRecipientName=sewingRecipientId?(await db.query("SELECT display_name FROM app_users WHERE id=$1",[sewingRecipientId])).rows[0]?.display_name??null:null;
    const route:string[]=currentRound===1&&sheet.document?await savedDevelopmentRoute(db,sourceId,sheet.document):(await db.query('SELECT route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,currentRound])).rows[0]?.route_nodes??[];
    const nextSteps=developmentNextSteps(route,tasks,currentRound);
    const readiness=sheet.document?await materialReadiness(db,sourceId,currentRound):null;
    const supplementTask=readiness?.sewingMissing.length?tasks.filter(task=>task.routeVersion===currentRound&&task.state==="completed"&&task.canExecute&&["development_materials","development_material_recheck"].includes(task.taskKind)).at(-1):null;

    const currentRecheck=tasks.find(task=>task.routeVersion===currentRound&&task.taskKind==='development_material_recheck'&&task.state==='ready'&&task.canExecute);
    const materialVerification=sheet.document?await readMaterialVerification(db,sourceId,currentRound,sheet.document,sheet.version,currentRecheck?.taskId):null;
    let reopenMaterialCheck:null|{taskId:string;supplyTaskId:string;roundNumber:number;expectedDocumentVersion:number;expectedVerificationVersion:number}=null;
    if(materialVerification?.taskId&&(isRootActor(actor)||(actor.actorRoles.includes('development_clerk')&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'development_clerk')))){
      const candidate=(await db.query(`SELECT supply.task_id AS supply_id,check_task.task_id AS check_id,v.version FROM digital_production_tasks supply
       JOIN digital_production_task_access sa ON sa.task_id=supply.task_id AND sa.source_id=$1
       JOIN digital_development_material_verifications v ON v.source_id=sa.source_id AND v.round_number=supply.route_version
       LEFT JOIN digital_development_execution_facts f ON f.source_id=sa.source_id AND f.task_id=supply.task_id AND f.kind='补料复核' AND f.payload ? 'returnRequirements'
       JOIN digital_production_tasks check_task ON check_task.task_id=coalesce((f.payload->'returnRequirements'->>'checkTaskId')::uuid,v.task_id) AND check_task.route_instance_id=supply.route_instance_id AND check_task.route_version=supply.route_version
       JOIN digital_production_task_access ca ON ca.task_id=check_task.task_id AND ca.source_id=sa.source_id
       WHERE sa.task_kind='development_material_supply' AND supply.state='ready' AND supply.route_version=$2 AND check_task.state='completed'
       AND v.task_id=check_task.task_id AND ca.task_kind IN ('development_materials','development_material_recheck')
       AND EXISTS(SELECT 1 FROM digital_development_execution_facts returned WHERE returned.source_id=sa.source_id AND returned.task_id=check_task.task_id AND returned.kind='缺项退回')
       ORDER BY f.sequence DESC NULLS LAST LIMIT 1`,[sourceId,currentRound])).rows[0];
      if(candidate&&tasks.some(task=>task.taskId===candidate.check_id&&task.canExecute))reopenMaterialCheck={taskId:candidate.check_id,supplyTaskId:candidate.supply_id,roundNumber:currentRound,expectedDocumentVersion:sheet.version,expectedVerificationVersion:candidate.version};
    }
    const slaEnrolled=Boolean(await developmentSlaPlan(db,sourceId));
    const deferredTechnicalWorkflow=!slaEnrolled&&Boolean(sheet.preorderPublication&&await deferredDevelopmentRoute(db,sourceId));
    const externalPatterns=slaEnrolled||deferredTechnicalWorkflow?await externalPatternRecords(db,sourceId):[];
    const canRequestExternalPattern=isRootActor(actor)||actor.actorRoles.includes('pattern_room_supervisor')&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'pattern_room_supervisor');
    return {
      technical:await readers.readTechnical(actor,sourceId,currentRound,'整款',db),
      externalPatterns,
      canRequestExternalPattern,
      sewingRecipientName,
      slaEnrolled,...(deferredTechnicalWorkflow?{deferredTechnicalWorkflow:true as const}:{}),
      fixedCutting:slaEnrolled||deferredTechnicalWorkflow?{...await fixedDevelopmentCutter(db),canConfigure:await canConfigureDevelopmentCutter(db,actor)}:null,
      reopenMaterialCheck,
      fabricCases:await fabricCases(db,sourceId),
      materialVerification,
      unifiedArrangement:await arrangementsAvailable(db),
      arrangement:await readArrangement(db,actor,sourceId),
      canConfirmExecution:isRootActor(actor)||actor.actorRoles.includes("pattern_room_supervisor"),
      sheet,
      materialReadiness:readiness?.materials??[],
      supplementCheckTaskId:supplementTask?.taskId??null,
      nextSteps,
      dispatch,
      tasks,
      routeFacts,
      patternOrder,
      patternPreparation,
      facts:await readers.readFacts(db,sourceId),
      canReportFabric:isRootActor(actor)||actor.actorRoles.some(role=>["pattern_room_worker","pattern_room_supervisor","order_merchandiser"].includes(role)),
      canDispatch:isDigitalLeader(actor)||isDigitalTechnicalManager(actor)||actor.actorRoles.includes("development_clerk"),
      canDecideFabric:isDigitalLeader(actor)
    };
}
