import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { InstructionDateRequestSchema, type InstructionDateRequest, type CustomerDateHistory } from "@dx-rework/contracts/production-instruction";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound } from "./access-policy.js";
import { DigitalProductionIdentityService } from "./identity-service.js";
import { DigitalPoDateRepository } from "./po-date-repository.js";
import { instructionNotice } from "./instruction-notice.js";

type DB = Pick<Pool | PoolClient,"query">;
type Line = {line_id:string;po_number:string|null;color:string;registered:string|null;effective:string|null;factory:string|null;customer_date_version:number;customer_date_source:string|null};
type Request = {request_id:string;order_version:number;requested_by:string;reason:string;date:string;old_date:string|null;source:"po"|"instruction"|"delivery";approved:boolean|null};
const fail:(message:string)=>never=(message)=>{throw new ApplicationError("INSTRUCTION_CONFLICT",message,409);};
export class PoCustomerDateService {
  constructor(private readonly database:Pool){}
  private async lines(db:DB,id:string):Promise<Line[]>{return (await db.query(`SELECT line_id,po_number,color,customer_warehouse_arrival_date::text AS registered,
    coalesce(customer_warehouse_arrival_date,delivery_date)::text AS effective,factory_delivery_date::text AS factory,
    customer_date_version,customer_date_source FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[id])).rows;}
  private async active(db:DB,id:string){
    const state=(await db.query("SELECT to_regclass('digital_production_resource_lifecycle') AS relation")).rows[0]?.relation?(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1",[id])).rows[0]?.state:null;
    if(state&&state!=="active")return false;
    if((await db.query("SELECT to_regclass('digital_order_closures') AS relation")).rows[0]?.relation)
      if((await db.query("SELECT 1 FROM digital_order_closures WHERE production_order_id=$1",[id])).rowCount)return false;
    return true;
  }
  private async manager(db:DB,actor:TrustedActorContext){
    if(isRootActor(actor))return true;
    const access=new DigitalProductionAccessPolicy(db);
    for(const role of ["production_management","owner_group"])if(actor.actorRoles.includes(role)&&await access.activeRole(actor.actorId,role))return true;
    return false;
  }
  private async requestRow(db:DB,id:string,requestId:string):Promise<Request>{
    const po=(await db.query(`SELECT r.*,NULL::text AS date,NULL::text AS old_date,'po' AS source,d.approved
      FROM digital_po_customer_requests r LEFT JOIN digital_po_customer_decisions d USING(request_id) WHERE r.production_order_id=$1 AND r.request_id=$2`,[id,requestId])).rows[0];
    if(po)return po;
    const instruction=(await db.query("SELECT to_regclass('digital_instruction_date_requests') AS relation")).rows[0]?.relation?(await db.query(`SELECT r.*,new_date::text AS date,old_date::text,'instruction' AS source,d.approved
      FROM digital_instruction_date_requests r LEFT JOIN digital_instruction_date_decisions d USING(request_id) WHERE r.production_order_id=$1 AND r.request_id=$2`,[id,requestId])).rows[0]:null;
    if(instruction)return instruction;
    return (await db.query(`SELECT r.*,expected_version AS order_version,requested_date::text AS date,previous_date::text AS old_date,'delivery' AS source,
      CASE WHEN d.request_id IS NULL THEN NULL ELSE d.decision='approved' END AS approved
      FROM digital_production_delivery_requests r LEFT JOIN digital_production_delivery_decisions d USING(request_id) WHERE r.production_order_id=$1 AND r.request_id=$2`,[id,requestId])).rows[0]??digitalNotFound();
  }
  private async changes(db:DB,id:string,row:Request,orderVersion:number){
    if(orderVersion!==row.order_version)fail("申请后母单已更新，请驳回后按明确 PO 重新申请");
    const lines=await this.lines(db,id);
    if(row.source==="po"){
      const stored=(await db.query("SELECT line_id,old_date::text,new_date::text AS date,expected_version FROM digital_po_customer_request_lines WHERE request_id=$1 ORDER BY line_id",[row.request_id])).rows;
      if(!stored.length)fail("申请缺少明确 PO");
      return stored.map(change=>{
        const line=lines.find(line=>line.line_id===change.line_id);
        if(!line||line.customer_date_version!==change.expected_version||line.registered!==change.old_date)fail("申请中的 PO 交期已更新，请驳回后重新申请");
        if(line.factory&&line.factory>change.date)fail("出货日期不能早于加工厂交货日");
        return {lineId:line.line_id,date:change.date,expectedVersion:change.expected_version,oldDate:line.registered};
      });
    }
    // Legacy whole-order requests can only map when their exact order version and
    // every PO's previous promise agree. Never guess which divergent PO was meant.
    const legacy=(await db.query("SELECT contract_delivery_date::text AS date FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0]?.date??null;
    if(!lines.length||legacy!==row.old_date||!(lines.every(line=>line.effective===row.old_date)||lines.every(line=>line.effective===null)))fail("历史整单申请与逐 PO 交期不一致，请驳回后选择明确 PO 重新申请");
    return lines.map(line=>{
      if(line.registered===row.date)fail("历史申请无需重复变更，请驳回后核对当前 PO");
      if(line.factory&&line.factory>row.date)fail("出货日期不能早于加工厂交货日");
      return {lineId:line.line_id,date:row.date,expectedVersion:line.customer_date_version,oldDate:line.registered};
    });
  }
  async read(actor:TrustedActorContext,id:string,db:DB=this.database){
    await new DigitalProductionAccessPolicy(db).assert(actor,"order",id,"technical");
    const order=(await db.query("SELECT version,primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0]??digitalNotFound();
    const active=await this.active(db,id),canApproveDate=await this.manager(db,actor);
    const canRequestDate=active&&(isRootActor(actor)||actor.actorRoles.includes("order_merchandiser")&&order.primary_merchandiser_id===actor.actorId&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,"order_merchandiser"));
    const lines=await this.lines(db,id);
    const dateRequests:CustomerDateHistory[]=[];
    for(const source of ["po","instruction","delivery"] as const){
      const table=source==="po"?"digital_po_customer_requests":source==="instruction"?"digital_instruction_date_requests":"digital_production_delivery_requests";
      if(!(await db.query("SELECT to_regclass($1) AS relation",[table])).rows[0]?.relation)continue;
      const ids=(await db.query(`SELECT request_id FROM ${table} WHERE production_order_id=$1`,[id])).rows;
      for(const item of ids){
        const row=await this.requestRow(db,id,item.request_id);
        const names=(await db.query(`SELECT u.display_name AS requested_by,r.${source==="delivery"?"created_at":"requested_at"} AS requested_at,
          d.${source==="delivery"?"created_at":"decided_at"} AS decided_at,v.display_name AS decided_by FROM ${table} r JOIN app_users u ON u.id=r.requested_by
          LEFT JOIN ${source==="po"?"digital_po_customer_decisions":source==="instruction"?"digital_instruction_date_decisions":"digital_production_delivery_decisions"} d USING(request_id)
          LEFT JOIN app_users v ON v.id=d.decided_by WHERE r.request_id=$1`,[row.request_id])).rows[0];
        const stored=source==="po"?(await db.query("SELECT line_id,old_effective_date::text AS old_date,new_date::text AS date,expected_version FROM digital_po_customer_request_lines WHERE request_id=$1 ORDER BY line_id",[row.request_id])).rows:[];
        let approvalBlockedReason:string|null=null;
        if(row.approved===null){
          if(!active)approvalBlockedReason="母单已暂停、取消或结案";
          else try{await this.changes(db,id,row,order.version);}catch(error){if(!(error instanceof ApplicationError))throw error;approvalBlockedReason=error.message;}
        }
        dateRequests.push({requestId:row.request_id,source,legacy:source==="delivery",oldDate:row.old_date,date:row.date??stored[0]?.date??"",
          reason:row.reason,status:row.approved===null?"待批准":row.approved?"已批准":"已驳回",requestedBy:names.requested_by,
          requestedAt:new Date(names.requested_at).toISOString(),decidedBy:names.decided_by??null,decidedAt:names.decided_at?new Date(names.decided_at).toISOString():null,
          changes:stored.map(change=>({lineId:change.line_id,poNumber:lines.find(line=>line.line_id===change.line_id)?.po_number??null,color:lines.find(line=>line.line_id===change.line_id)?.color??"",
            oldDate:change.old_date,date:change.date,expectedVersion:change.expected_version})),approvalBlockedReason});
      }
    }
    dateRequests.sort((a,b)=>b.requestedAt.localeCompare(a.requestedAt)||a.requestId.localeCompare(b.requestId));
    return {canRequestDate,canApproveDate,customerPoDates:lines.map(line=>({lineId:line.line_id,poNumber:line.po_number,color:line.color,date:line.effective,
      registeredDate:line.registered,version:line.customer_date_version,source:line.customer_date_source??(line.effective?"legacy_unregistered":null),factoryDate:line.factory})),dateRequests};
  }
  private async command(actor:TrustedActorContext,id:string,action:string,key:string,input:unknown,approve:boolean|null,work:(db:PoolClient,version:number)=>Promise<unknown>){
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail("缺少有效操作标识");
    const db=await this.database.connect();
    try{
      await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await new DigitalProductionAccessPolicy(db).assert(actor,"order",id,"technical");
      const order=(await db.query("SELECT version,primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[id])).rows[0]??digitalNotFound();
      if(approve!==null){if(!await this.manager(db,actor))digitalForbidden();const request=await this.requestRow(db,id,(input as {requestId:string}).requestId);if(!isRootActor(actor)&&request.requested_by===actor.actorId)digitalForbidden();}
      else if(!isRootActor(actor)&&(!actor.actorRoles.includes("order_merchandiser")||order.primary_merchandiser_id!==actor.actorId||!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,"order_merchandiser")))digitalForbidden();
      const command=`po-customer:${id}:${action}`,hash=createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior=(await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3",[actor.actorId,command,key])).rows[0];
      if(prior){if(prior.payload_hash!==hash)fail("操作标识已用于不同内容");await db.query("COMMIT");return prior.response;}
      if(approve!==false&&!await this.active(db,id))fail("母单已暂停、取消或结案");
      const response=await work(db,order.version);
      await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)",[actor.actorId,command,key,hash,JSON.stringify(response)]);
      await db.query("COMMIT");return response;
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  }
  private async audit(db:PoolClient,actor:TrustedActorContext,id:string,action:string,after:unknown){
    const auditId=randomUUID();await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_production',$5,$6)",[auditId,actor.requestId,actor.actorId,action,id,JSON.stringify(after)]);return auditId;
  }
  private async notice(db:PoolClient,actor:TrustedActorContext,id:string,title:string,key:string,directorsOnly=false){
    if(!(await db.query("SELECT to_regclass('digital_instruction_notices') AS relation")).rows[0]?.relation)return;
    const order=await new DigitalProductionIdentityService(this.database,true).readWithClient(actor,id,db);
    await instructionNotice(db,order,null,title,key,directorsOnly,true,true);
  }
  async request(actor:TrustedActorContext,id:string,input:InstructionDateRequest,key:string){
    const parsed=InstructionDateRequestSchema.safeParse(input);if(!parsed.success)throw new ApplicationError("VALIDATION_ERROR",parsed.error.issues[0]?.message??"请选择明确 PO",400);
    input=parsed.data;
    return this.command(actor,id,"request",key,input,null,async(db,version)=>{
      if(version!==input.orderVersion)fail("母单已更新，请刷新");
      const lines=await this.lines(db,id),requestId=randomUUID();
      const orderDate=(await db.query("SELECT order_date::text AS day FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0].day;
      const changes=input.changes.map(change=>{
        const line=lines.find(line=>line.line_id===change.lineId);
        if(!line||line.customer_date_version!==change.expectedVersion)fail("PO 已更新或不属于本母单");
        if(change.date<orderDate)fail("出货日期不能早于下单日期");
        if(line.effective===change.date)fail("新出货日期须与当前日期不同");
        if(line.factory&&line.factory>change.date)fail("出货日期不能早于加工厂交货日");
        return {...change,oldDate:line.registered,oldEffectiveDate:line.effective};
      });
      const auditId=await this.audit(db,actor,id,"digital_po_customer_dates_requested",{requestId,...input,changes});
      await db.query("INSERT INTO digital_po_customer_requests(request_id,production_order_id,order_version,reason,requested_by,audit_event_id) VALUES($1,$2,$3,$4,$5,$6)",[requestId,id,version,input.reason,actor.actorId,auditId]);
      for(const change of changes)await db.query("INSERT INTO digital_po_customer_request_lines(request_id,production_order_id,line_id,old_date,old_effective_date,new_date,expected_version) VALUES($1,$2,$3,$4,$5,$6,$7)",[requestId,id,change.lineId,change.oldDate,change.oldEffectiveDate,change.date,change.expectedVersion]);
      await this.notice(db,actor,id,"PO 出货日期变更待批准",`po-customer-request:${requestId}`,true);
      return {requestId};
    });
  }
  async decide(actor:TrustedActorContext,id:string,requestId:string,approved:boolean,key:string){
    return this.command(actor,id,"decision",key,{requestId,approved},approved,async(db,version)=>{
      const row=await this.requestRow(db,id,requestId);
      if(!isRootActor(actor)&&row.requested_by===actor.actorId)digitalForbidden();
      if(row.approved!==null){if(row.approved!==approved)fail("申请已处理");return {requestId,approved};}
      const changes=approved?await this.changes(db,id,row,version):[];
      const reason=row.reason.length<=500?row.reason:`历史客户交期申请 ${requestId}（完整原因保留在原申请）`;
      const auditId=await this.audit(db,actor,id,approved?"digital_po_customer_dates_approved":"digital_po_customer_dates_rejected",
        {requestId,source:row.source,reason,legacyReason:row.source!=="po"?row.reason:undefined,dateChanges:changes.map(change=>({...change,dateKind:"customer"}))});
      if(approved){await new DigitalPoDateRepository(db).applyWithClient(actor,id,"approved_customer_change",changes,auditId);
        await db.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1",[id]);}
      if(row.source==="po")await db.query("INSERT INTO digital_po_customer_decisions(request_id,approved,decided_by,audit_event_id) VALUES($1,$2,$3,$4)",[requestId,approved,actor.actorId,auditId]);
      else if(row.source==="instruction")await db.query("INSERT INTO digital_instruction_date_decisions(request_id,approved,decided_by) VALUES($1,$2,$3)",[requestId,approved,actor.actorId]);
      else await db.query("INSERT INTO digital_production_delivery_decisions(request_id,decision,decided_by) VALUES($1,$2,$3)",[requestId,approved?"approved":"rejected",actor.actorId]);
      await this.notice(db,actor,id,approved?"PO 出货日期变更已批准":"PO 出货日期变更已驳回",`po-customer-decision:${requestId}`);
      return {requestId,approved};
    });
  }
}
