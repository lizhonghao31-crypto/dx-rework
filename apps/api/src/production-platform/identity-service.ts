import {developmentSourceLifecycle,effectiveDevelopmentSourceSql,workbenchPreorderPublication} from './development-source-lifecycle.js';
import {assertWholeOrderActive,wholeOrderActiveSql} from './whole-order-visibility.js';
import {WholeOrderDeletionService} from './whole-order-deletion-service.js';
import {bridgePreparationMaterials} from './preparation-series-bridge.js';
import {refreshPreparationWindows} from './production-readiness-repository.js';
import {enrollPreparation,preparationContext,currentPreparationMaterials,preparationMaterialHistory} from './preparation-material-repository.js';
import {approvedShortLeadCalendar,validateInitialLeadTime,consumeShortLead} from './short-lead-evidence.js';
import type { SourcingService } from "../sourcing/sourcing-service.js";
import { SlaOrderService } from "./sla-order-service.js";
import { developmentRevisionSource } from "./development-revision-source.js";
import { captureDevelopmentSla } from "./development-sla-enrollment.js";
import {newTimelineAdoptionMode} from './fixed-timeline-mode.js';
import type { BusinessClock } from "@dx-rework/domain/business-clock";
import {acceptanceBusinessContext,observedBusinessTime,registerAcceptanceCreated,ContextBusinessClock,acceptanceClockReaderEnabled} from '../acceptance-clock/business-time.js';
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DigitalOrderCreateSchema, formalCommitmentFacts, beijingCalendarDate, customerOrderDateError, initialCustomerOrderInput, initialCustomerOrderIsReady, digitalFormalPoNo, digitalPoKey, minimumInitialCustomerDate } from "@dx-rework/contracts/digital-production";
import {developmentDocumentRow} from "./development-round-repository.js";
import { DigitalPoDateRepository } from "./po-date-repository.js";
import type { DigitalCustomer, DigitalOrder, DigitalOrderInput, DigitalSource, DigitalSourceInput, DigitalNumberCorrection, InitialCustomerOrderDraft } from "@dx-rework/contracts/digital-production";
import { isRootActor } from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, isDigitalLeader, isDigitalManagementReader, isDigitalTechnicalManager, digitalForbidden } from "./access-policy.js";
import { ProductionOrderRootRepository } from "./order-root-repository.js";
import {ensureQuotationBudget} from './quotation-budget-basis.js';
import {shareApprovedDesignVersions} from './development-electronic-handover.js';
import {acceptsNewOrderTime,approvedOrderTimeSource,approvedOrderTimeCreation,orderTimeAdmission,bindOrderTimeOrder} from './order-time-admission.js';
import {automaticOrderTime} from './order-time-automatic.js';
import type {NumberedDraftIdentity,NumberedDraftInput,OrderNumberContext,OrderNumberPreviewInput,OrderNumberSettingsSave} from '@dx-rework/contracts/digital-order-number';
import {OrderNumberRepository,orderNumberConflict} from './order-number-repository.js';

const fail = (message: string, status = 409): never => { throw new ApplicationError(status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "DIGITAL_PRODUCTION_CONFLICT", message, status); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const orderFactsDigest=(value:DigitalOrderInput)=>digest(formalCommitmentFacts(value));
export const digitalDateText = (value: Date | string | null) => value instanceof Date
  ? new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value)
  : value;
export function assertIdentityActor(actor: TrustedActorContext): void {
  if (!isRootActor(actor) && !actor.actorRoles.some(role => ["pmc", "sample_designer", "order_merchandiser", "owner_group", "production_management", "pattern_room_supervisor", "development_clerk", "pattern_room_tail_inspector", "pattern_room_worker", "quality_control", "embroidery_washing_merchandiser", "warehouse_receiver", "warehouse_supervisor", "cutting_worker"].includes(role))) digitalForbidden();
}
const assertCreator = (actor: TrustedActorContext) => {
  if (!isRootActor(actor) && (!actor.actorRoles.includes("sample_designer") || !(actor.authorizationCapabilities ?? []).includes("pattern_room:orders:create"))) digitalForbidden();
};
const readScope = (kind: "order" | "source", alias: string) => {
  return `($1::boolean OR ($4::boolean AND ${alias}.created_by=$2) ${kind === "order" ? `OR ($5::boolean AND ${alias}.primary_merchandiser_id=$2) OR ($6::boolean AND ${alias}.source_id IS NOT NULL)` : ""}
    )`;
};
export class DigitalProductionIdentityService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean, private readonly sourcing?:SourcingService, private readonly now:()=>Date=()=>new Date(), private readonly businessClock?: BusinessClock,private readonly transactionClient?:PoolClient) {}
  deletions(){return new WholeOrderDeletionService(this.database);}
  inTransaction(client:PoolClient){return new DigitalProductionIdentityService(this.database,this.creationEnabled,this.sourcing,this.now,this.businessClock,client);}
  private async visibleOrder(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string, lock = false) {
    await new DigitalProductionAccessPolicy(client).assert(actor, "order", id, "technical");
    const result = await client.query(`SELECT o.* FROM digital_production_orders o WHERE production_order_id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ?? fail("订单不存在或无权访问", 404);
  }
  private async visibleSource(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string, lock = false) {
    await new DigitalProductionAccessPolicy(client).assert(actor, "source", id, "technical");
    const result = await client.query(`SELECT * FROM digital_production_sources WHERE source_id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ?? fail("开发来源不存在或无权访问", 404);
  }
  private async command<T>(actor: TrustedActorContext, command: string, key: string, payload: unknown, execute: (client: PoolClient) => Promise<T>, authorize?: (client: PoolClient) => Promise<void>): Promise<T> {
    assertIdentityActor(actor);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识", 400);
    const client = this.transactionClient??await this.database.connect();
    try {
      const initialAdoption=newTimelineAdoptionMode(this.database)==='fixed_v2'
        &&(command==='create-source'||command==='direct-order'||command.startsWith('confirm-source:'));
      if(!this.transactionClient)await client.query(initialAdoption?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
      if(authorize)await authorize(client);
      if(command.startsWith("numbers:")||command.startsWith("confirm-source:")||command.startsWith('attach-source:'))await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([actor.actorId, command, key])]);
      const hash = digest(payload);
      const prior = await client.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) fail("同一操作标识不能用于不同内容");
        const saved = prior.rows[0].response as { productionOrderId?: string; sourceId?: string };
        if (saved.productionOrderId) await this.visibleOrder(client, actor, saved.productionOrderId);
        else if (saved.sourceId) await this.visibleSource(client, actor, saved.sourceId);
        if(!this.transactionClient)await client.query("COMMIT");
        return prior.rows[0].response as T;
      }
      const response = await execute(client);
      await client.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(response)]);
      if(!this.transactionClient)await client.query("COMMIT");
      return response;
    } catch (error) { if(!this.transactionClient)await client.query("ROLLBACK"); throw error; }
    finally { if(!this.transactionClient)client.release(); }
  }
  private async readSnapshot<T>(read: (db: PoolClient)=>Promise<T>): Promise<T> {
    if (this.transactionClient) return read(this.transactionClient);
    const db = await this.database.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await read(db);
      await db.query("COMMIT");
      return result;
    } catch(error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  private assertCreation() { if (!this.creationEnabled) fail("新建数字生产订单尚未开放", 403); }
  private async audit(client: PoolClient, actor: TrustedActorContext, action: string, id: string, before: unknown, after: unknown) {
    const eventId = randomUUID();
    await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
      VALUES($1,$2,$3,$4,'digital_production',$5,$6,$7)`, [eventId, actor.requestId, actor.actorId, action, id, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
    return eventId;
  }
  async customers(actor: TrustedActorContext): Promise<DigitalCustomer[]> {
    assertIdentityActor(actor);
    const result = await this.database.query('SELECT c.code,c.name,c.product_groups AS "productGroups",c.default_merchandiser_id AS "defaultMerchandiserId",u.display_name AS "defaultMerchandiserName" FROM digital_production_customers c LEFT JOIN app_users u ON u.id=c.default_merchandiser_id WHERE c.enabled ORDER BY c.code');
    return result.rows;
  }
  async orderCalendar(actor:TrustedActorContext,sourceId?:string){
    assertIdentityActor(actor);
    let now=this.now();
    if(sourceId){
      await this.visibleSource(this.database,actor,sourceId);
      now=new Date((await (this.businessClock??new ContextBusinessClock(this.database)).read({kind:'source',id:sourceId})).now);
    }
    const orderTimeEnabled=await acceptsNewOrderTime(this.database);
    return {...(orderTimeEnabled||newTimelineAdoptionMode(this.database)==='fixed_v2'?{independentCraftsEnabled:true}:{}),orderTimeEnabled,serverToday:beijingCalendarDate(now),minimumInitialCustomerDate:orderTimeEnabled?beijingCalendarDate(now):minimumInitialCustomerDate(now)};
  }
  async sources(actor: TrustedActorContext, page: number, search: string, attachTo?: string): Promise<{ items: DigitalSource[]; page: number; total: number }> {
    assertIdentityActor(actor);
    return this.readSnapshot(async db=>{
      if(attachTo){
        const order=await this.visibleOrder(db,actor,attachTo);
        if(!isDigitalLeader(actor)&&!(actor.actorRoles.includes("sample_designer")&&order.created_by===actor.actorId))digitalForbidden();
        if(order.source_id)return {items:[],page,total:0};
      }
      const scope=`FROM digital_production_sources s LEFT JOIN digital_production_orders o ON o.source_id=s.source_id
        WHERE ${await wholeOrderActiveSql(db,"source","s.source_id")} AND ${await effectiveDevelopmentSourceSql(db,"s.source_id")}
        AND ${readScope("source", "s")} AND ($3='' OR strpos(lower(s.design_style_no),lower($3))>0)
        AND ($5::uuid IS NULL OR (o.production_order_id IS NULL AND EXISTS (
          SELECT 1 FROM digital_production_orders target WHERE target.production_order_id=$5
          AND target.created_by=s.created_by AND target.design_style_no=s.design_style_no
          AND coalesce(target.temporary_style_no,'')=coalesce(s.temporary_style_no,'')
          AND (s.customer_code IS NULL OR s.customer_code=target.customer_code)
        )))`;
      const params=[isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor),actor.actorId,search,
        actor.actorRoles.includes("sample_designer"),attachTo??null];
      const total=(await db.query<{total:number}>(`SELECT count(*)::int AS total ${scope}`,params)).rows[0]!.total;
      const result=await db.query<DigitalSource>(`SELECT s.source_id AS "sourceId",s.development_type AS "developmentType",s.design_style_no AS "designStyleNo",
        s.temporary_style_no AS "temporaryStyleNo",s.customer_code AS "customerCode",s.created_by AS "createdBy",s.created_at AS "createdAt",
        o.production_order_id AS "productionOrderId" ${scope} ORDER BY s.created_at DESC,s.source_id DESC LIMIT 15 OFFSET $6`,[...params,(page-1)*15]);
      return {items:result.rows,page,total};
    });
  }
  // Shared preflight for callers that persist tool state before native creation.
  // Keep the original Root/designer + capability policy in one place.
  assertSourceCreation(actor: TrustedActorContext): void {
    this.assertCreation();
    assertCreator(actor);
    assertIdentityActor(actor);
  }
  async checkDesignCode(actor: TrustedActorContext, code: string) {
    this.assertSourceCreation(actor);
    const value=code.trim();
    if(!value||value.length>100)fail("设计业务ID须为1—100个字符",400);
    const result=await this.database.query("SELECT 1 FROM digital_production_sources WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1 LIMIT 1",[digitalPoKey(value)]);
    // Never return another designer's source ID, customer, files or ownership.
    return {code:value,available:!result.rowCount};
  }
  private async insertSource(client: PoolClient, actor: TrustedActorContext, input: Omit<DigitalSourceInput, 'designStyleNo'> & {designStyleNo: string | null}, draft: boolean, generated = false) {
    const id = randomUUID(), managed = await acceptsNewOrderTime(client);
    // All variants use the original identity row, creation audit and test-clock registration.
    await client.query(`INSERT INTO digital_production_sources
      (source_id,created_by,development_type,design_style_no,temporary_style_no,customer_code${managed?',order_time_managed':''}${draft?',draft_reserved':''}${generated?',workbench_generated_number':''})
      VALUES($1,$2,$3,$4,$5,$6${managed?',true':''}${draft?',true':''}${generated?',true':''})`,
    [id, actor.actorId, input.developmentType, input.designStyleNo, input.temporaryStyleNo, input.customerCode]);
    if (input.designStyleNo && (await client.query("SELECT to_regclass('digital_design_code_registry') AS relation")).rows[0]?.relation)
      await client.query("INSERT INTO digital_design_code_registry(code_key,source_id,code,created_by) VALUES($1,$2,$3,$4)",
        [digitalPoKey(input.designStyleNo), id, input.designStyleNo, actor.actorId]);
    const eventId = await this.audit(client, actor, draft ? "digital_source_draft_reserved" : "digital_source_created", id, null, input);
    await registerAcceptanceCreated(client,{kind:'source',id},actor.actorId,eventId);
    return {id,eventId,managed};
  }
  async createSource(actor: TrustedActorContext, input: DigitalSourceInput, key: string, reserveDraft = false): Promise<{ sourceId: string }> {
    this.assertSourceCreation(actor);
    return this.command(actor, reserveDraft ? "reserve-source-draft" : "create-source", key, input, async client => {
      if (input.customerCode) await this.customer(client, input.customerCode);
      const styleKey = digitalPoKey(input.designStyleNo);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["digital-source-style",styleKey])]);
      if ((await client.query("SELECT 1 FROM digital_production_sources WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1 LIMIT 1", [styleKey])).rowCount)
        fail("该编号已有开发档案，请打开原档案继续办理");
      const {id,eventId,managed}=await this.insertSource(client,actor,input,reserveDraft);
      if(reserveDraft)return {sourceId:id};
      await enrollPreparation(client,{kind:'source',id},actor.actorId,eventId);
      const time = this.businessClock ? await this.businessClock.read({ kind: "source", id })
        : observedBusinessTime(this.now);
      if(managed){
        await client.query("INSERT INTO digital_order_time_subjects(resource_kind,source_id,created_by,created_business_time,creation_event_ref) VALUES('source',$1,$2,$3,$4)",[id,actor.actorId,JSON.stringify(time),'audit_events:'+eventId]);
      }else await captureDevelopmentSla(client, actor, id, null, time, eventId,newTimelineAdoptionMode(this.database));
      return { sourceId: id };
    });
  }
  private async assertNumberedDraftActor(db:PoolClient,actor:TrustedActorContext) {
    if(!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'sample_designer'))digitalForbidden();
  }
  /** Internal G2 contract. X2/C2 own the publication and create-form entry points. */
  async reserveNumberedDraft(actor:TrustedActorContext,input:NumberedDraftInput,key:string):Promise<NumberedDraftIdentity> {
    this.assertSourceCreation(actor);
    return this.command(actor,'reserve-numbered-draft',key,input,async client=>{
      const {numbering}=input;
      if(numbering.customerCode)await this.customer(client,numbering.customerCode,numbering.productGroup??undefined);
      const {id}=await this.insertSource(client,actor,{
        developmentType:input.developmentType,temporaryStyleNo:input.temporaryStyleNo,
        customerCode:numbering.customerCode,designStyleNo:null,
      },true,true);
      const orderNumber=await new OrderNumberRepository(client).bind(id,{...numbering,designerId:actor.actorId});
      return {sourceId:id,orderNumber};
    },client=>this.assertNumberedDraftActor(client,actor));
  }
  async bindDraftNumber(actor:TrustedActorContext,sourceId:string,input:OrderNumberContext,key:string):Promise<NumberedDraftIdentity> {
    this.assertSourceCreation(actor);
    return this.command(actor,'bind-draft-number:'+sourceId,key,input,async client=>{
      const source=await this.visibleSource(client,actor,sourceId,true);
      if(!isRootActor(actor)&&source.created_by!==actor.actorId)digitalForbidden();
      // Deletion can commit while the original authorization read waits for this source lock.
      await assertWholeOrderActive(client,'source',sourceId);
      if(!source.workbench_generated_number)orderNumberConflict('原开发档案已使用原编号');
      if(source.design_style_no)return {sourceId,orderNumber:String(source.design_style_no)};
      if(!(await developmentSourceLifecycle(client,sourceId))?.is_draft)orderNumberConflict('仅未编号草稿可绑定订单ID');
      if(source.customer_code&&source.customer_code!==input.customerCode)orderNumberConflict('发号客户须对应原开发档案');
      const orderNumber=await new OrderNumberRepository(client).bind(sourceId,{...input,designerId:source.created_by});
      return {sourceId,orderNumber};
    },client=>this.assertNumberedDraftActor(client,actor));
  }
  private async assertOrderNumberAdministrator(client:PoolClient,actor:TrustedActorContext,write=false) {
    if(isRootActor(actor))return;
    const policy=new DigitalProductionAccessPolicy(client);
    if(!actor.actorRoles.includes('production_management')
      || !await (write?policy.lockActiveRole(actor.actorId,'production_management'):policy.activeRole(actor.actorId,'production_management')))digitalForbidden();
  }
  async orderNumberSettings(actor:TrustedActorContext) {
    return this.readSnapshot(async client=>{
      await this.assertOrderNumberAdministrator(client,actor);
      return new OrderNumberRepository(client).readSettings();
    });
  }
  async previewOrderNumber(actor:TrustedActorContext,input:OrderNumberPreviewInput) {
    return this.readSnapshot(async client=>{
      await this.assertOrderNumberAdministrator(client,actor);
      return new OrderNumberRepository(client).preview(input);
    });
  }
  async saveOrderNumberSettings(actor:TrustedActorContext,input:OrderNumberSettingsSave,key:string) {
    if(acceptanceBusinessContext())orderNumberConflict('测试时钟场景不能修改公司设置');
    return this.command(actor,'save-order-number-settings',key,input,async client=>{
      const {expectedVersion,...values}=input;
      const result=await new OrderNumberRepository(client).saveSettings(expectedVersion,values,actor.actorId);
      await this.audit(client,actor,'digital_order_number_settings_saved',String(result.version),{version:expectedVersion},{version:result.version,values});
      return result;
    },client=>this.assertOrderNumberAdministrator(client,actor,true));
  }
  async developmentDrafts(actor:TrustedActorContext,page:number,search:string,countOnly=false){
    this.assertSourceCreation(actor);
    return this.readSnapshot(async db=>{
    if(!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'sample_designer'))digitalForbidden();
    const scope=`WHERE lifecycle.is_draft AND ${await wholeOrderActiveSql(db,"source","s.source_id")}
      AND ($1 OR s.created_by=$2) AND ($3='' OR strpos(lower(s.design_style_no),lower($3))>0)`;
    const params=[isRootActor(actor),actor.actorId,search];
    const total=(await db.query<{total:number}>(`SELECT count(*)::int AS total FROM digital_production_sources s
      JOIN digital_development_source_lifecycle lifecycle USING(source_id) ${scope}`,params)).rows[0]!.total;
    if(countOnly)return {items:[],page,total,hasNext:page*15<total};
    const result=await db.query(`SELECT s.source_id AS "sourceId",s.development_type AS "developmentType",
      s.design_style_no AS "designStyleNo",s.temporary_style_no AS "temporaryStyleNo",s.customer_code AS "customerCode",
      coalesce(d.version,0)::int AS version,coalesce(d.updated_at,s.created_at) AS "updatedAt",approval.state AS "approvalState"
      FROM digital_production_sources s JOIN digital_development_source_lifecycle lifecycle USING(source_id)
      LEFT JOIN digital_development_documents d USING(source_id)
      LEFT JOIN LATERAL (
        SELECT state FROM digital_order_time_requests request WHERE request.source_id=s.source_id
          AND request.operation_json->>'kind'='development_publish'
        ORDER BY request.updated_at DESC,request.request_id DESC LIMIT 1
      ) approval ON true
      ${scope} ORDER BY coalesce(d.updated_at,s.created_at) DESC,s.source_id DESC LIMIT 15 OFFSET $4`,[...params,(page-1)*15]);
    return {items:result.rows,page,total,hasNext:page*15<total};
    });
  }
  async developmentDraftReceipt(actor:TrustedActorContext,key:string){
    assertIdentityActor(actor);
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail("缺少有效操作标识",400);
    const saved=(await this.database.query<{source_id:string}>(`SELECT s.source_id FROM digital_production_commands c
      JOIN digital_production_sources s ON s.source_id::text=c.response->>'sourceId'
      WHERE c.actor_id=$1 AND c.command='reserve-source-draft' AND c.key=$2
        AND s.created_by=$1 AND ${await wholeOrderActiveSql(this.database,"source","s.source_id")}`,[actor.actorId,key])).rows[0];
    if(saved)await this.visibleSource(this.database,actor,saved.source_id);
    return {sourceId:saved?.source_id??null};
  }
  private async customer(client: PoolClient, code: string, group?: string) {
    const result = await client.query("SELECT * FROM digital_production_customers WHERE code=$1 AND enabled AND ($2::text IS NULL OR $2=ANY(product_groups))", [code, group ?? null]);
    if (!result.rows[0]) fail("客户或产品分组不可用", 400);
  }
  async createOrder(actor: TrustedActorContext, input: DigitalOrderInput, key: string, sourceId: string | null = null): Promise<DigitalOrder> {
    this.assertCreation();
    const approved=this.transactionClient?(sourceId?await approvedOrderTimeSource(this.transactionClient,actor,sourceId):await approvedOrderTimeCreation(this.transactionClient,actor)):false;
    if(!approved)assertCreator(actor);
    if (new Set(input.lines.map(line => line.color.trim().toLowerCase())).size !== input.lines.length) fail("同一母单颜色不能重复", 400);
    const poKeys = input.lines.map(line => digitalPoKey(digitalFormalPoNo(line))).filter(Boolean);
    if (new Set(poKeys).size !== poKeys.length) fail("同一母单正式款号（PO）不能重复",400);
    for (const line of input.lines) if (new Set([line.formalPoNo,line.formalStyleNo,line.poNumber].map(digitalPoKey).filter(Boolean)).size > 1)
      fail("正式款号（PO）只能有一个有效值",400);
    for (const line of input.lines) if (line.customerWarehouseArrivalDate!==undefined && line.deliveryDate!==undefined && line.deliveryDate!==null
      && line.customerWarehouseArrivalDate!==line.deliveryDate) fail("出货日期不能互相矛盾",400);
    return this.command(actor, sourceId ? `confirm-source:${sourceId}` : "direct-order", key, input, async client => automaticOrderTime(this.database,client,actor,sourceId?{kind:'confirm_order',sourceId,input}:{kind:'direct_order',input,route:input.productionPlanning??{craftSteps:null,preshrink:null}},async()=>{
      await this.customer(client, input.customerCode, input.productGroup);
      let createdBy = approved?orderTimeAdmission(client)!.designerId:actor.actorId;
      let frozenOrdering:InitialCustomerOrderDraft|undefined;
      let preorderRecipient:string|null=null;
      let preorder=false;
      if (sourceId) {
        const source = await this.visibleSource(client, actor, sourceId, true);
        if(await developmentRevisionSource(client,sourceId))fail('复版沿原开发档案的客户订单，不重复建立大货数量');
        if (!isRootActor(actor) && source.created_by !== actor.actorId && !approved) digitalForbidden();
        createdBy = source.created_by;
        if (source.design_style_no !== input.designStyleNo || (source.temporary_style_no ?? "") !== (input.temporaryStyleNo ?? "") || (source.customer_code && source.customer_code !== input.customerCode)) fail("下单资料与开发来源不一致");
        const existing = await client.query("SELECT production_order_id,creation_hash FROM digital_production_orders WHERE source_id=$1", [sourceId]);
        if (existing.rows[0]) {
          if (existing.rows[0].creation_hash !== digest(input)) fail("该开发来源已确认下单，不能重复建立不同订单");
          return this.readWith(client, actor, existing.rows[0].production_order_id);
        }
        const published=await developmentDocumentRow(client,sourceId);
        preorder=Boolean(source.workbench_generated_number&&await workbenchPreorderPublication(client,sourceId));
        if(published?.status!=="published"&&!preorder)fail("请先发布开发单，再正式确认客户订单");
        if(published?.document?.customerOrderDraft?.withOrder&&published.document.customerOrderDraft.stage!=='preorder')frozenOrdering=published.document.customerOrderDraft.order;
        if(preorder){
          await assertWholeOrderActive(client,'source',sourceId);
          if((await client.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1 AND state<>'active'",[sourceId])).rowCount)
            fail('预下单已暂停或取消，不能确认正式订单');
          if(!orderTimeAdmission(client))fail('请先通过正式订单时效核算再确认预下单');
          const context=await preparationContext(client,{kind:'source',id:sourceId});
          const facts=currentPreparationMaterials(await preparationMaterialHistory(client,context),null);
          preorderRecipient=facts.find(row=>row.kind==='design_handover'&&row.scopeRef==='whole'&&row.state==='ready'&&row.valid)?.recipientId??null;
        }
      }
      const styleKey = digitalPoKey(input.designStyleNo);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["digital-order-style",styleKey])]);
      if ((await client.query("SELECT 1 FROM digital_production_orders WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1 LIMIT 1", [styleKey])).rowCount)
        fail("该编号已有客户订单，请打开原档案继续办理");
      const formalTime=preorder?orderTimeAdmission(client)!.time:sourceId&&(this.businessClock||acceptanceClockReaderEnabled(this.database)||acceptanceBusinessContext())
        ? await (this.businessClock??new ContextBusinessClock(this.database,client)).read({kind:'source',id:sourceId}):observedBusinessTime(this.now);
      const now=new Date(formalTime.now),orderDateError=customerOrderDateError(input.orderDate,beijingCalendarDate(now));
      if(orderDateError)fail(orderDateError,400);
      let frozenInput:DigitalOrderInput|null=null;
      if(frozenOrdering){try{const parsed=DigitalOrderCreateSchema.safeParse(initialCustomerOrderInput(frozenOrdering));if(parsed.success)frozenInput=parsed.data;}catch{/* Incomplete published ordering remains recoverable. */}}
      const usingOrderTime=Boolean(orderTimeAdmission(client));
      const frozenApproval=!usingOrderTime&&sourceId&&frozenInput?await approvedShortLeadCalendar(client,sourceId,frozenInput,formalTime.scenarioId):null;
      if(frozenOrdering&&frozenInput&&initialCustomerOrderIsReady(frozenOrdering,{serverToday:beijingCalendarDate(now),orderTimeEnabled:usingOrderTime,minimumInitialCustomerDate:minimumInitialCustomerDate(now),approvedShortLead:frozenApproval})&&orderFactsDigest(input)!==orderFactsDigest(frozenInput!))
        fail("确认信息须与当前已发布的订购草稿一致，请重新打开原档案恢复资料");
      const shortApproval=usingOrderTime?null:await validateInitialLeadTime(client,actor,sourceId,input,formalTime);
      let merchandiserId = input.primaryMerchandiserId;
      if(preorder&&merchandiserId===undefined)merchandiserId=preorderRecipient??undefined;
      const defaultMerchandiserId = (await client.query("SELECT default_merchandiser_id FROM digital_production_customers WHERE code=$1 FOR SHARE", [input.customerCode])).rows[0]?.default_merchandiser_id ?? null;
      if (!isDigitalLeader(actor) && merchandiserId !== undefined && merchandiserId !== defaultMerchandiserId && !(preorder&&merchandiserId===preorderRecipient)) digitalForbidden();
      if (merchandiserId === undefined) merchandiserId = defaultMerchandiserId;
      if(preorder&&!merchandiserId)fail('正式确认前请指定有效主跟单',400);
      if (merchandiserId && !await new DigitalProductionAccessPolicy(client).lockActiveRole(merchandiserId, "order_merchandiser")) fail("主跟单必须为在职有效订单跟单", 400);
      const root = await new ProductionOrderRootRepository(client).create(createdBy);
      const businessTime = !sourceId&&this.businessClock ? await this.businessClock.read({ kind: "order", id: root.productionOrderId }) : formalTime;
      await client.query(`INSERT INTO digital_production_orders(production_order_id,source_id,customer_code,product_group,design_style_no,temporary_style_no,order_date,contract_delivery_date,created_by,creation_hash,primary_merchandiser_id${usingOrderTime?',order_time_managed':''})
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${usingOrderTime?',true':''})`, [root.productionOrderId, sourceId, input.customerCode, input.productGroup, input.designStyleNo, input.temporaryStyleNo, input.orderDate, input.contractDeliveryDate, createdBy, digest(input), merchandiserId]);
      await inheritCustomerSecondaryMerchandisers(client,input.customerCode,root.productionOrderId,merchandiserId??null);
      if (input.salesYear !== undefined || input.salesSeries !== undefined || input.requiresColorMatching !== undefined) {
        await client.query("UPDATE digital_production_orders SET sales_year=$2,sales_series=$3,requires_color_matching=$4 WHERE production_order_id=$1",[root.productionOrderId,input.salesYear??null,input.salesSeries??null,input.requiresColorMatching??null]);
      }
      const creationEventId = await this.audit(client, actor, "digital_order_created", root.productionOrderId, null, { ...input, slaBusinessTime: businessTime });
      bindOrderTimeOrder(client,root.productionOrderId);
      if(usingOrderTime){
        await client.query("INSERT INTO digital_order_time_subjects(resource_kind,production_order_id,effective,created_by,created_business_time,creation_event_ref,production_route) VALUES('order',$1,true,$2,$3,$4,$5)",[root.productionOrderId,createdBy,JSON.stringify(businessTime),'audit_events:'+creationEventId,JSON.stringify(input.productionPlanning??null)]);
      }
      await registerAcceptanceCreated(client,{kind:'order',id:root.productionOrderId},actor.actorId,creationEventId);
      for (const [position, line] of input.lines.entries()) {
        const lineId = randomUUID();
        await client.query(`INSERT INTO digital_production_po_lines(line_id,production_order_id,position,po_number,formal_style_no,temporary_style_no,color,color_foreign,delivery_date)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [lineId, root.productionOrderId, position + 1, digitalFormalPoNo(line), digitalFormalPoNo(line), line.temporaryStyleNo, line.color, line.colorForeign, line.deliveryDate]);
        const customerDate = line.customerWarehouseArrivalDate === undefined ? line.deliveryDate : line.customerWarehouseArrivalDate;
        if (customerDate) await new DigitalPoDateRepository(client).applyWithClient(actor,root.productionOrderId,"initial_po",
          [{lineId,date:customerDate,expectedVersion:0}],creationEventId);
        for (const size of line.sizes) await client.query("INSERT INTO digital_production_po_sizes(line_id,size,quantity) VALUES($1,$2,$3)", [lineId, size.size, size.quantity]);
      }
      await consumeShortLead(client,actor,root.productionOrderId,shortApproval,businessTime,creationEventId);
      await new SlaOrderService(this.database).enrollNewOrder(client, actor, root.productionOrderId, creationEventId, businessTime);
      await enrollPreparation(client,{kind:'order',id:root.productionOrderId},actor.actorId,creationEventId);
      await bridgePreparationMaterials(client,await preparationContext(client,{kind:'order',id:root.productionOrderId}),actor.actorId);
      await refreshPreparationWindows(client,root.productionOrderId);
      await ensureQuotationBudget(client,root.productionOrderId,actor.actorId);
      if(sourceId)await shareApprovedDesignVersions(client,actor,sourceId);
      return this.readWith(client, actor, root.productionOrderId);
    },result=>({kind:'order',id:result.productionOrderId})));
  }
  async attachSource(actor: TrustedActorContext, id: string, sourceId: string, key: string): Promise<DigitalOrder> {
    return this.command(actor, `attach-source:${id}`, key, { sourceId }, async client => {
      const context=acceptanceBusinessContext();if(context){await context.assertScope({kind:'order',id});await context.assertScope({kind:'source',id:sourceId});}
      const source = await this.visibleSource(client, actor, sourceId, true);
      if((await developmentSourceLifecycle(client,sourceId))?.is_draft)fail("请先发布开发草稿");
      if(source.workbench_generated_number&&await workbenchPreorderPublication(client,sourceId))fail('已发布预下单须沿原来源确认正式订单');
      const order = await this.visibleOrder(client, actor, id, true);
      if (!isDigitalLeader(actor) && !(actor.actorRoles.includes("sample_designer") && order.created_by === actor.actorId && source.created_by === actor.actorId)) digitalForbidden();
      if (order.source_id === sourceId) return this.readWith(client, actor, id);
      if (source.created_by !== order.created_by) fail("开发来源与订单必须归属同一设计师");
      if (order.source_id || order.design_style_no !== source.design_style_no || (order.temporary_style_no ?? "") !== (source.temporary_style_no ?? "") || (source.customer_code && source.customer_code !== order.customer_code)) fail("开发来源与订单不匹配或已有关联");
      const used = await client.query("SELECT 1 FROM digital_production_orders WHERE source_id=$1", [sourceId]);
      if (used.rowCount) fail("该开发来源已有履约母单");
      await client.query("UPDATE digital_production_orders SET source_id=$2,version=version+1 WHERE production_order_id=$1", [id, sourceId]);
      await ensureQuotationBudget(client,id,actor.actorId);
      await this.audit(client, actor, "digital_source_attached", id, { sourceId: null }, { sourceId });
      await bridgePreparationMaterials(client,await preparationContext(client,{kind:'order',id}),actor.actorId);
      await refreshPreparationWindows(client,id);
      return this.readWith(client, actor, id);
    });
  }
  async read(actor: TrustedActorContext, id: string): Promise<DigitalOrder> { assertIdentityActor(actor); return this.readWith(this.database, actor, id); }
  async slaPlan(actor: TrustedActorContext, id: string) { assertIdentityActor(actor); return new SlaOrderService(this.database, this.businessClock).read(actor, id); }
  async readWithClient(actor: TrustedActorContext, id: string, client: Pick<Pool, "query">): Promise<DigitalOrder> { assertIdentityActor(actor); return this.readWith(client, actor, id); }
  private async readWith(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string): Promise<DigitalOrder> {
    const row = await this.visibleOrder(client, actor, id);
    const lines = await client.query(`SELECT l.line_id AS "lineId",l.po_number AS "poNumber",l.formal_style_no AS "formalStyleNo",l.temporary_style_no AS "temporaryStyleNo",
      l.color,l.color_foreign AS "colorForeign",COALESCE(l.customer_warehouse_arrival_date,l.delivery_date)::text AS "deliveryDate",
      l.customer_warehouse_arrival_date::text AS "customerWarehouseArrivalDate",l.factory_delivery_date::text AS "factoryDeliveryDate",
      l.customer_date_version AS "customerDateVersion",l.factory_date_version AS "factoryDateVersion",
      COALESCE(l.customer_date_source,'legacy_unregistered') AS "customerDateSource",
      COALESCE(l.factory_date_source,'legacy_unregistered') AS "factoryDateSource",
      (SELECT jsonb_agg(jsonb_build_object('size',s.size,'quantity',s.quantity) ORDER BY s.size) FROM digital_production_po_sizes s WHERE s.line_id=l.line_id) AS sizes
      FROM digital_production_po_lines l WHERE production_order_id=$1 ORDER BY position`, [id]);
    return { ...(row.requires_color_matching!=null?{requiresColorMatching:row.requires_color_matching}:{}),...(row.sales_year!=null?{salesYear:Number(row.sales_year)}:{}),...(row.sales_series!=null?{salesSeries:row.sales_series}:{}),productionOrderId: id, sourceId: row.source_id, customerCode: row.customer_code, productGroup: row.product_group,
      designStyleNo: row.design_style_no, temporaryStyleNo: row.temporary_style_no, orderDate: digitalDateText(row.order_date)!, contractDeliveryDate: digitalDateText(row.contract_delivery_date),
      createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString(), status: row.source_id ? "development_linked" : "waiting_development",
      version: row.version, primaryMerchandiserId: row.primary_merchandiser_id, workflowGeneration: "digital_production_v1", notificationPolicy: "IN_APP_ONLY", lines: lines.rows.map(line => {
        const values = [line.poNumber,line.formalStyleNo].map(digitalPoKey).filter(Boolean);
        const poIdentityConflict = new Set(values).size > 1;
        return {...line,formalPoNo:poIdentityConflict ? null : digitalFormalPoNo(line),poIdentityConflict};
      }) };
  }
  async orders(actor: TrustedActorContext, page: number, search: string): Promise<{ items: DigitalOrder[]; page: number; total:number }> {
    assertIdentityActor(actor);
    return this.readSnapshot(async db=>{
    const scope=`FROM digital_production_orders o
      WHERE ${await wholeOrderActiveSql(db,"order","o.production_order_id")} AND ${readScope("order", "o")} AND ($3='' OR strpos(lower(design_style_no),lower($3))>0 OR strpos(lower(coalesce(temporary_style_no,'')),lower($3))>0
        OR EXISTS(SELECT 1 FROM digital_production_po_lines l WHERE l.production_order_id=o.production_order_id AND
          (strpos(lower(coalesce(l.formal_style_no,'')),lower($3))>0 OR strpos(lower(coalesce(l.po_number,'')),lower($3))>0)))
      `;
    const params=[isDigitalManagementReader(actor) || isDigitalTechnicalManager(actor), actor.actorId, search, actor.actorRoles.includes("sample_designer"), actor.actorRoles.includes("order_merchandiser") && await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,"order_merchandiser"), actor.actorRoles.includes("development_clerk") && await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,"development_clerk")];
    const total=(await db.query<{total:number}>(`SELECT count(*)::int AS total ${scope}`,params)).rows[0]!.total;
    const rows=await db.query(`SELECT production_order_id ${scope} ORDER BY created_at DESC,production_order_id DESC LIMIT 15 OFFSET $7`,[...params,(page-1)*15]);
    return { items: await Promise.all(rows.rows.map(row => this.readWith(db, actor, row.production_order_id))), page,total };
    });
  }
  async correctNumbers(actor: TrustedActorContext, id: string, lineId: string, input: DigitalNumberCorrection, key: string): Promise<DigitalOrder> {
    const result=await this.command(actor, `numbers:${id}:${lineId}`, key, input, async client => {
      const order = await this.visibleOrder(client, actor, id, true);
      if (!isDigitalLeader(actor) && !(actor.actorRoles.includes("sample_designer") && order.created_by === actor.actorId) && !(actor.actorRoles.includes("order_merchandiser") && order.primary_merchandiser_id === actor.actorId)) digitalForbidden();
      if (order.version !== input.expectedVersion) fail("订单已更新，请刷新后重试");
      const line = await client.query("SELECT po_number,formal_style_no FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2", [id, lineId]);
      if (!line.rows[0]) fail("款色明细不存在", 404);
      const links=await client.query("SELECT 1 FROM digital_production_child_links WHERE production_order_id=$1 LIMIT 1",[id]);
      if(links.rowCount&&!this.sourcing)fail('关联单据编号同步服务尚未就绪');
      if (new Set([input.formalPoNo,input.poNumber,input.formalStyleNo].map(digitalPoKey).filter(Boolean)).size > 1)
        fail("正式款号（PO）只能有一个有效值",400);
      const duplicate = digitalFormalPoNo(input) ? await client.query(`SELECT 1 FROM digital_production_po_lines
        WHERE production_order_id=$1 AND line_id<>$2 AND normalize_sourcing_style_key($3::text)
          IN (normalize_sourcing_style_key(po_number),normalize_sourcing_style_key(formal_style_no)) LIMIT 1`,
        [id,lineId,digitalFormalPoNo(input)]) : null;
      if (duplicate?.rowCount) fail("同一母单正式款号（PO）不能重复",400);
      await client.query("UPDATE digital_production_po_lines SET po_number=$3,formal_style_no=$4 WHERE production_order_id=$1 AND line_id=$2", [id, lineId, digitalFormalPoNo(input), digitalFormalPoNo(input)]);
      await client.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1", [id]);
      if(links.rowCount)await this.sourcing!.reviseDigitalNumbersWithClient(client,actor,id);
      await this.audit(client, actor, "digital_numbers_corrected", id, line.rows[0], { lineId, ...input });
      return this.readWith(client, actor, id);
    });
    await this.sourcing?.generateDigitalNumberContracts(actor,id);
    return result;
  }
}
import {inheritCustomerSecondaryMerchandisers} from './order-merchandisers.js';
