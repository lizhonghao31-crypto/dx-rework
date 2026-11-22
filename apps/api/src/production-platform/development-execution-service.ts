import {readMaterialRecheckBasis} from "./development-material-check-rules.js";
import {assembleQuotation} from './quotation-assembly.js';
import {readDevelopmentExecutionSnapshot} from "./development-execution-read.js";
import {businessNow} from '../acceptance-clock/business-time.js';
import {developmentOccurrence} from './development-occurrence.js';
import {publishedTechnicalArtifact,technicalEnrollment,technicalDocumentFingerprint} from './development-technical-repository.js';
import {DevelopmentTechnicalService} from './development-technical-service.js';
import type {DevelopmentUploadPurpose} from '@dx-rework/contracts/digital-development-technical';
import { externalPatternRecords, recordExternalPatternFact } from "./development-external-pattern-facts.js";
import {reopenDevelopmentMaterials,assertReopenedReturnIssues} from './development-material-reopen.js';
import type {DevelopmentExternalPattern,ReopenDevelopmentMaterials,DevelopmentCustomerSample} from '@dx-rework/contracts/digital-development-execution';
import {developmentAutomaticRoundDocument} from './development-document-format.js';
import {validateExecutionTransfer} from './development-execution-transfer.js';
import type {DevelopmentExecutionTransfer} from '@dx-rework/contracts/development-arrangement';
import {developmentAmendmentsAvailable} from "./development-amendment-repository.js";
import {validateDevelopmentReturn,recordDevelopmentReturn,submitDevelopmentSupply} from "./development-supply.js";
import {assertMaterialChecks,readMaterialVerification,saveMaterialVerification} from "./development-material-verification.js";
import type {SaveMaterialVerification} from "@dx-rework/contracts/digital-development-execution";
import type {DevelopmentArrangementInput} from "@dx-rework/contracts/development-arrangement";
import {saveArrangement,arrangementsAvailable} from "./development-arrangement.js";
import {reuseJourneySnapshotReads} from "./journey-snapshot-reads.js";
import {materialReadiness,materialCheckError} from "./development-material-readiness.js";
import {developmentSlaPlan} from "./development-sla-enrollment.js";
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
import {fixedDevelopmentCutter,saveFixedDevelopmentCutter} from "./development-fixed-cutting.js";
const fail=(message:string):never=>{throw new ApplicationError("DEVELOPMENT_EXECUTION_CONFLICT",message,409);};
export class DevelopmentExecutionService {
  constructor(private readonly database:Pool,private readonly enabled:boolean,private readonly patternOrders?:PatternRoomOrderService,private readonly previewSecret?:string){}
  technicalEvidenceService(){return new DevelopmentTechnicalService(this.database,this.enabled,this.previewSecret,this.patternOrders);}
  private forms(){return new DigitalDevelopmentService(this.database,this.enabled);}
  private tasks(){return new DigitalProductionTaskService(this.database);}
  private async task(db:PoolClient,sourceId:string,taskId:string){return (await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2",[sourceId,taskId])).rows[0]??digitalNotFound();}
  private async facts(db:Pick<Pool,"query">,sourceId:string){return (await db.query("SELECT fact_id AS \"factId\",task_id AS \"taskId\",kind,payload,actor_id AS \"actorId\",recorded_at AS \"recordedAt\" FROM digital_development_execution_facts WHERE source_id=$1 ORDER BY sequence",[sourceId])).rows;}
  async read(actor:TrustedActorContext,sourceId:string){
    const db=await this.database.connect();
    try{
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result=await readDevelopmentExecutionSnapshot(reuseJourneySnapshotReads(db),actor,sourceId,{
        readSheet:(readerActor,id,client)=>this.forms().read(readerActor,id,client),
        readTasks:async(readerActor,ids,client)=>[...(await this.tasks().readPage(readerActor,ids,client)).values()],
        readTechnical:(readerActor,id,round,scope,client)=>new DevelopmentTechnicalService(this.database,this.enabled).read(readerActor,id,round,scope,client),
        readFacts:(client,id)=>this.facts(client,id),
      });
      await db.query("COMMIT");return result;
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  }
  private async command(actor:TrustedActorContext,sourceId:string,kind:string,key:string,input:unknown,action:(db:PoolClient)=>Promise<unknown>){
    if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail("缺少操作标识");
    const db=await this.database.connect();try{await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const sheet=await this.forms().read(actor,sourceId,db);if(sheet.status!=="published")fail("开发单尚未发布");
      const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];if(lifecycle&&lifecycle.state!=="active")fail("开发单已暂停或取消");
      if(kind==='reopen-materials'){
        const policy=new DigitalProductionAccessPolicy(db);
        if(!isRootActor(actor)&&(!actor.actorRoles.includes('development_clerk')||!await policy.lockActiveRole(actor.actorId,'development_clerk')))digitalForbidden();
        await policy.assert(actor,'task',(input as ReopenDevelopmentMaterials).taskId,'execute');
      }
      const command=`development-execution:${sourceId}:${kind}`,hash=createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior=(await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3",[actor.actorId,command,key])).rows[0];
      if(prior&&prior.payload_hash!==hash)fail("同一操作标识不能用于不同内容");
      const response=prior?prior.response:await action(db);
      if(!prior)await assembleQuotation(db,sourceId,actor.actorId);
      if(!prior)await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)",[actor.actorId,command,key,hash,JSON.stringify(response)]);
      await db.query("COMMIT");return response;
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  }
  private async fact(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string|null,kind:string,payload:unknown){const id=randomUUID();await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6)",[id,sourceId,taskId,kind,JSON.stringify(payload),actor.actorId]);return id;}
  async arrange(actor:TrustedActorContext,sourceId:string,input:DevelopmentArrangementInput,key:string){
    return this.command(actor,sourceId,"arrangement",key,input,db=>saveArrangement(db,this.database,actor,sourceId,input));
  }
  async configureFixedCutting(actor:TrustedActorContext,sourceId:string,input:{expectedVersion:number;assigneeId:string;reason:string},key:string){
    return this.command(actor,sourceId,"fixed-cutting",key,input,async db=>{
      if(!await developmentSlaPlan(db,sourceId))fail('此历史开发单保留原人员安排方式');
      const result=await saveFixedDevelopmentCutter(db,actor,input);
      for(const taskId of result.affected)await this.tasks().reassignWithClient(db,actor,taskId,input.assigneeId);
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'development_fixed_cutting_changed','digital_development',$4,$5)",[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify({...input,...result})]);
      return {version:result.version,assignedTasks:result.affected.length};
    });
  }
  async readNativeExecution(actor:TrustedActorContext,sourceId:string,client?:PoolClient){
    if(!this.enabled)digitalForbidden();await this.forms().read(actor,sourceId,client);
    if(!this.patternOrders)fail('原执行服务尚未配置，请管理员核实版本');
    const link=(await (client??this.database).query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0]??digitalNotFound();
    // The original reader keeps its own scope, cost/technical filtering and actions.
    return (client?this.patternOrders!.inTransaction(client):this.patternOrders!).get(actor,link.order_id);
  }
  async transferExecution(actor:TrustedActorContext,sourceId:string,input:DevelopmentExecutionTransfer,key:string){
    return this.command(actor,sourceId,'transfer-execution',key,input,async db=>{
      if(!this.patternOrders)fail('原执行服务尚未配置，请管理员核实版本');
      await validateExecutionTransfer(db,actor,sourceId,input);
      const {orderId,version,roundId,segmentId,personId,amount,reason}=input;
      return this.patternOrders!.inTransaction(db).transfer(actor,orderId,{version,roundId,segmentId,personId,amount,reason},`development-transfer:${createHash('sha256').update(JSON.stringify([sourceId,key])).digest('hex')}`);
    });
  }
  async transferExecutionReceipt(actor:TrustedActorContext,sourceId:string,key:string){
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少原操作标识，请从本次换人页核对');
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const current=await this.readNativeExecution(actor,sourceId,db);
      const row=(await db.query('SELECT response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,`development-execution:${sourceId}:transfer-execution`,key])).rows[0];
      await db.query('COMMIT');return {receipt:row?current:null,committedVersion:row?.response?.version??null};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async dispatch(actor:TrustedActorContext,sourceId:string,input:DevelopmentDispatch,key:string){
    if(await arrangementsAvailable(this.database))fail("人员安排已统一到本单总委派页，请从我的待办打开“安排本轮师傅”。");
    if(!isDigitalLeader(actor)&&!isDigitalTechnicalManager(actor)&&!actor.actorRoles.includes("development_clerk"))digitalForbidden();
    return this.command(actor,sourceId,"dispatch",key,input,async db=>{
      if(await developmentSlaPlan(db,sourceId)){
        const fixed=await fixedDevelopmentCutter(db);
        if(!fixed?.valid||input.cuttingWorkerId!==fixed.assigneeId)fail('开发裁板使用固定人员，请先设置有效固定岗位，不逐单分派');
      }
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
      if(decision?.payload.decision!=="允许使用")fail(`问题面料：${report.payload.note}。${decision?.payload.decision==="停止使用"?"已决定停止使用，不能以核料勾选或到料放行":"尚未作出使用决定"}。请供应链总监或 Root 在本页“问题面料报告与决定”核实并记录明确决定；文员随后继续核料。`);
    }
  }
  async saveMaterials(actor:TrustedActorContext,sourceId:string,input:Omit<SaveMaterialVerification,"note"|"result">&{note?:string;result?:string},key:string){
    return this.command(actor,sourceId,"material-verification",key,input,async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",input.taskId,"execute");
      const task=await this.task(db,sourceId,input.taskId),sheet=await this.forms().read(actor,sourceId,db);
      if(!["development_materials","development_material_recheck"].includes(task.task_kind)||task.state!=="ready"||task.route_version!==(sheet.roundNumber??1))fail("仅当前轮可办理的核料任务可以保存文员确认");
      return saveMaterialVerification(db,actor,sourceId,task.route_version,sheet.document!,sheet.version,input);
    });
  }
  async check(actor:TrustedActorContext,sourceId:string,input:DevelopmentCheck,key:string){
    return this.command(actor,sourceId,"check",key,input,async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",input.taskId,"execute");
      const task=await this.task(db,sourceId,input.taskId);if(!["development_materials","development_material_recheck"].includes(task.task_kind)||task.state!=="ready")fail("当前不是可办理的核配任务");
      const sheet=await this.forms().read(actor,sourceId,db,task.route_version),document=sheet.document!;
      const {supplemental,receiptMaterialIds,receiptVersionChanged}=await readMaterialRecheckBasis(db,sourceId,task.route_version,input.taskId,sheet.version);
      if(receiptVersionChanged)fail("退回补料所对应的资料版本已变化，请核对当前正式资料");
      const verification=await readMaterialVerification(db,sourceId,task.route_version,document,sheet.version,input.taskId);
      if(verification){
        assertMaterialChecks(verification,verification.entries);
        if(!verification.version||input.expectedVerificationVersion!==verification.version)fail("请先保存本轮材料使用确认，再提交核料结果；已有记录不会被覆盖");
        if(verification.taskId!==input.taskId)fail("请在当前复核任务保存确认结果后再提交");
        if(verification.entries.some(row=>row.usage==="pending"||row.invalidated.length))fail("尚有材料使用情况或变更项待文员确认，请在本页逐项核实并保存");
        if(input.items.some(row=>{const saved=verification.entries.find(m=>m.materialId===row.materialId);return !saved||saved.usage!=="use"||["physical","quantity","color","specification"].some(k=>row[k as keyof typeof row]!==saved[k as keyof typeof saved]);}))fail("核验输入与已保存结果不一致，请先保存本页输入");
      }
      const required=document.materials.filter(item=>verification?verification.entries.some(row=>row.materialId===item.materialId&&row.usage==="use"):item.requiredThisRound);
      if(verification&&input.items.length!==required.length)fail("请提交每一项本轮使用材料的已保存核验结果");
      let checkedItems=input.items;
      if(input.items.some(item=>!required.some(material=>material.materialId===item.materialId)))fail("核配行不属于本轮所需材料");
      const retainedIssues=await assertReopenedReturnIssues(db,sourceId,input.taskId,input);
      if(await developmentAmendmentsAvailable(db))validateDevelopmentReturn(document,input,retainedIssues);
      if(input.result==="通过"){
        if(verification&&required.some(item=>!item.name.trim()))fail("本轮使用材料缺少品名，请设计师在本单资料补齐后由文员复核");
        if(!required.some(item=>item.category==="主布"))fail("请先补齐本轮主布资料，不能无主料通过");
        if(receiptMaterialIds.some(id=>!input.items.some(item=>item.materialId===id&&item.physical&&item.quantity&&item.color&&item.specification)))
          fail("退回补料须由文员逐项核实实到及相符后才能提交通过");
        const prior=(await db.query(`SELECT f.payload FROM digital_development_execution_facts f
          JOIN digital_production_tasks t ON t.task_id=f.task_id
          WHERE f.source_id=$1 AND f.kind='缺项退回' AND t.route_version=$2
          ORDER BY f.sequence DESC LIMIT 1`,[sourceId,task.route_version])).rows[0]?.payload.items??[];
        const clerkReceiptRequired=Boolean(await developmentSlaPlan(db,sourceId));
        checkedItems=required.map(item=>{
          const checked=input.items.find(check=>check.materialId===item.materialId)??prior.find((check:{materialId:string})=>check.materialId===item.materialId);
          const expectedDate=sheet.materialEvents.filter(event=>event.materialId===item.materialId&&event.action==="修改预计日期").at(-1)?.expectedDate??item.expectedDate;
          const error=materialCheckError(item,checked,input.note,expectedDate,clerkReceiptRequired);if(error)fail(error);
          return checked;
        });
        await this.fabricReady(db,sourceId);
        const dispatch=(await db.query("SELECT * FROM digital_development_dispatch WHERE source_id=$1",[sourceId])).rows[0];
        const fixedCutter=clerkReceiptRequired?await fixedDevelopmentCutter(db):null;
        if(task.route_version===1&&!supplemental){
        const pattern=await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:input.taskId,kind:"development_pattern",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:task.route_version,predecessors:[input.taskId],assigneeId:dispatch?.pattern_worker_id&&await new DigitalProductionAccessPolicy(db).activeRole(dispatch.pattern_worker_id,"pattern_room_worker")?dispatch.pattern_worker_id:null});
        await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:input.taskId,kind:"development_cutting",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:task.route_version,assigneeId:clerkReceiptRequired?(fixedCutter?.valid?fixedCutter.assigneeId:null):dispatch?.cutting_worker_id&&await new DigitalProductionAccessPolicy(db).activeRole(dispatch.cutting_worker_id,"pattern_room_worker")?dispatch.cutting_worker_id:null,predecessors:[pattern.taskId]});
        await this.tasks().setConditionWithClient(db,actor,pattern.taskId,"materials_ready",true,undefined);await this.tasks().setConditionWithClient(db,actor,pattern.taskId,"handover_received",true,undefined,"核配通过并交纸样");
        }
      }
      if(verification)await db.query("UPDATE digital_development_material_verifications SET applied_entries=entries WHERE source_id=$1 AND round_number=$2",[sourceId,task.route_version]);
      await this.fact(db,actor,sourceId,input.taskId,input.result==="通过"?"核配通过":"缺项退回",{...input,items:checkedItems});
      await this.tasks().setConditionWithClient(db,actor,input.taskId,"business_recorded",true,undefined,input.note);await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`check:${key}`);
      if(input.result==="通过"&&task.route_version>1&&!supplemental)await new DevelopmentRouteService(this.database,this.patternOrders).advance(db,actor,sourceId,input.taskId);
      if(input.result==="缺项退回"){
        await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload) VALUES($1,$2,'source',$3,'material_returned',$4,$6,'现场登记',$5)",[randomUUID(),input.taskId,sourceId,actor.actorId,JSON.stringify({note:input.note}),businessNow().toISOString()]);
        const designer=(await db.query("SELECT created_by FROM digital_production_sources WHERE source_id=$1",[sourceId])).rows[0].created_by;
        const supply=await this.tasks().createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:input.taskId,kind:"development_material_supply",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:Number((await db.query("SELECT GREATEST(COALESCE(max(t.occurrence),0)+1,$2::integer) AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_material_supply'",[sourceId,task.occurrence])).rows[0].n),assigneeId:await new DigitalProductionAccessPolicy(db).activeRole(designer,"sample_designer")?designer:null});
        if(await developmentAmendmentsAvailable(db))await recordDevelopmentReturn(db,actor,sourceId,supply.taskId,input.taskId,sheet.version,input);
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
  async reopenMaterials(actor:TrustedActorContext,sourceId:string,input:ReopenDevelopmentMaterials,key:string){
    return this.command(actor,sourceId,"reopen-materials",key,input,async db=>{
      const sheet=await this.forms().read(actor,sourceId,db);
      return reopenDevelopmentMaterials(db,this.database,actor,sourceId,input,{roundNumber:sheet.roundNumber??1,version:sheet.version});
    });
  }
  async resubmit(actor:TrustedActorContext,sourceId:string,taskId:string,key:string){
    return this.command(actor,sourceId,"resubmit",key,{taskId},async db=>{
      return submitDevelopmentSupply(db,this.database,actor,sourceId,taskId,key);
    });
  }
  async complete(actor:TrustedActorContext,sourceId:string,input:DevelopmentWork,key:string){
    return this.command(actor,sourceId,"complete",key,input,async db=>{
      await new DigitalProductionAccessPolicy(db).assert(actor,"task",input.taskId,"execute");const task=await this.task(db,sourceId,input.taskId);
      if(!["development_pattern","development_cutting"].includes(task.task_kind)||task.state!=="ready")fail("当前任务不具备完工条件");await this.fabricReady(db,sourceId);
      const sheet=await this.forms().read(actor,sourceId,db);
      const readiness=await materialReadiness(db,sourceId,task.route_version);if(!readiness.earlyReady)fail(readiness.earlyMissing.map(item=>`${item.name}：${item.missing.join("、")}`).join("；")||"问题面料待处理");
      if(task.task_kind==='development_pattern'){
        if(await technicalEnrollment(db,sourceId)){
          const ref=input.artifactRef,artifact=await publishedTechnicalArtifact(db,sourceId,task.route_version,ref?.scopeRef??'整款')??fail('请先发布本任务PLT、结构单件用量和基码尺寸表');
          if(!ref||artifact.artifact.artifactSetId!==ref.id||artifact.artifact.version!==ref.version||artifact.artifact.taskId!==input.taskId)fail('纸样完成须引用本任务已发布的PLT、结构单件用量和基码尺寸表');
          if(artifact.row.document_fingerprint!==technicalDocumentFingerprint(sheet.document!))fail('开发技术依据已改变，请先核对并发布新的三件套');
          const ready=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready' AND mime_type='application/octet-stream'",[artifact.artifact.body.pltAttachmentIds])).rows[0].n;
          if(ready!==artifact.artifact.body.pltAttachmentIds.length||!ready)fail('PLT纸样原件尚未就绪');
          if(input.attachmentIds.length)fail('纸样原件沿成果组引用，无需在完成操作再次上传');
        }else{
          if(!input.attachmentIds.length)fail('纸样完成前请在本单资料上传本任务成果（工艺开发板或清晰照片）');
          for(const id of input.attachmentIds)if(!(await db.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND task_id=$3 AND purpose='纸样成果'",[sourceId,id,input.taskId])).rowCount)fail('附件用途不符或不属于本轮纸样任务');
        }
      }else await this.assertUploadPurpose(db,sourceId,input.attachmentIds,"工艺开发板");
      if(input.attachmentIds.length)await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:"工艺开发板"}))});
      await this.fact(db,actor,sourceId,input.taskId,task.task_kind==="development_pattern"?"纸样完成":"裁板完成",input);
      await this.tasks().setConditionWithClient(db,actor,input.taskId,"business_recorded",true,undefined,input.note);await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`work:${key}`);
      if(task.task_kind==='development_pattern')await new DevelopmentTechnicalService(this.database,this.enabled).ensurePositionWithClient(db,actor,sourceId,input.taskId);
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
      if(input.making&&(current.task_kind!=='development_tail_check'||input.result!=='退回'))fail('各码数量升级仅用于本次尾查退回；其他实际修改请从复版资料办理');
      const tailEvidence=current.task_kind==='development_tail_check'&&Boolean(await developmentSlaPlan(db,sourceId));
      const craftEvidence=['development_printing','development_embroidery','development_print_embroidery'].includes(current.task_kind)&&Boolean(await technicalEnrollment(db,sourceId));
      if(craftEvidence){
        if(!input.attachmentIds?.length)fail('请由本任务内部工艺负责人员上传实际回样照片，设计确认后才衔接车板');
        const count=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready' AND mime_type IN ('image/jpeg','image/png','image/webp')",[input.attachmentIds])).rows[0].n;
        if(count!==input.attachmentIds!.length)fail('工艺回样须为已就绪实际照片');
        await new DevelopmentTechnicalService(this.database,this.enabled).bindTechnicalFiles(db,actor,sourceId,input.attachmentIds!,'工艺回样照片',input.taskId);
      }
      if(current.task_kind==='development_sewing'||tailEvidence){
        if(!input.attachmentIds?.length)fail(tailEvidence?'尾查提交前请上传本任务实际照片':'车板完成前请在本单资料上传本任务实际完成照片');
        const photo=await db.query("SELECT 1 FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND mime_type IN ('image/jpeg','image/png','image/webp') AND status='ready'",[input.attachmentIds]);
        if(!photo.rowCount)fail(tailEvidence?'尾查至少需要一张实际照片':'车板成果至少需要一张实际完成照片');
      }
      if(input.attachmentIds?.length&&!craftEvidence){
        await this.authorizeSewingUpload(actor,sourceId,input.taskId,db,tailEvidence?'development_tail_check':'development_sewing');
        for(const attachmentId of input.attachmentIds)if(!(await db.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND purpose=$4 AND task_id=$3",[sourceId,attachmentId,input.taskId,tailEvidence?'尾查照片':'车板成果'])).rowCount)fail("成果附件不属于本次任务，请核对轮次");
        const sheet=await this.forms().read(actor,sourceId,db);
        // bindFiles only establishes the original technical download binding; the
        // authoritative purpose remains 车板成果 and the route fact records task/round.
        await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:'工艺开发板'}))});
      }
      const result=await new DevelopmentRouteService(this.database,this.patternOrders).complete(db,actor,sourceId,input,key);
      if(input.result==="退回"){
        const task=await this.task(db,sourceId,input.taskId),sheet=await this.forms().read(actor,sourceId,db);
        if(!input.returnNodes?.length)fail("请选择退回的问题节点");
        if(await technicalEnrollment(db,sourceId)){
          await db.query(`INSERT INTO digital_development_patch_issues(issue_id,source_id,round_number,tail_task_id,payload,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),sourceId,task.route_version,input.taskId,JSON.stringify(input),actor.actorId,businessNow().toISOString()]);
        }else await new DevelopmentRoundService(this.database,this.enabled,this.patternOrders).publishWithClient(db,actor,sourceId,{basedOnRound:task.route_version,document:developmentAutomaticRoundDocument(sheet.document!,sheet.version,input.making),origin:"内部发现",customerComment:"",internalProblem:input.note,explanation:"板房尾查退回",categories:input.problemCategories?.length?input.problemCategories:["其他"],affectedNodes:input.returnNodes!,outputKind:"整件样板"},input.taskId);
      }
      return result;});
  }
  async customerSample(actor:TrustedActorContext,sourceId:string,input:DevelopmentCustomerSample,key:string){
    return this.command(actor,sourceId,"customer-sample",key,input,async db=>{
      if(await technicalEnrollment(db,sourceId))fail('请在本单“客户最终评语”登记并发起尺寸复核；历史确认入口不能跳过新复核');
      const sheet=await this.forms().read(actor,sourceId,db);if(!sheet.canEdit)digitalForbidden();
      if((sheet.roundNumber??1)!==input.routeVersion)fail('开发轮次已更新，请刷新当前轮次后确认客户样板');
      if(!(await db.query("SELECT 1 FROM digital_development_route_facts WHERE source_id=$1 AND route_version=$2 AND kind='最终设计确认'",[sourceId,input.routeVersion])).rowCount)fail("请先完成该轮样板的最终设计确认");
      const occurrence=developmentOccurrence(input.actualTime,businessNow());
      const factId=randomUUID();await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,'客户样板确认',$4,$5) ON CONFLICT DO NOTHING",[factId,sourceId,input.routeVersion,JSON.stringify({...input,...occurrence}),actor.actorId]);
      await new BulkPreparationService(this.database).syncSource(db,actor,sourceId);
      return {sourceId,routeVersion:input.routeVersion,customerSampleConfirmed:true};
    });
  }
  async authorizeExternalPattern(actor:TrustedActorContext,sourceId:string,db:Pick<Pool,"query">=this.database){
    await this.forms().read(actor,sourceId,db);
    if(!isRootActor(actor)&&(!actor.actorRoles.includes('pattern_room_supervisor')||!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'pattern_room_supervisor')))digitalForbidden();
  }
  async externalPattern(actor:TrustedActorContext,sourceId:string,input:DevelopmentExternalPattern,key:string){
    return this.command(actor,sourceId,'external-pattern',key,input,async db=>{
      await this.authorizeExternalPattern(actor,sourceId,db);
      if(!await developmentSlaPlan(db,sourceId))fail('历史开发单保留原办理记录');
      const sheet=await this.forms().read(actor,sourceId,db),round=sheet.roundNumber??1;
      if(input.action==='request'){
        if(input.roundNumber!==round)fail('开发轮次已变化，请刷新');
        if((await externalPatternRecords(db,sourceId)).some(r=>r.roundNumber===round&&!r.receivedAt))fail('本轮已经记录请求，请继续跟进原任务');
        const requestId=randomUUID(),now=businessNow().toISOString();
        await recordExternalPatternFact(db,actor,sourceId,requestId,'external_pattern_requested',now,{requestId,roundNumber:round,note:input.note});
        const occurrence=Number((await db.query("SELECT COALESCE(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.node_key='development_external_pattern'",[sourceId])).rows[0].n);
        const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'source',id:sourceId},kind:'development_external_pattern',routeId:requestId,routeVersion:round,occurrence,
          assigneeId:await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'pattern_room_supervisor')?actor.actorId:null});
        return {requestId,taskId:task.taskId};
      }
      const request=(await externalPatternRecords(db,sourceId)).find(r=>r.requestId===input.requestId)??digitalNotFound();
      if(request.roundNumber!==round)fail('请在当前轮次记录收到；旧轮记录保持历史');
      if(request.receivedAt)fail('本轮纸样已经记录收到');
      if(!request.taskId)digitalNotFound();
      await new DigitalProductionAccessPolicy(db).assert(actor,'task',request.taskId!,'execute');
      await this.assertUploadPurpose(db,sourceId,input.attachmentIds,'外部纸样');
      await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:'工艺开发板'}))});
      const now=businessNow().toISOString();
      if(Date.parse(now)<new Date(request.requestedAt).getTime())fail('收到时间不能早于请求时间');
      await recordExternalPatternFact(db,actor,sourceId,randomUUID(),'external_pattern_received',now,{requestId:input.requestId,roundNumber:round,attachmentIds:input.attachmentIds,note:input.note});
      await this.tasks().setConditionWithClient(db,actor,request.taskId!,'business_recorded',true,undefined,input.note);
      await this.tasks().completeWithClient(db,actor,request.taskId!,{note:input.note},`external:${key}`);
      return {requestId:input.requestId,taskId:request.taskId!};
    });
  }
  async patternOrder(actor:TrustedActorContext,sourceId:string,input:{categoryId:string;priceVersion:number},key:string){
    return this.command(actor,sourceId,"pattern-order",key,input,async db=>{
      if(!this.patternOrders)fail("打板衔接服务未配置");
      const order=await this.patternOrders!.inTransaction(db).createDevelopment(actor,sourceId,input.categoryId,input.priceVersion,`development:${key}`);
      return {orderId:order.orderId};
    });
  }
  async report(actor:TrustedActorContext,sourceId:string,input:{recommendation:string;note:string;attachmentIds:string[];materialIds?:string[]|undefined},key:string){
    if(!isRootActor(actor)&&!actor.actorRoles.some(role=>["pattern_room_worker","pattern_room_supervisor","order_merchandiser"].includes(role)))digitalForbidden();
    return this.command(actor,sourceId,"fabric-report",key,input,async db=>{const sheet=await this.forms().read(actor,sourceId,db);await this.assertUploadPurpose(db,sourceId,input.attachmentIds,"面料报告");await this.forms().bindFiles(db,actor,sourceId,{...sheet.document!,files:input.attachmentIds.map(attachmentId=>({attachmentId,kind:"菲林"}))});if((await db.query("SELECT to_regclass('digital_development_material_verifications') AS relation")).rows[0]?.relation&&!input.materialIds?.length)fail("请选择本报告涉及的材料；旧报告原样保留，不能推定范围");if(input.materialIds?.some(id=>!sheet.document!.materials.some(m=>m.materialId===id)))fail("报告材料不属于本单资料");const reportId=await this.fact(db,actor,sourceId,null,"面料报告",{...input,scope:input.materialIds?{roundNumber:sheet.roundNumber??1,documentVersion:sheet.version,materials:sheet.document!.materials.filter(m=>input.materialIds!.includes(m.materialId))}:null});await new DevelopmentRouteService(this.database,this.patternOrders).releaseSewing(db,actor,sourceId);return {reportId};});
  }
  async decideFabric(actor:TrustedActorContext,sourceId:string,input:{reportId:string;decision:string;note:string;expectedDecisionId?:string|null|undefined},key:string){
    if(!isDigitalLeader(actor))digitalForbidden();
    return this.command(actor,sourceId,"fabric-decision",key,input,async db=>{if(!isRootActor(actor)){let allowed=false;for(const role of ["production_management","owner_group"])if(actor.actorRoles.includes(role)&&await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,role))allowed=true;if(!allowed)digitalForbidden();}const reports=(await this.facts(db,sourceId)).filter(f=>f.kind==="面料报告");const report=reports.find(f=>f.factId===input.reportId);if(!report)fail("面料报告不存在");if(report!.payload.recommendation!=="建议停用")fail("正常面料不需要总监审批");const latest=(await this.facts(db,sourceId)).filter(f=>f.kind==="面料决定"&&f.payload.reportId===input.reportId).at(-1);
      if(input.expectedDecisionId!==undefined&&input.expectedDecisionId!==(latest?.factId??null))fail("该报告已有新的决定，请重新读取后核实，未覆盖原决定");
      if(input.expectedDecisionId===undefined&&(await db.query("SELECT to_regclass('digital_development_material_verifications') AS relation")).rows[0]?.relation)fail("请重新打开报告决定，核实当前决定版本后提交");
      const factId=await this.fact(db,actor,sourceId,null,"面料决定",input);await new DevelopmentRouteService(this.database,this.patternOrders).releaseSewing(db,actor,sourceId);return {factId};});
  }
  private async assertUploadPurpose(db:Pick<Pool,"query">,sourceId:string,ids:string[],purpose:"工艺开发板"|"面料报告"|"外部纸样"){
    for(const attachmentId of ids)if(!(await db.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND purpose=$3",[sourceId,attachmentId,purpose])).rowCount)fail(`附件用途不符，请在${purpose}栏重新上传`);
  }
  async authorizeSewingUpload(actor:TrustedActorContext,sourceId:string,taskId:string,db:Pick<Pool,"query">=this.database,kind:string|readonly string[]='development_sewing'){
    await new DigitalProductionAccessPolicy(db).assert(actor,'task',taskId,'execute');
    const task=(await db.query("SELECT t.state,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE task_id=$1 AND source_id=$2",[taskId,sourceId])).rows[0];
    if(!task||!(typeof kind==='string'?[kind]:kind).includes(task.task_kind)||task.state!=='ready')fail('当前任务不具备成果上传条件');
  }
  async authorizeResultPurpose(actor:TrustedActorContext,sourceId:string,purpose:DevelopmentUploadPurpose,taskId?:string){
    const kinds:Partial<Record<DevelopmentUploadPurpose,string[]>>={'车板成果':['development_sewing'],'纸样成果':['development_pattern','development_size_review'],
      '尾查照片':['development_tail_check','development_patch_tail_check'],'定位图':['development_positioning'],'工艺回样照片':['development_printing','development_embroidery','development_print_embroidery'],'补做成果':['development_patch']};
    const expected=kinds[purpose];
    if(expected){if(!taskId)fail('成果缺少本次任务');await this.authorizeSewingUpload(actor,sourceId,taskId!,this.database,expected);}
    else if(taskId)fail('附件用途与任务不符');
    if(purpose==='客户评语依据'){
      const sheet=await this.forms().read(actor,sourceId);if(!sheet.canEdit)digitalForbidden();
    }
  }
  async recordUploadPurpose(actor:TrustedActorContext,sourceId:string,attachmentId:string,purpose:DevelopmentUploadPurpose,taskId?:string){
    await this.authorizeUpload(actor,sourceId);
    if(purpose==='外部纸样')await this.authorizeExternalPattern(actor,sourceId);
    await this.authorizeResultPurpose(actor,sourceId,purpose,taskId);
    const result=await this.database.query("INSERT INTO digital_development_upload_purposes(attachment_id,source_id,purpose,uploaded_by,task_id) SELECT attachment_id,$2,$3,$4,$5 FROM attachments WHERE attachment_id=$1 AND uploaded_by=$4 AND entity_type IS NULL ON CONFLICT DO NOTHING RETURNING attachment_id",[attachmentId,sourceId,purpose,actor.actorId,taskId??null]);
    if(!result.rowCount)fail("上传用途登记失败，请重新上传");
  }
  async authorizeFinalize(actor:TrustedActorContext,sourceId:string,attachmentId:string){
    await this.authorizeUpload(actor,sourceId);
    if(!(await this.database.query("SELECT 1 FROM digital_development_upload_purposes WHERE source_id=$1 AND attachment_id=$2 AND uploaded_by=$3",[sourceId,attachmentId,actor.actorId])).rowCount)digitalForbidden();
  }
  async authorizeUpload(actor:TrustedActorContext,sourceId:string){const sheet=await this.forms().read(actor,sourceId);if(!isRootActor(actor)&&!actor.actorRoles.some(role=>["pattern_room_worker","pattern_room_supervisor","order_merchandiser","pattern_room_tail_inspector"].includes(role))&&!(sheet.canEdit&&actor.actorRoles.includes('sample_designer')))digitalForbidden();}
}
