import type {DevelopmentArrangementInput} from "@dx-rework/contracts/development-arrangement";
import {readArrangement,saveArrangement,arrangementsAvailable} from "./development-arrangement.js";
import {reuseJourneySnapshotReads} from "./journey-snapshot-reads.js";
import {materialReadiness,materialCheckError} from "./development-material-readiness.js";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import {DevelopmentRoundService} from "./development-round-service.js";
import {DevelopmentRouteService,type DevelopmentRouteAction} from "./development-route-service.js";
import type {PatternRoomOrderService} from "../pattern-room/order-service.js";
import {createHash,randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import type {DevelopmentCheck,DevelopmentDispatch,DevelopmentWork} from "@dx-rework/contracts/digital-development-execution";
import type {TrustedActorContext} from "../tools/repositories.js";
import {isRootActor} from "../access/business-authority.js";
import {ApplicationError} from "../platform/errors.js";
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound,isDigitalLeader,isDigitalTechnicalManager} from "./access-policy.js";
import {DigitalDevelopmentService} from "./development-service.js";
import {DigitalProductionTaskService} from "./task-service.js";
import {developmentNextSteps,developmentRoute} from "./development-route.js";
const fail=(message:string):never=>{throw new ApplicationError("DEVELOPMENT_EXECUTION_CONFLICT",message,409);};
export class DevelopmentExecutionService {
  constructor(private readonly database:Pool,private readonly enabled:boolean,private readonly patternOrders?:PatternRoomOrderService){}
  private forms(){return new DigitalDevelopmentService(this.database,this.enabled);}
  private tasks(){return new DigitalProductionTaskService(this.database);}
  private async task(db:PoolClient,sourceId:string,taskId:string){return (await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2",[sourceId,taskId])).rows[0]??digitalNotFound();}
  private async facts(db:Pick<Pool,"query">,sourceId:string){return (await db.query("SELECT fact_id AS \"factId\",task_id AS \"taskId\",kind,payload,actor_id AS \"actorId\",recorded_at AS \"recordedAt\" FROM digital_development_execution_facts WHERE source_id=$1 ORDER BY sequence",[sourceId])).rows;}
  async read(actor:TrustedActorContext,sourceId:string){
    const db=await this.database.connect();
    try{
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result=await this.readSnapshot(actor,sourceId,reuseJourneySnapshotReads(db));
      await db.query("COMMIT");return result;
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  }
  private async readSnapshot(actor:TrustedActorContext,sourceId:string,db:PoolClient){
    const sheet=await this.forms().read(actor,sourceId,db);
    const dispatch=(await db.query('SELECT version,pattern_worker_id AS "patternWorkerId",cutting_worker_id AS "cuttingWorkerId",sewing_worker_id AS "sewingWorkerId" FROM digital_development_dispatch WHERE source_id=$1',[sourceId])).rows[0]??null;
    const ids=(await db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 ORDER BY created_at,task_id",[sourceId])).rows;
    const tasks=[];for(const row of ids)if(await new DigitalProductionAccessPolicy(db).allowed(actor,"task",row.task_id,"technical"))tasks.push(await this.tasks().read(actor,row.task_id,db));
    const routeFacts=(await db.query('SELECT fact_id AS "factId",task_id AS "taskId",route_version AS "routeVersion",kind,payload,recorded_at AS "recordedAt" FROM digital_development_route_facts WHERE source_id=$1 ORDER BY sequence',[sourceId])).rows;
    const patternOrder=(await db.query('SELECT order_id AS "orderId" FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0]??null;
    const patternPreparation=patternOrder&&(await db.query("SELECT to_regclass('pattern_room_rounds') AS relation")).rows[0]?.relation?(await db.query(`SELECT o.status,r.category_id IS NOT NULL AS "categorySaved",r.agreed_amount IS NOT NULL AS "priceSaved",
      o.version,r.round_id AS "roundId",r.round_type AS "roundType",s.worker_user_id AS "workerId",s.worker_name AS "workerName" FROM pattern_room_orders o JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
      LEFT JOIN LATERAL(SELECT worker_user_id,worker_name FROM pattern_room_segments WHERE round_id=r.round_id ORDER BY segment_index DESC LIMIT 1)s ON true
      WHERE o.order_id=$1 AND o.deleted_at IS NULL`,[patternOrder.orderId])).rows[0]??null:null;
    const currentRound=sheet.roundNumber??1;
    const route:string[]=currentRound===1&&sheet.document?developmentRoute(sheet.document):(await db.query('SELECT route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,currentRound])).rows[0]?.route_nodes??[];
    const nextSteps=developmentNextSteps(route,tasks,currentRound);
    const readiness=sheet.document?await materialReadiness(db,sourceId,currentRound):null;
    const supplementTask=readiness?.sewingMissing.length?tasks.filter(task=>task.routeVersion===currentRound&&task.state==="completed"&&task.canExecute&&["development_materials","development_material_recheck"].includes(task.taskKind)).at(-1):null;

    return {unifiedArrangement:await arrangementsAvailable(db),arrangement:await readArrangement(db,actor,sourceId),canConfirmExecution:isRootActor(actor)||actor.actorRoles.includes("pattern_room_supervisor"),sheet,materialReadiness:readiness?.materials??[],supplementCheckTaskId:supplementTask?.taskId??null,nextSteps,dispatch,tasks,routeFacts,patternOrder,patternPreparation,facts:await this.facts(db,sourceId),canReportFabric:isRootActor(actor)||actor.actorRoles.some(role=>["pattern_room_worker","pattern_room_supervisor","order_merchandiser"].includes(role)),canDispatch:isDigitalLeader(actor)||isDigitalTechnicalManager(actor)||actor.actorRoles.includes("development_clerk"),canDecideFabric:isRootActor(actor)||actor.actorRoles.includes("production_management")};
  }
  private async command(actor:TrustedActorContext,sourceId:string,kind:string,key:string,input:unknown,action:(db:PoolClient)=>Promise<unknown>){
    if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail("缺少操作标识");
    const db=await this.database.connect();try{await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const sheet=await this.forms().read(actor,sourceId,db);if(sheet.status!=="published")fail("开发单尚未发布");
      const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];if(lifecycle&&lifecycle.state!=="active")fail("开发单已暂停或取消");
      const command=`development-execution:${sourceId}:${kind}`,hash=createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior=(await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3",[actor.actorId,command,key])).rows[0];
      if(prior&&prior.payload_hash!==hash)fail("同一操作标识不能用于不同内容");
      const response=prior?prior.response:await action(db);
      if(!prior)await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)",[actor.actorId,command,key,hash,JSON.stringify(response)]);
      await db.query("COMMIT");return response;
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  }
  private async fact(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string|null,kind:string,payload:unknown){const id=randomUUID();await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6)",[id,sourceId,taskId,kind,JSON.stringify(payload),actor.actorId]);return id;}
  async arrange(actor:TrustedActorContext,sourceId:string,input:DevelopmentArrangementInput,key:string){
    return this.command(actor,sourceId,"arrangement",key,input,db=>saveArrangement(db,this.database,actor,sourceId,input));
  }
  async dispatch(actor:TrustedActorContext,sourceId:string,input:DevelopmentDispatch,key:string){
    if(await arrangementsAvailable(this.database))fail("人员安排已统一到本单总委派页，请从我的待办打开“安排本轮师傅”。");
    if(!isDigitalLeader(actor)&&!isDigitalTechnicalManager(actor)&&!actor.actorRoles.includes("development_clerk"))digitalForbidden();
    return this.command(actor,sourceId,"dispatch",key,input,async db=>{
      const before=(await db.query("SELECT * FROM digital_development_dispatch WHERE source_id=$1 FOR UPDATE",[sourceId])).rows[0];if((before?.version??0)!==input.expectedVersion)fail("派工已更新，请刷新");
      for(const [field,column,kind] of [
        ["patternWorkerId","pattern_worker_id","development_pattern"],
        ["cuttingWorkerId","cutting_worker_id","development_cutting"],
        ["sewingWorkerId","sewing_worker_id","development_sewing"],
      ] as const){
        const existing=(await db.query(`SELECT t.task_id,t.state,a.assignee_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
          WHERE a.source_id=$1 AND a.task_kind=$2 AND t.route_version=(SELECT max(t2.route_version) FROM digital_production_tasks t2 JOIN digital_production_task_access a2 USING(task_id) WHERE a2.source_id=$1)
          ORDER BY t.created_at DESC LIMIT 1`,[sourceId,kind])).rows[0];
        if(before?.[column]===input[field]&&(!existing||existing.assignee_id===input[field]))continue;
        if(existing&&existing.assignee_id!==input[field]&&['completed','cancelled'].includes(existing.state))fail("已结束岗位的人员安排不能改写；请保留历史人员");
        if(existing&&existing.assignee_id&&existing.assignee_id!==input[field]&&!input.reassignExisting)fail("该节点任务已派出，请明确执行岗位改派；不更改工资归属");
        if(!await new DigitalProductionAccessPolicy(db).activeRole(input[field],"pattern_room_worker"))fail("请选择有效板房工人");
        if(existing&&existing.assignee_id!==input[field])await this.tasks().reassignWithClient(db,actor,existing.task_id,input[field]);
      }
      await db.query(`INSERT INTO digital_development_dispatch(source_id,pattern_worker_id,cutting_worker_id,sewing_worker_id,changed_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(source_id) DO UPDATE SET version=digital_development_dispatch.version+1,pattern_worker_id=$2,cutting_worker_id=$3,sewing_worker_id=$4,changed_by=$5,changed_at=CURRENT_TIMESTAMP`,[sourceId,input.patternWorkerId,input.cuttingWorkerId,input.sewingWorkerId,actor.actorId]);
      if(!before){
        const pending=(await db.query(`SELECT a.task_id,a.task_kind FROM digital_production_task_access a
          JOIN digital_production_tasks t USING(task_id)
          WHERE a.source_id=$1 AND a.assignee_id IS NULL AND t.state='pending'
            AND a.task_kind IN ('development_pattern','development_cutting','development_sewing')
            AND t.route_version=(SELECT max(t2.route_version) FROM digital_production_tasks t2
              JOIN digital_production_task_access a2 USING(task_id) WHERE a2.source_id=$1)`,[sourceId])).rows;
        for(const task of pending){
          const assignee=task.task_kind==='development_pattern'?input.patternWorkerId:task.task_kind==='development_cutting'?input.cuttingWorkerId:input.sewingWorkerId;
          await this.tasks().reassignWithClient(db,actor,task.task_id,assignee);
        }
      }
      if(input.confirmExecution){
        if(!this.patternOrders)fail("打板衔接服务未配置");
        const linked=(await db.query("SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1",[sourceId])).rows[0];
        if(!linked)fail("请先提交原打板执行单");
        const person=(await db.query("SELECT person_id FROM business_people WHERE app_user_id=$1 AND active AND person_type='internal'",[input.sewingWorkerId])).rows;
        if(person.length!==1)fail("车板人员没有唯一有效的原执行身份，请核实人员资料");
        await this.patternOrders!.inTransaction(db).assign(actor,linked.order_id,{...input.confirmExecution,personId:person[0].person_id},`dispatch:${key}`);
      }
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'development_dispatch','digital_development',$4,$5)",[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify(input)]);
      return {version:input.expectedVersion+1};
    });
  }
  private async fabricReady(db:PoolClient,sourceId:string){
    const facts=await this.facts(db,sourceId);for(const report of facts.filter(f=>f.kind==="面料报告"&&f.payload.recommendation==="建议停用")){
      const decision=facts.filter(f=>f.kind==="面料决定"&&f.payload.reportId===report.factId).at(-1);
      if(decision?.payload.decision!=="允许使用")fail("问题面料须供应链总监确认允许使用");
    }
  }
  async check(actor:TrustedActorContext,sourceId:string,input:DevelopmentCheck,key:string){
    return this.command(actor,sourceId,"check",key,input,async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",input.taskId,"execute");
      const task=await this.task(db,sourceId,input.taskId);if(!["development_materials","development_material_recheck"].includes(task.task_kind)||task.state!=="ready")fail("当前不是可办理的核配任务");
      const supplemental=Boolean((await db.query("SELECT 1 FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND kind='补料复核' AND payload->>'supplemental'='true'",[sourceId,input.taskId])).rowCount);
      const sheet=await this.forms().read(actor,sourceId,db,task.route_version),document=sheet.document!;
      const required=document.materials.filter(item=>item.requiredThisRound);
      let checkedItems=input.items;
      if(input.items.some(item=>!required.some(material=>material.materialId===item.materialId)))fail("核配行不属于本轮所需材料");
      if(input.result==="通过"){
        if(!required.some(item=>item.category==="主布"))fail("请先补齐本轮主布资料，不能无主料通过");
        const prior=(await db.query(`SELECT f.payload FROM digital_development_execution_facts f
          JOIN digital_production_tasks t ON t.task_id=f.task_id
          WHERE f.source_id=$1 AND f.kind='缺项退回' AND t.route_version=$2
          ORDER BY f.sequence DESC LIMIT 1`,[sourceId,task.route_version])).rows[0]?.payload.items??[];
        checkedItems=required.map(item=>{
          const checked=input.items.find(check=>check.materialId===item.materialId)??prior.find((check:{materialId:string})=>check.materialId===item.materialId);
          const expectedDate=sheet.materialEvents.filter(event=>event.materialId===item.materialId&&event.action==="修改预计日期").at(-1)?.expectedDate??item.expectedDate;
          const error=materialCheckError(item,checked,input.note,expectedDate);if(error)fail(error);
          return checked;
        });
        await this.fabricReady(db,sourceId);
        const dispatch=(await db.query("SELECT * FROM digital_development_dispatch WHERE source_id=$1",[sourceId])).rows[0];
        if(task.route_version===1&&!supplemental){
        const pattern=await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:input.taskId,kind:"development_pattern",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:task.route_version,assigneeId:dispatch?.pattern_worker_id&&await new DigitalProductionAccessPolicy(db).activeRole(dispatch.pattern_worker_id,"pattern_room_worker")?dispatch.pattern_worker_id:null});
        await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:input.taskId,kind:"development_cutting",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:task.route_version,assigneeId:dispatch?.cutting_worker_id&&await new DigitalProductionAccessPolicy(db).activeRole(dispatch.cutting_worker_id,"pattern_room_worker")?dispatch.cutting_worker_id:null,predecessors:[pattern.taskId]});
        await this.tasks().setConditionWithClient(db,actor,pattern.taskId,"materials_ready",true,undefined);await this.tasks().setConditionWithClient(db,actor,pattern.taskId,"handover_received",true,undefined,"核配通过并交纸样");
        }
      }
      await this.fact(db,actor,sourceId,input.taskId,input.result==="通过"?"核配通过":"缺项退回",{...input,items:checkedItems});
      await this.tasks().setConditionWithClient(db,actor,input.taskId,"business_recorded",true,undefined,input.note);await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`check:${key}`);
      if(input.result==="通过"&&task.route_version>1&&!supplemental)await new DevelopmentRouteService(this.database,this.patternOrders).advance(db,actor,sourceId,input.taskId);
      if(input.result==="缺项退回"){
        await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload) VALUES($1,$2,'source',$3,'material_returned',$4,CURRENT_TIMESTAMP,'现场登记',$5)",[randomUUID(),input.taskId,sourceId,actor.actorId,JSON.stringify({note:input.note})]);
        const designer=(await db.query("SELECT created_by FROM digital_production_sources WHERE source_id=$1",[sourceId])).rows[0].created_by;
        const supply=await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:input.taskId,kind:"development_material_supply",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:Number((await db.query("SELECT GREATEST(COALESCE(max(t.occurrence),0)+1,$2::integer) AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_material_supply'",[sourceId,task.occurrence])).rows[0].n),assigneeId:await new DigitalProductionAccessPolicy(db).activeRole(designer,"sample_designer")?designer:null});
        if(supplemental)await this.fact(db,actor,sourceId,supply.taskId,"补料复核",{supplemental:true,note:"补充核验本轮材料",priorTaskId:input.taskId});
      }
      await new DevelopmentRouteService(this.database,this.patternOrders).releaseSewing(db,actor,sourceId);
      return {taskId:input.taskId,result:input.result};
    });
  }
  async supplementCheck(actor:TrustedActorContext,sourceId:string,taskId:string,key:string){
    return this.command(actor,sourceId,"supplement-check",key,{taskId},async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",taskId,"execute");
      const prior=await this.task(db,sourceId,taskId),sheet=await this.forms().read(actor,sourceId,db);
      if(!["development_materials","development_material_recheck"].includes(prior.task_kind)||prior.state!=="completed"||prior.route_version!==(sheet.roundNumber??1))fail("仅可补核当前轮已完成的核料记录");
      const unfinished=(await db.query("SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind IN ('development_pattern','development_cutting','development_sewing') AND t.state IN ('pending','ready','blocked')",[sourceId,prior.route_version])).rowCount;
      if(!unfinished)fail("本轮没有待核实材料的未完工节点");
      const existing=(await db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind IN ('development_materials','development_material_recheck','development_material_supply') AND t.state IN ('pending','ready','blocked')",[sourceId,prior.route_version])).rows[0];
      if(existing)return {taskId:existing.task_id};
      const readiness=await materialReadiness(db,sourceId,prior.route_version);
      if(!readiness.sewingMissing.length)fail("本轮材料已有有效核验，无需重复补核");
      const occurrence=Number((await db.query("SELECT GREATEST(COALESCE(max(t.occurrence),0)+1,$2::integer) AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_material_recheck'",[sourceId,prior.route_version])).rows[0].n);
      const next=await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:taskId,kind:"development_material_recheck",routeId:prior.route_instance_id,routeVersion:prior.route_version,occurrence,assigneeId:prior.assignee_id});
      await this.fact(db,actor,sourceId,next.taskId,"补料复核",{supplemental:true,note:"补充核验本轮材料",priorTaskId:taskId});
      return next;
    });
  }
  async resubmit(actor:TrustedActorContext,sourceId:string,taskId:string,key:string){
    return this.command(actor,sourceId,"resubmit",key,{taskId},async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",taskId,"execute");const task=await this.task(db,sourceId,taskId);if(task.task_kind!=="development_material_supply"||task.state!=="ready")fail("当前不是补料事项");
      const readiness=await materialReadiness(db,sourceId,task.route_version);if(readiness.supplyMissing.length)fail(`请先记录本轮所需材料实物到货：${readiness.supplyMissing.map(item=>item.name).join("、")}`);
      const clerk=(await db.query("SELECT a.assignee_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.source_id=$1 AND a.task_kind IN ('development_materials','development_material_recheck') ORDER BY t.created_at DESC LIMIT 1",[sourceId])).rows[0]?.assignee_id;
      const next=await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:taskId,kind:"development_material_recheck",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:Number((await db.query("SELECT GREATEST(COALESCE(max(t.occurrence),0)+1,$2::integer) AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_material_recheck'",[sourceId,task.occurrence+1])).rows[0].n),assigneeId:clerk&&await new DigitalProductionAccessPolicy(db).activeRole(clerk,"development_clerk")?clerk:null});
      if((await db.query("SELECT 1 FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND kind='补料复核' AND payload->>'supplemental'='true'",[sourceId,taskId])).rowCount)await this.fact(db,actor,sourceId,next.taskId,"补料复核",{supplemental:true,note:"补充核验本轮材料",priorTaskId:taskId});
      await this.fact(db,actor,sourceId,taskId,"补料复核",{nextTaskId:next.taskId});await this.tasks().setConditionWithClient(db,actor,taskId,"business_recorded",true,undefined);await this.tasks().completeWithClient(db,actor,taskId,{note:"补料后提交复核"},`resubmit:${key}`);return next;
    });
  }
  async complete(actor:TrustedActorContext,sourceId:string,input:DevelopmentWork,key:string){
    return this.command(actor,sourceId,"complete",key,input,async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",input.taskId,"execute");const task=await this.task(db,sourceId,input.taskId);
      if(!["development_pattern","development_cutting"].includes(task.task_kind)||task.state!=="ready")fail("当前任务不具备完工条件");await this.fabricReady(db,sourceId);
      const sheet=await this.forms().read(actor,sourceId,db);
      const readiness=await materialReadiness(db,sourceId,task.route_version);if(!readiness.earlyReady)fail(readiness.earlyMissing.map(item=>`${item.name}：${item.missing.join("、")}`).join("；")||"问题面料待处理");
      if(task.task_kind==='development_pattern'){
        if(!input.attachmentIds.length)fail('纸样完成前请在本单资料上传本任务成果（工艺开发板或清晰照片）');
        for(const id of input.attachmentIds)if(!(await db.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND task_id=$3 AND purpose='纸样成果'",[sourceId,id,input.taskId])).rowCount)fail('附件用途不符或不属于本轮纸样任务');
      }else await this.assertUploadPurpose(db,sourceId,input.attachmentIds,"工艺开发板");
      if(input.attachmentIds.length)await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:"工艺开发板"}))});
      await this.fact(db,actor,sourceId,input.taskId,task.task_kind==="development_pattern"?"纸样完成":"裁板完成",input);
      await this.tasks().setConditionWithClient(db,actor,input.taskId,"business_recorded",true,undefined,input.note);await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`work:${key}`);
      if(task.task_kind==="development_pattern"&&task.route_version===1){
        const next=(await db.query("SELECT d.task_id FROM digital_production_task_dependencies d JOIN digital_production_task_access a USING(task_id) WHERE d.predecessor_id=$1 AND a.task_kind='development_cutting'",[input.taskId])).rows[0];
        if(next)await this.tasks().setConditionWithClient(db,actor,next.task_id,"handover_received",true,undefined,"纸样完成并交裁板");
      }
      if(task.task_kind==="development_cutting"||(task.task_kind==="development_pattern"&&task.route_version>1))await new DevelopmentRouteService(this.database,this.patternOrders).advance(db,actor,sourceId,input.taskId);
      return {taskId:input.taskId,state:"completed"};
    });
  }
  async sendWashing(actor:TrustedActorContext,sourceId:string,taskId:string,note:string,key:string){
    return this.command(actor,sourceId,"send-washing",key,{taskId,note},async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",taskId,"execute");
      const task=await this.task(db,sourceId,taskId);if(task.task_kind!=="development_washing_dispatch"||task.state!=="ready")fail("当前不是待送洗任务");
      await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,task_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,$4,'洗水送出',$5,$6)",[randomUUID(),sourceId,taskId,task.route_version,JSON.stringify({note}),actor.actorId]);
      await this.tasks().setConditionWithClient(db,actor,taskId,"business_recorded",true,undefined,note);
      await this.tasks().completeWithClient(db,actor,taskId,{note},`send-washing:${key}`);
      await new DevelopmentRouteService(this.database,this.patternOrders).advance(db,actor,sourceId,taskId);
      return {taskId,state:"ready"};
    });
  }
  async route(actor:TrustedActorContext,sourceId:string,input:DevelopmentRouteAction,key:string){
    return this.command(actor,sourceId,"route",key,input,async db=>{await new DigitalProductionAccessPolicy(db).assert(actor,"task",input.taskId,"execute");await this.fabricReady(db,sourceId);
      const current=await this.task(db,sourceId,input.taskId);
      if(current.task_kind==='development_sewing'){
        if(!input.attachmentIds?.length)fail('车板完成前请在本单资料上传本任务实际完成照片');
        const photo=await db.query("SELECT 1 FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND mime_type IN ('image/jpeg','image/png','image/webp') AND status='ready'",[input.attachmentIds]);
        if(!photo.rowCount)fail('车板成果至少需要一张实际完成照片');
      }
      if(input.attachmentIds?.length){
        await this.authorizeSewingUpload(actor,sourceId,input.taskId,db);
        for(const attachmentId of input.attachmentIds)if(!(await db.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND purpose='车板成果' AND task_id=$3",[sourceId,attachmentId,input.taskId])).rowCount)fail("成果附件不属于本次车板任务，请核对轮次");
        const sheet=await this.forms().read(actor,sourceId,db);
        // bindFiles only establishes the original technical download binding; the
        // authoritative purpose remains 车板成果 and the route fact records task/round.
        await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:'工艺开发板'}))});
      }
      const result=await new DevelopmentRouteService(this.database,this.patternOrders).complete(db,actor,sourceId,input,key);
      if(input.result==="退回"){
        const task=await this.task(db,sourceId,input.taskId),sheet=await this.forms().read(actor,sourceId,db);
        if(!input.returnNodes?.length)fail("请选择退回的问题节点");
        await new DevelopmentRoundService(this.database,this.enabled).publishWithClient(db,actor,sourceId,{basedOnRound:task.route_version,document:sheet.document!,origin:"内部发现",customerComment:"",internalProblem:input.note,explanation:"板房尾查退回",categories:input.problemCategories?.length?input.problemCategories:["其他"],affectedNodes:input.returnNodes!,outputKind:"整件样板"},input.taskId);
      }
      return result;});
  }
  async customerSample(actor:TrustedActorContext,sourceId:string,input:{routeVersion:number;note:string},key:string){
    return this.command(actor,sourceId,"customer-sample",key,input,async db=>{
      const sheet=await this.forms().read(actor,sourceId,db);if(!sheet.canEdit)digitalForbidden();
      if(!(await db.query("SELECT 1 FROM digital_development_route_facts WHERE source_id=$1 AND route_version=$2 AND kind='最终设计确认'",[sourceId,input.routeVersion])).rowCount)fail("请先完成该轮样板的最终设计确认");
      const factId=randomUUID();await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,'客户样板确认',$4,$5) ON CONFLICT DO NOTHING",[factId,sourceId,input.routeVersion,JSON.stringify(input),actor.actorId]);
      await new BulkPreparationService(this.database).syncSource(db,actor,sourceId);
      return {sourceId,routeVersion:input.routeVersion,customerSampleConfirmed:true};
    });
  }
  async patternOrder(actor:TrustedActorContext,sourceId:string,input:{categoryId:string;priceVersion:number},key:string){
    return this.command(actor,sourceId,"pattern-order",key,input,async db=>{
      if(!this.patternOrders)fail("打板衔接服务未配置");
      const order=await this.patternOrders!.inTransaction(db).createDevelopment(actor,sourceId,input.categoryId,input.priceVersion,`development:${key}`);
      return {orderId:order.orderId};
    });
  }
  async report(actor:TrustedActorContext,sourceId:string,input:{recommendation:string;note:string;attachmentIds:string[]},key:string){
    if(!isRootActor(actor)&&!actor.actorRoles.some(role=>["pattern_room_worker","pattern_room_supervisor","order_merchandiser"].includes(role)))digitalForbidden();
    return this.command(actor,sourceId,"fabric-report",key,input,async db=>{const sheet=await this.forms().read(actor,sourceId,db);await this.assertUploadPurpose(db,sourceId,input.attachmentIds,"面料报告");await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:"菲林"}))});const reportId=await this.fact(db,actor,sourceId,null,"面料报告",input);await new DevelopmentRouteService(this.database,this.patternOrders).releaseSewing(db,actor,sourceId);return {reportId};});
  }
  async decideFabric(actor:TrustedActorContext,sourceId:string,input:{reportId:string;decision:string;note:string},key:string){
    if(!isRootActor(actor)&&!actor.actorRoles.includes("production_management"))digitalForbidden();
    return this.command(actor,sourceId,"fabric-decision",key,input,async db=>{const reports=(await this.facts(db,sourceId)).filter(f=>f.kind==="面料报告");const report=reports.find(f=>f.factId===input.reportId);if(!report)fail("面料报告不存在");if(report!.payload.recommendation!=="建议停用")fail("正常面料不需要总监审批");const factId=await this.fact(db,actor,sourceId,null,"面料决定",input);await new DevelopmentRouteService(this.database,this.patternOrders).releaseSewing(db,actor,sourceId);return {factId};});
  }
  private async assertUploadPurpose(db:Pick<Pool,"query">,sourceId:string,ids:string[],purpose:"工艺开发板"|"面料报告"){
    for(const attachmentId of ids)if(!(await db.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND purpose=$3",[sourceId,attachmentId,purpose])).rowCount)fail(`附件用途不符，请在${purpose}栏重新上传`);
  }
  async authorizeSewingUpload(actor:TrustedActorContext,sourceId:string,taskId:string,db:Pick<Pool,"query">=this.database,kind='development_sewing'){
    await new DigitalProductionAccessPolicy(db).assert(actor,'task',taskId,'execute');
    const task=(await db.query("SELECT t.state,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE task_id=$1 AND source_id=$2",[taskId,sourceId])).rows[0];
    if(!task||task.task_kind!==kind||task.state!=='ready')fail('当前任务不具备成果上传条件');
  }
  async recordUploadPurpose(actor:TrustedActorContext,sourceId:string,attachmentId:string,purpose:"工艺开发板"|"面料报告"|"车板成果"|"纸样成果",taskId?:string){
    await this.authorizeUpload(actor,sourceId);
    if(purpose==='车板成果'||purpose==='纸样成果'){if(!taskId)fail('成果缺少任务');await this.authorizeSewingUpload(actor,sourceId,taskId!,this.database,purpose==='纸样成果'?'development_pattern':'development_sewing');}else if(taskId)fail('附件用途与任务不符');
    const result=await this.database.query("INSERT INTO digital_development_upload_purposes(attachment_id,source_id,purpose,uploaded_by,task_id) SELECT attachment_id,$2,$3,$4,$5 FROM attachments WHERE attachment_id=$1 AND uploaded_by=$4 AND entity_type IS NULL ON CONFLICT DO NOTHING RETURNING attachment_id",[attachmentId,sourceId,purpose,actor.actorId,taskId??null]);
    if(!result.rowCount)fail("上传用途登记失败，请重新上传");
  }
  async authorizeFinalize(actor:TrustedActorContext,sourceId:string,attachmentId:string){
    await this.authorizeUpload(actor,sourceId);
    if(!(await this.database.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND uploaded_by=$3",[sourceId,attachmentId,actor.actorId])).rowCount)digitalForbidden();
  }
  async authorizeUpload(actor:TrustedActorContext,sourceId:string){await this.forms().read(actor,sourceId);if(!isRootActor(actor)&&!actor.actorRoles.some(role=>["pattern_room_worker","pattern_room_supervisor","order_merchandiser"].includes(role)))digitalForbidden();}
}
