import {QC_PROGRESS_CAPABILITY} from '@dx-rework/contracts/qc-production-progress';
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { ProductionExclusionService } from "./production-exclusion-service.js";
import { productionNotExcluded, productionMerchandiserId } from "./production-visibility.js";
import type { ProductionExclusionInput } from "@dx-rework/contracts";
import type { ProductionClosureService } from "./production-closure-service.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ProductionReportInputSchema, ProductionCorrectionInputSchema, ProductionExecutionInputSchema,
  ProductionScopeInputSchema, ProductionReportingDetailSchema, ProductionScopeDirectorySchema,
  type ProductionReportInput, type ProductionCorrectionInput, type ProductionExecutionInput, type ProductionScopeInput,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { selectFactoryProduction, toOrder, type ProductionRow } from "./sourcing-production-service.js";
import {assertProductionReportingDate,productionReportingObservation} from './production-reporting-clock.js';

const ROOT = "root_superuser";
const CAP = "production-reporting";
const isRoot = (actor: TrustedActorContext) => actor.actorRoles.includes(ROOT);
export const isProductionReporter = (actor: TrustedActorContext) => isRoot(actor)
  || (actor.actorRoles.includes("production_reporter") && (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes(CAP));
const isQcReader=(actor:TrustedActorContext)=>actor.actorRoles.includes('quality_control')&&(actor.authorizationCapabilities??[actor.authorizationCapability]).includes(QC_PROGRESS_CAPABILITY);
const manager = (actor: TrustedActorContext) => isRoot(actor) ||
  (actor.actorRoles.some((role) => ["owner_group", "production_management", "finance_director", "finance_read"].includes(role))
    && (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes("sourcing:view"));
const canRead = (actor: TrustedActorContext) => manager(actor) || isProductionReporter(actor) || isQcReader(actor)
  || (actor.actorRoles.includes("order_merchandiser") && (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes("sourcing:view"));
function fail(message: string, status = 409): never { throw new ApplicationError(status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 400 ? "VALIDATION_ERROR" : "INVALID_STATE_TRANSITION", message, status); }
const asIso = (date: string | Date) => new Date(date).toISOString();
type Query = Pick<PoolClient,"query">;
// Parent case deletion does not hide production. Scope uses the frozen supplier.
const visible = `${productionNotExcluded} AND ($1::boolean OR ($2::boolean AND sourcing_production_factory_reporter_allowed($3,production.production_order_id,production.factory_decision_id))
  OR ($4::boolean AND ${productionMerchandiserId}=$3))`;
const visibility = (actor: TrustedActorContext) => [manager(actor), isProductionReporter(actor), actor.actorId, actor.actorRoles.includes("order_merchandiser") && (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes("sourcing:view")];

// Reporter scopes and assigned-QC access are independent: a revoked reporter's
// surviving supplier-scope rows must never be reactivated by their QC role.
const factoryVisibleFor=(actor:TrustedActorContext)=>isQcReader(actor)?visible.replace('($2::boolean AND sourcing_production_factory_reporter_allowed($3,production.production_order_id,production.factory_decision_id))','(($2::boolean AND sourcing_production_factory_reporter_allowed($3,production.production_order_id,production.factory_decision_id)) OR digital_qc_report_allowed($3,production.production_order_id,production.factory_decision_id))'):visible;

export class ProductionReportingService {
  constructor(private readonly database: Pool, private readonly idempotency = new IdempotencyService(), private readonly events = new OperationEventRepository(), private readonly closure?: Pick<ProductionClosureService,"refreshOrder">) {}
  previewExclusion(actor: TrustedActorContext, id: string) { return new ProductionExclusionService(this.database, this.idempotency, this.events).preview(actor, id); }
  excludeProduction(actor: TrustedActorContext, id: string, input: ProductionExclusionInput, key: string) { return new ProductionExclusionService(this.database, this.idempotency, this.events).exclude(actor, id, input, key); }
  private async order(client: Query, actor: TrustedActorContext, id: string,factoryDecisionId:string|null=null) {
    if (!canRead(actor)) fail("无权查看生产数据",403);
    const result = await client.query<ProductionRow>(`${selectFactoryProduction} WHERE ${factoryVisibleFor(actor)} AND production.production_order_id=$5 AND production.factory_decision_id IS NOT DISTINCT FROM $6::uuid`, [...visibility(actor),id,factoryDecisionId]);
    return result.rows[0] ? toOrder(result.rows[0]) : fail("生产订单不存在或不在负责范围内",404);
  }
  private async writable(client: Query, actor: TrustedActorContext, id: string,factoryDecisionId:string|null=null) {
    if (!isProductionReporter(actor)) fail("仅驻厂填报人员可维护生产数据",403);
    if (!isRoot(actor)) {
      const scope = await client.query<{allowed:boolean}>("SELECT sourcing_production_factory_reporter_allowed($1,$2,$3) AS allowed",[actor.actorId,id,factoryDecisionId]);
      if (!scope.rows[0]?.allowed) fail("该订单不在当前账号负责范围内；请驻厂填报人员返回生产填报页选择负责订单，需要调整范围时联系有权管理岗位，不显示范围外订单信息",403);
    }
  }
  async list(actor: TrustedActorContext, input: {page?:number|undefined; supplierId?:string|undefined; q?:string|undefined; status?:string|undefined} = {}) {
    if (!canRead(actor)) fail("无权查看生产数据",403);
    const page=input.page ?? 1;
    if (!Number.isInteger(page)||page<1||page>100000) fail("分页页码无效",400);
    const filter=`${factoryVisibleFor(actor)} AND ($5::uuid IS NULL OR production.supplier_id=$5)
      AND ($6::text='' OR production.first_style_no ILIKE '%'||$6||'%' OR production.supplier_name_snapshot ILIKE '%'||$6||'%'
        OR EXISTS(SELECT 1 FROM sourcing_style_aliases line WHERE line.sourcing_case_id=production.sourcing_case_id AND line.style_no ILIKE '%'||$6||'%'))
      AND ($7::text='' OR transition.status=$7)`;
    const args=[...visibility(actor),input.supplierId??null,input.q?.trim()??"",input.status??""];
    const rows=await this.database.query<ProductionRow>(`${selectFactoryProduction} WHERE ${filter}
      ORDER BY production.dispatched_at DESC,production.production_order_id LIMIT 15 OFFSET $8`,[...args,(page-1)*15]);
    const count=await this.database.query<{total:string}>(`SELECT count(*)::text AS total FROM (${selectFactoryProduction} WHERE ${filter}) selected`,args);
    const suppliers=await this.database.query<{supplier_id:string;supplier_name:string}>(`SELECT DISTINCT production.supplier_id,
      production.supplier_name_snapshot AS supplier_name FROM sourcing_production_factory_orders production
      JOIN sourcing_cases source_case USING(sourcing_case_id) WHERE ${factoryVisibleFor(actor)} ORDER BY supplier_name`,visibility(actor));
    return {items:rows.rows.map(toOrder),page,pageSize:15 as const,totalCount:Number(count.rows[0]?.total??0),
      suppliers:suppliers.rows.map(r=>({supplierId:r.supplier_id,supplierName:r.supplier_name}))};
  }
  async detail(actor: TrustedActorContext, id: string, client: Query = this.database,factoryDecisionId:string|null=null) {
    const order=await this.order(client,actor,id,factoryDecisionId);
    const history=await client.query<{report_id:string;root_report_id:string;revision:number;position:number;business_date:string;quantity:number;actor_name:string;created_at:Date;reason:string|null;effective:boolean}>(
      `SELECT report.report_id,report.root_report_id,report.revision,report.position,report.business_date::text,report.quantity,
       report.actor_name,report.created_at,report.reason,NOT EXISTS(SELECT 1 FROM sourcing_production_reports later
        WHERE later.root_report_id=report.root_report_id AND later.revision>report.revision) AS effective
       FROM sourcing_production_reports report WHERE production_order_id=$1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC,revision DESC,report_id`,[id,factoryDecisionId]);
    const transitions=await client.query<{status:string;business_date:string;display_name:string;created_at:Date}>(
      `SELECT transition.status,transition.business_date::text,person.display_name,transition.created_at FROM sourcing_production_transitions transition
       JOIN app_users person ON person.id=transition.actor_id WHERE production_order_id=$1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid ORDER BY sequence`,[id,factoryDecisionId]);
    const shipment=await client.query<{first_style_no:string;shipped_on:string;recorded_quantity:number}>(
      "SELECT sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,shipment.shipped_on::text,shipment.recorded_quantity FROM sourcing_production_shipments shipment JOIN sourcing_production_orders production USING(production_order_id) WHERE production_order_id=$1 AND shipment.factory_decision_id IS NOT DISTINCT FROM $2::uuid",[id,factoryDecisionId]);
    const allowed=await client.query<{allowed:boolean}>("SELECT sourcing_production_factory_reporter_allowed($1,$2,$3) AS allowed",[actor.actorId,id,factoryDecisionId]);
    let qcProgressOrderId:string|undefined;
    if(isQcReader(actor)&&(await client.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation)qcProgressOrderId=(await client.query("SELECT production_order_id FROM digital_production_child_links WHERE module='production' AND child_id=$1",[id])).rows[0]?.production_order_id;
    return ProductionReportingDetailSchema.parse({... (qcProgressOrderId?{qcProgressOrderId}:{}),order,...await productionReportingObservation(this.database,client,id),canReport:await memberCanWriteModule(client,actor.actorId,"sourcing")&&isProductionReporter(actor)&&(isRoot(actor)||allowed.rows[0]?.allowed===true),canCorrect:isRoot(actor),
      history:history.rows.map(r=>({reportId:r.report_id,rootReportId:r.root_report_id,revision:r.revision,position:r.position,businessDate:r.business_date,
        quantity:r.quantity,actorName:r.actor_name,createdAt:asIso(r.created_at),reason:r.reason,effective:r.effective})),
      transitions:transitions.rows.map(r=>({status:r.status,businessDate:r.business_date,actorName:r.display_name,createdAt:asIso(r.created_at)})),
      shipment:shipment.rows[0]?{firstStyleNo:shipment.rows[0].first_style_no,shippedOn:shipment.rows[0].shipped_on,recordedQuantity:shipment.rows[0].recorded_quantity}:null});
  }
  private async write<T>(actor: TrustedActorContext,id:string,key:string,action:string,input:unknown,factoryDecisionId:string|null,execute:(client:PoolClient)=>Promise<T>) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) fail("提交缺少有效请求标识",400);
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=(SELECT sourcing_case_id FROM sourcing_production_orders WHERE production_order_id=$1) FOR UPDATE",[id]);
      await client.query("SELECT id FROM app_users WHERE id=$1 FOR SHARE",[actor.actorId]);
      await client.query("SELECT production_order_id FROM sourcing_production_orders WHERE production_order_id=$1 FOR UPDATE",[id]);
      await this.writable(client,actor,id,factoryDecisionId);
      const result=await this.idempotency.execute(client,{scope:action,actorKey:actor.actorId,key,
        requestHash:createHash("sha256").update(JSON.stringify({id,input})).digest("hex"),expiresAt:new Date(Date.now()+86400000)},
        async()=>({statusCode:200,response:await execute(client)}));
      if(this.closure)await this.closure.refreshOrder(client,id);
      await client.query("COMMIT");return {value:result.response,reused:result.reused};
    } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally {client.release();}
  }
  async report(actor:TrustedActorContext,id:string,input:ProductionReportInput,key:string) {
    const parsed=ProductionReportInputSchema.safeParse(input);if (!parsed.success) fail("请填写款色、有效日期和本次新增数量",400);
    if (!isProductionReporter(actor)) fail("仅驻厂填报人员可上报",403);
    return this.write(actor,id,key,"sourcing.production.report",parsed.data,parsed.data.factoryDecisionId??null,async client=>{
      await this.appendNewReport(client,actor,id,parsed.data);
      return this.detail(actor,id,client,parsed.data.factoryDecisionId??null);
    });
  }
  private async appendNewReport(client:PoolClient,actor:TrustedActorContext,id:string,input:ProductionReportInput,qc?:{recordId:string;reportId:string}) {
    const factoryDecisionId=input.factoryDecisionId??null,order=await this.order(client,actor,id,factoryDecisionId);
    if(order.status!=="in_production")fail("生产完成后不能继续日常上报");
    const line=order.lines.find(l=>l.position===input.position);if(!line)fail("款色行不存在",400);
    if(line.completedQuantity+input.quantity>line.quantity)fail("本次新增成品量超过当前款色余量；已有数量错误仍由Root在原记录订正",400);
    const reportId=qc?.reportId??randomUUID();
    await this.insertReport(client,actor,id,reportId,reportId,1,input,null,undefined,qc);
    return reportId;
  }
  /** Internal original-ledger adapter; no QC complete/ship/correction route is granted. */
  async reportQcWithClient(client:PoolClient,actor:TrustedActorContext,id:string,input:ProductionReportInput,recordId:string,reportId:string){
    const parsed=ProductionReportInputSchema.safeParse(input);if(!parsed.success)fail("QC成品量或业务日期无效",400);
    if(!isRoot(actor)&&(!isQcReader(actor)||!(await client.query<{allowed:boolean}>("SELECT digital_qc_report_allowed($1,$2,$3) AS allowed",[actor.actorId,id,input.factoryDecisionId??null])).rows[0]?.allowed))fail("无权记录本工厂PO产量",403);
    if(!await memberCanWriteModule(client,actor.actorId,"sourcing"))fail("当前账号仅可查看",403);
    return this.appendNewReport(client,actor,id,parsed.data,{recordId,reportId});
  }
  async correct(actor:TrustedActorContext,id:string,rootReportId:string,input:ProductionCorrectionInput,key:string) {
    if(!isRoot(actor))fail("仅Root可修正生产记录",403);
    const parsed=ProductionCorrectionInputSchema.safeParse(input);if(!parsed.success)fail("修正必须填写有效数量、日期和原因",400);
    return this.write(actor,id,key,"sourcing.production.correct",{rootReportId,...parsed.data},parsed.data.factoryDecisionId??null,async client=>{
      const factoryDecisionId=parsed.data.factoryDecisionId??null;const order=await this.order(client,actor,id,factoryDecisionId);
      const result=await client.query<{report_id:string;revision:number;position:number;quantity:number}>(
        "SELECT report_id,revision,position,quantity FROM effective_sourcing_production_reports WHERE root_report_id=$1 AND production_order_id=$2 AND factory_decision_id IS NOT DISTINCT FROM $3::uuid",[rootReportId,id,factoryDecisionId]);
      const prior=result.rows[0];if(!prior)fail("原上报记录不存在",404);
      if(prior.report_id!==parsed.data.expectedReportId)fail("该记录已被修正，本次未覆盖；请Root重新读取本条原生产记录，核对最新数量、日期及修正原因后再提交");
      const line=order.lines.find(l=>l.position===prior.position)!;
      if(line.completedQuantity-prior.quantity+parsed.data.quantity>line.quantity)fail("修正后累计超过款色订单数量",400);
      const completed=await client.query<{business_date:string}>("SELECT business_date::text FROM sourcing_production_transitions WHERE production_order_id=$1 AND status='production_completed' AND factory_decision_id IS NOT DISTINCT FROM $2::uuid",[id,factoryDecisionId]);
      if(completed.rows[0]&&parsed.data.businessDate>completed.rows[0].business_date)fail("上报业务日期不能晚于已记录的生产完成日期",400);
      await this.insertReport(client,actor,id,randomUUID(),rootReportId,prior.revision+1,{position:prior.position,...parsed.data},parsed.data.reason,prior);
      return this.detail(actor,id,client,parsed.data.factoryDecisionId??null);
    });
  }
  private async insertReport(client:PoolClient,actor:TrustedActorContext,id:string,reportId:string,rootReportId:string,revision:number,
    input:{position:number;businessDate:string;quantity:number;factoryDecisionId?:string|null|undefined},reason:string|null,before?:unknown,qc?:{recordId:string;reportId:string}) {
    const dispatch=await client.query<{business_date:string}>(
      "SELECT business_date::text FROM sourcing_production_transitions WHERE production_order_id=$1 AND sequence=1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid",[id,input.factoryDecisionId??null]);
    if(!dispatch.rows[0])fail("生产订单缺少正式派单记录；请主跟单在原生产订单核对派单事实，记录未恢复前不能用填报日期替代派单日期");
    if(input.businessDate<dispatch.rows[0].business_date)fail("上报业务日期不能早于正式派单日期",400);
    const eventId=await this.events.append(client,{...actor,authorizationCapability:qc?QC_PROGRESS_CAPABILITY:CAP},{
      action:revision===1?"sourcing.production.report":"sourcing.production.correct",entityType:"sourcing_production_report",entityId:reportId,
      ...(before?{before}:{}),after:{...(qc?{qcProgressRecordId:qc.recordId}:{}),factoryDecisionId:input.factoryDecisionId??null,productionOrderId:id,rootReportId,revision,position:input.position,businessDate:input.businessDate,quantity:input.quantity},reason:reason??(qc?"QC同次进度采集记录本次新增成品量":"驻厂人员上报本次新增生产数量")});
    await assertProductionReportingDate(client,id,eventId,input.businessDate);
    await client.query(`INSERT INTO sourcing_production_reports(report_id,root_report_id,revision,production_order_id,position,business_date,quantity,actor_id,actor_name,reason,operation_event_id,factory_decision_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,id,display_name,$9,$10,$11 FROM app_users WHERE id=$8`,
      [reportId,rootReportId,revision,id,input.position,input.businessDate,input.quantity,actor.actorId,reason,eventId,input.factoryDecisionId??null]);
  }
  async execute(actor:TrustedActorContext,id:string,kind:"complete"|"ship",input:ProductionExecutionInput,key:string) {
    const parsed=ProductionExecutionInputSchema.safeParse(input);if(!parsed.success)fail("请填写业务日期并确认操作",400);
    if(!isProductionReporter(actor))fail("仅驻厂填报人员可记录生产完成或发货",403);
    return this.write(actor,id,key,`sourcing.production.${kind}`,parsed.data,parsed.data.factoryDecisionId??null,async client=>{
      const factoryDecisionId=parsed.data.factoryDecisionId??null;const order=await this.order(client,actor,id,factoryDecisionId);const expected=kind==="complete"?"in_production":"production_completed";
      if(order.status!==expected)fail(kind==="complete"?"仅生产中的订单可登记完成":"请先登记生产完成，再登记发货");
      const last=await client.query<{business_date:string}>("SELECT business_date::text FROM sourcing_production_transitions WHERE production_order_id=$1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid ORDER BY sequence DESC LIMIT 1",[id,factoryDecisionId]);
      const reports=await client.query<{latest:string|null}>("SELECT max(business_date)::text AS latest FROM effective_sourcing_production_reports WHERE production_order_id=$1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid AND quantity>0",[id,factoryDecisionId]);
      if(parsed.data.businessDate<(last.rows[0]?.business_date??"")||parsed.data.businessDate<(reports.rows[0]?.latest??""))fail("业务日期不能早于已记录的生产事实",400);
      const status=kind==="complete"?"production_completed":"shipped";
      const eventId=await this.events.append(client,{...actor,authorizationCapability:CAP},{action:`sourcing.production.${kind}`,entityType:"sourcing_production_order",entityId:id,
        before:{status:order.status},after:{factoryDecisionId,status,businessDate:parsed.data.businessDate,recordedQuantity:order.completedQuantity,firstStyleNo:order.firstStyleNo},reason:kind==="complete"?"确认实际生产完成":"登记供应商实际发货，尚未确认仓库收货"});
      await assertProductionReportingDate(client,id,eventId,parsed.data.businessDate);
      await client.query(`INSERT INTO sourcing_production_transitions(production_transition_id,production_order_id,sequence,status,business_date,actor_id,operation_event_id,factory_decision_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),id,kind==="complete"?2:3,status,parsed.data.businessDate,actor.actorId,eventId,factoryDecisionId]);
      if(kind==="ship")await client.query(`INSERT INTO sourcing_production_shipments(production_order_id,first_style_no,shipped_on,recorded_quantity,actor_id,operation_event_id,factory_decision_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,order.firstStyleNo,parsed.data.businessDate,order.completedQuantity,actor.actorId,eventId,factoryDecisionId]);
      return this.detail(actor,id,client,parsed.data.factoryDecisionId??null);
    });
  }
  async scopeDirectory(actor:TrustedActorContext) {
    if(!isRoot(actor))fail("仅Root可配置负责范围",403);
    const users=await this.database.query<{user_id:string;display_name:string}>(`SELECT DISTINCT person.id AS user_id,person.display_name FROM app_users person
      JOIN user_role_assignments assignment ON assignment.user_id=person.id AND assignment.revoked_at IS NULL
      JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled
      WHERE person.enabled AND role.role_code='production_reporter' ORDER BY person.display_name`);
    const suppliers=await this.database.query<{supplier_id:string;supplier_name:string}>("SELECT supplier_id,supplier_name FROM current_supplier_catalog ORDER BY supplier_name");
    const scopes=await this.database.query<{user_id:string;scope_type:string;scope_id:string;active:boolean;scope_label:string}>(`SELECT scope.user_id,scope.scope_type,scope.scope_id,scope.active,
      COALESCE(sourcing_current_first_style(production.sourcing_case_id)||' · '||production.supplier_name_snapshot,supplier.supplier_name,scope.scope_id::text) AS scope_label
      FROM current_sourcing_production_reporting_scopes scope
      LEFT JOIN sourcing_production_orders production ON scope.scope_type='order' AND production.production_order_id=scope.scope_id
      LEFT JOIN current_supplier_catalog supplier ON scope.scope_type='supplier' AND supplier.supplier_id=scope.scope_id
      WHERE scope.active ORDER BY scope.user_id,scope.scope_type,scope.scope_id`);
    return ProductionScopeDirectorySchema.parse({users:users.rows.map(r=>({userId:r.user_id,displayName:r.display_name})),suppliers:suppliers.rows.map(r=>({supplierId:r.supplier_id,supplierName:r.supplier_name})),
      scopes:scopes.rows.map(r=>({userId:r.user_id,scopeType:r.scope_type,scopeId:r.scope_id,active:r.active,scopeLabel:r.scope_label}))});
  }
  async setScope(actor:TrustedActorContext,input:ProductionScopeInput,key:string) {
    if(!isRoot(actor))fail("仅Root可配置负责范围",403);
    const parsed=ProductionScopeInputSchema.safeParse(input);if(!parsed.success)fail("负责范围信息无效",400);
    if(!/^[A-Za-z0-9._:-]{1,200}$/.test(key))fail("请求标识无效",400);
    const data=parsed.data,client=await this.database.connect();
    try {await client.query("BEGIN");
      await client.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE",[data.userId]);
      if(data.active){
        const role=await client.query(`SELECT 1 FROM app_users person JOIN user_role_assignments assignment ON assignment.user_id=person.id AND assignment.revoked_at IS NULL
          JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled
          WHERE person.id=$1 AND person.enabled AND role.role_code='production_reporter'`,[data.userId]);
        if(!role.rowCount)fail("请先在人员与权限中为该员工分配驻厂生产填报角色",400);
      }
      const target=await client.query(data.scopeType==="supplier"?"SELECT 1 FROM supplier_catalog_items WHERE supplier_id=$1":"SELECT 1 FROM sourcing_production_orders WHERE production_order_id=$1",[data.scopeId]);
      if(!target.rowCount)fail("负责范围对象不存在",404);
      const outcome=await this.idempotency.execute(client,{scope:"sourcing.production.scope",actorKey:actor.actorId,key,requestHash:createHash("sha256").update(JSON.stringify(data)).digest("hex"),expiresAt:new Date(Date.now()+86400000)},async()=>{
        const scopeId=randomUUID();const eventId=await this.events.append(client,actor,{action:"sourcing.production.scope",entityType:"production_reporting_scope",entityId:scopeId,after:data,reason:data.active?"配置驻厂人员负责范围":"撤销驻厂人员负责范围"});
        await client.query(`INSERT INTO sourcing_production_reporting_scopes(scope_event_id,user_id,scope_type,scope_id,version,active,operation_event_id)
          SELECT $1,$2,$3,$4,COALESCE(max(version),0)+1,$5,$6 FROM sourcing_production_reporting_scopes WHERE user_id=$2 AND scope_type=$3 AND scope_id=$4`,
          [scopeId,data.userId,data.scopeType,data.scopeId,data.active,eventId]);return {statusCode:200,response:{saved:true}};
      });await client.query("COMMIT");return outcome.response;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }
}

export const factoryProductionVisibility=visible;
export const productionVisibility=visible.replace('sourcing_production_factory_reporter_allowed($3,production.production_order_id,production.factory_decision_id)','sourcing_production_reporter_allowed($3,production.production_order_id)');
export { canRead as canReadProductionReporting, visibility as productionVisibilityArgs };

export const factoryProductionVisibilityFor=factoryVisibleFor;
export const productionVisibilityFor=(actor:TrustedActorContext)=>factoryVisibleFor(actor).replace('sourcing_production_factory_reporter_allowed($3,production.production_order_id,production.factory_decision_id)','sourcing_production_reporter_allowed($3,production.production_order_id)').replace('digital_qc_report_allowed($3,production.production_order_id,production.factory_decision_id)','digital_qc_order_report_allowed($3,production.production_order_id)');
