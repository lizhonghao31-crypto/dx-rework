import {businessNow} from '../acceptance-clock/business-time.js';
import {documentMetadata} from "./document-metadata.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { budgetPublishErrors, calculateBudget, type BudgetDocument, type BudgetSheet, type BudgetSourcingPreparation } from "@dx-rework/contracts/digital-budget";
import type { AttachmentService } from "../tools/attachments.js";
import { readBudgetSourcing } from "./budget-sourcing-adapter.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound } from "./access-policy.js";
import {assertBudgetCraftBasis,budgetCraftBasisIsCurrent,readBudgetIeAdoption,readBudgetQuoteComparison,readLinkedIeBudgetCorrection} from './quotation-budget-basis.js';
import {quotationExact} from '@dx-rework/contracts/digital-quotation';
import {BudgetWashingFeeService} from './budget-washing-fees.js';
import {DigitalProductionIdentityService} from './identity-service.js';

type Database = Pick<Pool | PoolClient, "query">;
const conflict = (message: string): never => { throw new ApplicationError("BUDGET_CONFLICT", message, 409); };
const agreesWithIe=(actual:string,expected:string)=>actual!==''&&quotationExact(actual)===quotationExact(expected);
function budgetWithIePrice(document:BudgetDocument,adoption:Awaited<ReturnType<typeof readBudgetIeAdoption>>){
 if(!adoption.required)return document;
 const basis=adoption.basis??conflict(adoption.reason!);
 if(document.outsourcingUnitPrice&&!agreesWithIe(document.outsourcingUnitPrice,basis.unitPrice))
  conflict('本次外发预算价与本单原IE加工价不同，请核对后明确采用当前报价');
 const items=document.rows.filter(row=>row.rowId===basis.rowId);
 if(items.length!==1||items[0]!.section!=='外发工序'||items[0]!.unit!==basis.unit||items[0]!.consumption!=='1'
   ||!agreesWithIe(items[0]!.unitPrice,basis.unitPrice))
  conflict('须保留同一原IE加工明细、每件用量和单价，请核对原报价');
 return {...document,outsourcingUnitPrice:basis.unitPrice};
}
export class DigitalBudgetService {
  get washingFees(){return new BudgetWashingFeeService(this.database);}
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean) {}
  async prepareSourcing(actor: TrustedActorContext, orderId: string, expectedVersion: number, attachments: AttachmentService): Promise<BudgetSourcingPreparation> {
    const source = await readBudgetSourcing(this.database, actor, orderId);
    if (source.budgetVersion !== expectedVersion) conflict("预算已更新，本次未发起外发；请主跟单从本单预算页重新读取已发布版本，核对后再发起外发");
    const images: BudgetSourcingPreparation["images"] = [];
    for (const id of source.document.imageAttachmentIds) {
      const copy = await attachments.copyDigitalBudgetImage(actor, orderId, expectedVersion, id);
      images.push({ attachmentId: copy.attachmentId, filename: copy.filename, mimeType: copy.mimeType });
    }
    return { productionOrderId: orderId, budgetVersion: source.budgetVersion, orderVersion: source.order.version,
      gender: ["男装", "男童"].includes(source.order.product_group) ? "男装" : "女装", styleName: source.document.productCategory,
      contractDeliveryDate: source.order.delivery, daxingUnitPrice: source.document.outsourcingUnitPrice,customerCode:source.order.customer_code,budgetRows:source.document.rows,
      lineItems: source.lines.map(line => ({ lineId: line.line_id, styleNo: line.formal_style_no ?? "", alternateStyleNo: line.temporary_style_no || source.order.temporary_style_no || source.order.design_style_no, color: line.color, quantity: line.quantity, customerWarehouseArrivalDate: line.customer })), images };
  }
  private async order(db: Database, actor: TrustedActorContext, orderId: string, write = false) {
    await new DigitalProductionAccessPolicy(db).assert(actor, "order", orderId, "budget");
    const order = (await db.query(`SELECT o.*,u.display_name AS designer_name,m.display_name AS merchandiser_name
      FROM digital_production_orders o JOIN app_users u ON u.id=o.created_by
      LEFT JOIN app_users m ON m.id=o.primary_merchandiser_id WHERE o.production_order_id=$1`, [orderId])).rows[0] ?? digitalNotFound();
    const ownMerchandiser = actor.actorRoles.includes("order_merchandiser") && order.primary_merchandiser_id === actor.actorId
      && await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,"order_merchandiser");
    const canEdit = isRootActor(actor) || actor.actorRoles.includes("sample_designer") && order.created_by === actor.actorId || ownMerchandiser;
    if (write && !canEdit) throw new ApplicationError("FORBIDDEN","仅本单设计师、跟单或Root可维护预算草稿",403);
    return { ...order, canEdit, canPublish: isRootActor(actor) || ownMerchandiser };
  }
  async read(actor: TrustedActorContext, orderId: string, db: Database = this.database, version?: number): Promise<BudgetSheet> {
    const order = await this.order(db, actor, orderId);
    const linked = (await db.query("SELECT child_id FROM digital_production_child_links WHERE module='sourcing' AND production_order_id=$1", [orderId])).rows[0];
    const row = (await db.query(version === undefined ? "SELECT * FROM digital_budget_documents WHERE production_order_id=$1" : "SELECT *, 'published' AS status FROM digital_budget_versions WHERE production_order_id=$1 AND version=$2", version === undefined ? [orderId] : [orderId, version])).rows[0];
    if (version !== undefined && !row) digitalNotFound();
    let comparison=await readBudgetQuoteComparison(db,orderId,row,version!==undefined);
    const correction=version===undefined&&linked&&order.canPublish&&comparison.policy==='quote_v1'?
      await readLinkedIeBudgetCorrection(db,orderId):null;
    const canReviseLinked=Boolean(correction&&comparison.currentConfirmedVersion!==null&&comparison.currentConfirmedVersion>correction.quote_version);
    if(linked&&!canReviseLinked&&comparison.state==='review_required')comparison.reason='客户报价有新确认版；原外发合同保留已采用版本，后续调整沿原外发更正入口办理，不自动改变生产流程';
    const current=version===undefined;
    const hasDraft=comparison.policy==='legacy'||Boolean(row);
    const state=comparison.workbenchBasis===undefined?undefined:(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1",[orderId])).rows[0]?.state;
    const active=state===undefined||state==='active';
    const checkCraftBasis=current&&(!linked||canReviseLinked)&&row?.status!=='published'&&(order.canEdit||order.canPublish)
      &&comparison.policy==='quote_v1'&&comparison.currentConfirmedVersion!==null;
    const craftBasis=!checkCraftBasis||await budgetCraftBasisIsCurrent(db,orderId,comparison.policy);
    if(!craftBasis)comparison={...comparison,state:'incomparable',workbenchBasis:'craft_review_required',
      reason:'请先核对本单当前工艺批准版本及客户确认报价'};
    const ie=current&&(!linked||canReviseLinked)&&comparison.policy==='quote_v1'?await readBudgetIeAdoption(db,orderId,row):null;
    const ieMismatch=Boolean(ie?.basis&&row?.document?.outsourcingUnitPrice&&
      !agreesWithIe(row.document.outsourcingUnitPrice,ie.basis.unitPrice));
    const document=row?.document&&row.status==='draft'&&ie?.basis&&!row.document.outsourcingUnitPrice?
      {...row.document,outsourcingUnitPrice:ie.basis.unitPrice}:row?.document??null;
    const writableBasis=craftBasis&&(comparison.workbenchBasis===undefined||comparison.workbenchBasis==='valid'&&active);
    const liveEditor=comparison.workbenchBasis===undefined||order.canPublish
      ||order.created_by===actor.actorId&&actor.actorRoles.includes("sample_designer")
        &&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,"sample_designer");
    return { metadata:await documentMetadata(db,row), versions:(await db.query("SELECT version FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version DESC",[orderId])).rows.map(item=>item.version), productionOrderId: orderId, version: row?.version ?? 0, status: row?.status ?? "draft", document,
      totals: document ? calculateBudget(document) : null, canEdit: order.canEdit && liveEditor && (!linked||canReviseLinked) && row?.status !== "published" && current && hasDraft && writableBasis && (Boolean(row) || this.creationEnabled),
      canPublish: order.canPublish && (!linked||canReviseLinked) && row?.status !== "published" && current && hasDraft && writableBasis && (!ie?.required||Boolean(ie.basis)&&!ieMismatch) && (Boolean(row) || this.creationEnabled),
      ...(ie?.required?{outsourcingIeBasis:{unitPrice:ie.basis?.unitPrice??null,...(ie.basis?{rowId:ie.basis.rowId}:{}),reason:ieMismatch?'本次外发预算价与原IE加工价不一致，请明确采用当前报价':ie.reason}}:{}),
      ...(canReviseLinked&&correction&&row?.status==='published'&&comparison.state==='within_limit'&&ie?.basis&&!ieMismatch?
        {linkedIeCorrection:{sourcingCaseId:correction.case_id,budgetVersion:row.version,orderVersion:order.version}}:{}),
      comparison,canAdoptQuotation:current&&craftBasis&&this.creationEnabled&&order.canPublish&&(!linked||canReviseLinked)&&comparison.policy==='quote_v1'&&
        (comparison.state==='review_required'||ieMismatch&&row?.status==='draft')&&active,
      canSubmitSourcing: !linked && row?.status === "published" && ['legacy','within_limit'].includes(comparison.state) &&
        (!ie?.required||Boolean(ie.basis)&&!ieMismatch&&Boolean(row.document.outsourcingUnitPrice)) &&
        (isRootActor(actor) || actor.actorRoles.includes("order_merchandiser") && order.primary_merchandiser_id === actor.actorId),
      sourcingCaseId: linked?.child_id ?? null, publishedAt: row?.published_at ? new Date(row.published_at).toISOString() : null,
      designerName: order.designer_name, merchandiserName: order.merchandiser_name ?? null };
  }
  private async command<T>(actor: TrustedActorContext, orderId: string, action: string, key: string, payload: unknown, work: (db: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) conflict("缺少有效操作标识");
    const db = await this.database.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [orderId]);
      const order=await this.order(db, actor, orderId, true);
      const command = `budget:${orderId}:${action}`;
      const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const prior = (await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key])).rows[0];
      const sheet = await this.read(actor, orderId, db);
      if(sheet.comparison?.workbenchBasis&&!isRootActor(actor)){
        const policy=new DigitalProductionAccessPolicy(db);
        const primary=order.primary_merchandiser_id===actor.actorId&&actor.actorRoles.includes("order_merchandiser")
          &&await policy.lockActiveRole(actor.actorId,"order_merchandiser");
        const designer=action==="save"&&order.created_by===actor.actorId&&actor.actorRoles.includes("sample_designer")
          &&await policy.lockActiveRole(actor.actorId,"sample_designer");
        if(!primary&&!designer)digitalForbidden();
      }
      if (prior && prior.payload_hash !== hash) conflict("同一操作标识不能用于不同内容");
      if (prior) { await db.query("COMMIT"); return prior.response as T; }
      await assertBudgetCraftBasis(db,orderId,sheet.comparison?.policy??'legacy');
      if(action==='adopt'&&!sheet.canAdoptQuotation)conflict('当前不能切换报价依据；已关联外发的预算和合同保持原批准版本');
      if(sheet.comparison?.workbenchBasis&&action!=='adopt'&&sheet.comparison.workbenchBasis!=='valid')conflict(sheet.comparison.reason);
      if (action === "publish" && !sheet.canPublish) throw new ApplicationError("FORBIDDEN","预算由本单跟单最终发布，发布后内容冻结",403);
      if (!sheet.canEdit&&action!=='adopt') conflict(sheet.comparison?.policy==='quote_v1'&&!sheet.document?'请先由本单负责岗位完成客户确认报价及正式下单，再生成预算草稿':sheet.status === "published" ? "预算已最终发布并冻结，请查看已发布版本" : sheet.sourcingCaseId ? "已进入外发审批，请通过原外发预算更正入口处理" : "预算新建尚未启用，请管理员核对当前环境设置");
      const lifecycle = (await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1", [orderId])).rows[0];
      if (lifecycle && lifecycle.state !== "active") conflict(lifecycle.state === "paused" ? "母单已暂停，预算暂不能修改；请本单负责人在原任务入口核对暂停原因，由原有权岗位恢复后再办理" : lifecycle.state === "cancelled" ? "母单已取消，不能继续修改本单预算；请本单负责人核对原取消记录，历史预算与批准依据保留" : "母单当前状态未确认，暂不能修改预算；请重新读取原单，仍异常请管理员核查");
      const result = await work(db);
      await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(result)]);
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_budget',$5,$6)", [randomUUID(), actor.requestId, actor.actorId, `budget_${action}`, orderId, JSON.stringify({ version: (result as BudgetSheet).version })]);
      await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  async authorizeUpload(actor: TrustedActorContext, orderId: string) {
    const sheet = await this.read(actor, orderId);
    if (!sheet.canEdit) digitalForbidden();
  }
  async canDownload(actor: TrustedActorContext, orderId: string, attachmentId: string): Promise<boolean> {
    await this.order(this.database, actor, orderId);
    return Boolean((await this.database.query("SELECT 1 FROM digital_budget_attachment_bindings WHERE production_order_id=$1 AND attachment_id=$2", [orderId, attachmentId])).rowCount);
  }
  async originalVersions(actor:TrustedActorContext,orderId:string,page:number,q:string){
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.order(db,actor,orderId);
      const row=(await db.query(`WITH matching AS (SELECT version,published_at FROM digital_budget_versions WHERE production_order_id=$1 AND ($2::text='' OR strpos(lower('成本预算表 已发布版本 '||version),lower($2))>0)),
       chosen AS (SELECT * FROM matching ORDER BY version DESC LIMIT 15 OFFSET $3)
       SELECT (SELECT count(*)::int FROM matching) AS total,COALESCE(jsonb_agg(jsonb_build_object('version',version,'publishedAt',published_at) ORDER BY version DESC),'[]'::jsonb) AS items FROM chosen`,[orderId,q,(page-1)*15])).rows[0]!;
      await db.query('COMMIT');return {id:orderId,page,pageSize:15,total:row.total,items:row.items};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async originalVersion(actor:TrustedActorContext,orderId:string,version:number){
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const sheet=await this.read(actor,orderId,db,version),order=await new DigitalProductionIdentityService(this.database,this.creationEnabled).readWithClient(actor,orderId,db);
      await db.query('COMMIT');return {order,sheet:{...sheet,canEdit:false,canPublish:false,canAdoptQuotation:false,canSubmitSourcing:false}};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async canDownloadOriginal(actor:TrustedActorContext,orderId:string,version:number,attachmentId:string){
    const {sheet}=await this.originalVersion(actor,orderId,version);
    return Boolean(sheet.document?.imageAttachmentIds.includes(attachmentId))&&this.canDownload(actor,orderId,attachmentId);
  }
  private async bindFiles(db: PoolClient, actor: TrustedActorContext, orderId: string, doc: BudgetDocument) {
    for (const attachmentId of [...doc.imageAttachmentIds].sort()) {
      const file = (await db.query("SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE", [attachmentId])).rows[0];
      if (!file || file.status !== "ready" || !["image/jpeg", "image/png", "image/webp"].includes(file.mime_type)) conflict("预算图片必须上传完成且为 JPG、PNG 或 WebP");
      if (file.entity_type ? file.entity_type !== "digital_budget" || file.entity_id !== orderId : file.uploaded_by !== actor.actorId) digitalForbidden();
      await db.query("UPDATE attachments SET entity_type='digital_budget',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [attachmentId, orderId]);
      await db.query("INSERT INTO digital_budget_attachment_bindings(attachment_id,production_order_id,bound_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [attachmentId, orderId, actor.actorId]);
    }
  }
  async save(actor: TrustedActorContext, orderId: string, input: { expectedVersion: number; document: BudgetDocument }, key: string) {
    return this.command(actor, orderId, "save", key, input, async db => {
      // Older budget records exist before quotation references were introduced.
      const row = (await db.query(`SELECT version,to_jsonb(budget)->>'quote_id' AS quote_id,
        (to_jsonb(budget)->>'quote_version')::int AS quote_version FROM digital_budget_documents budget WHERE production_order_id=$1`, [orderId])).rows[0];
      if ((row?.version ?? 0) !== input.expectedVersion) conflict("预算已更新，本次未覆盖；请本单设计师或跟单在预算页重新读取最新版本，核对后再保存");
      const document=budgetWithIePrice(input.document,await readBudgetIeAdoption(db,orderId,row));
      await this.bindFiles(db, actor, orderId, document);
      await db.query(`INSERT INTO digital_budget_documents(production_order_id,version,status,document,updated_by) VALUES($1,1,'draft',$2,$3)
        ON CONFLICT(production_order_id) DO UPDATE SET version=digital_budget_documents.version+1,status='draft',document=EXCLUDED.document,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP,published_at=NULL`, [orderId, JSON.stringify(document), actor.actorId]);
      return this.read(actor, orderId, db);
    });
  }
  async adoptQuotation(actor:TrustedActorContext,orderId:string,input:{expectedVersion:number;sourceQuoteVersion:number},key:string){
    return this.command(actor,orderId,'adopt',key,input,async db=>{
      const row=(await db.query('SELECT * FROM digital_budget_documents WHERE production_order_id=$1',[orderId])).rows[0];
      if((row?.version??0)!==input.expectedVersion)conflict('预算已更新，请读取当前版本后明确采用报价');
      const quote=(await db.query('SELECT q.quote_id,q.confirmed_version,v.document FROM digital_quotation_documents q JOIN digital_quotation_versions v ON v.quote_id=q.quote_id AND v.version=q.confirmed_version WHERE q.production_order_id=$1',[orderId])).rows[0];
      if(!quote||quote.confirmed_version!==input.sourceQuoteVersion)conflict('客户确认报价版本已变，请重新核对');
      if(row?.quote_id===quote.quote_id&&row.quote_version===quote.confirmed_version&&row.status==='published')return this.read(actor,orderId,db);
      const ie=await readBudgetIeAdoption(db,orderId,{quote_id:quote.quote_id,quote_version:quote.confirmed_version});
      const original=(row?.document??quote.document) as BudgetDocument;
      const newBasis=ie.basis;
      const adoptedRow=newBasis?(quote.document as BudgetDocument).rows.find(item=>item.rowId===newBasis.rowId):null;
      const previous=row?.quote_id&&row.quote_version&&newBasis?(await db.query(
        `SELECT to_jsonb(v)->'assembly' AS assembly FROM digital_quotation_versions v WHERE v.quote_id=$1 AND v.version=$2`,
        [row.quote_id,row.quote_version])).rows[0]?.assembly?.rows as Record<string,{kind:string;sourceRef:string}>|undefined:undefined;
      const replaces=(id:string)=>id===newBasis?.rowId||previous?.[id]?.kind==='ie'&&previous[id]?.sourceRef==='ie:processing';
      const document=budgetWithIePrice(ie.required?{...original,outsourcingUnitPrice:'',rows:adoptedRow?
        [...original.rows.filter(item=>!replaces(item.rowId)),adoptedRow]:original.rows}:original,ie);
      const next=(row?.version??0)+1;
      await db.query('INSERT INTO digital_budget_quote_conversions(production_order_id,quote_id,quote_version,created_budget_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[orderId,quote.quote_id,quote.confirmed_version,next]);
      await db.query(`INSERT INTO digital_budget_documents(production_order_id,version,status,document,updated_by,quote_id,quote_version) VALUES($1,$2,'draft',$3,$4,$5,$6)
        ON CONFLICT(production_order_id) DO UPDATE SET version=EXCLUDED.version,status='draft',document=EXCLUDED.document,quote_id=EXCLUDED.quote_id,quote_version=EXCLUDED.quote_version,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP,published_at=NULL`,[orderId,next,JSON.stringify(document),actor.actorId,quote.quote_id,quote.confirmed_version]);
      return this.read(actor,orderId,db);
    });
  }
  async publish(actor: TrustedActorContext, orderId: string, expectedVersion: number, key: string,sourceQuoteVersion?:number) {
    return this.command(actor, orderId, "publish", key, { expectedVersion,...(sourceQuoteVersion!==undefined?{sourceQuoteVersion}:{}) }, async db => {
      const row = (await db.query("SELECT * FROM digital_budget_documents WHERE production_order_id=$1", [orderId])).rows[0] ?? conflict("请先在本单预算页保存预算草稿，再由本单跟单核对并最终发布；草稿保存本身不会发起外发");
      if (row.version !== expectedVersion) conflict("预算已更新，本次未发布；请本单跟单在预算页重新读取最新草稿，核对后再发布");
      if (row.status === "published") return this.read(actor, orderId, db);
      const document=budgetWithIePrice(row.document,await readBudgetIeAdoption(db,orderId,row));
      const errors = budgetPublishErrors(document);
      if (errors.length) throw new ApplicationError("VALIDATION_ERROR", `${errors.join("；")}；请本单设计师或跟单在预算页逐项补齐后重新发布`, 400);
      await this.bindFiles(db, actor, orderId, document);
      const comparison=await readBudgetQuoteComparison(db,orderId,{...row,document});
      if(comparison.policy==='quote_v1'){
        if(sourceQuoteVersion!==undefined&&sourceQuoteVersion!==comparison.quoteVersion||comparison.state!=='within_limit')throw new ApplicationError(comparison.state==='exceeds'?'BUDGET_TOTAL_EXCEEDS_QUOTE':'BUDGET_QUOTE_BASIS_CONFLICT',comparison.reason,409);
        await db.query(`INSERT INTO digital_budget_versions(production_order_id,version,document,totals,published_by,quote_id,quote_version,budget_comparable_total,confirmed_quote_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[orderId,row.version,JSON.stringify(document),JSON.stringify(calculateBudget(document)),actor.actorId,comparison.quoteId,comparison.quoteVersion,comparison.budgetComparableTotal,comparison.confirmedQuoteTotal]);
      }else await db.query("INSERT INTO digital_budget_versions(production_order_id,version,document,totals,published_by) VALUES($1,$2,$3,$4,$5)", [orderId, row.version, JSON.stringify(document), JSON.stringify(calculateBudget(document)), actor.actorId]);
      await db.query("UPDATE digital_budget_documents SET status='published',published_at=$3,updated_by=$2,document=$4 WHERE production_order_id=$1", [orderId, actor.actorId,businessNow().toISOString(),JSON.stringify(document)]);
      await db.query("INSERT INTO digital_budget_preparations(production_order_id,budget_version) VALUES($1,$2) ON CONFLICT(production_order_id) DO UPDATE SET budget_version=EXCLUDED.budget_version", [orderId, row.version]);
      const preparation = (await db.query("SELECT task_id FROM digital_budget_preparations WHERE production_order_id=$1", [orderId])).rows[0];
      if (!preparation.task_id) {
        const order = await this.order(db, actor, orderId);
        const assigneeId = order.primary_merchandiser_id && await new DigitalProductionAccessPolicy(db).activeRole(order.primary_merchandiser_id, "order_merchandiser") ? order.primary_merchandiser_id : null;
        const { taskId } = await new DigitalProductionTaskService(this.database).createWithClient(db, actor, { resource: { kind: "order", id: orderId }, kind: "sourcing_preparation", routeId: randomUUID(), routeVersion: 1, occurrence: 1, assigneeId });
        await db.query("UPDATE digital_budget_preparations SET task_id=$2 WHERE production_order_id=$1", [orderId, taskId]);
      }
      return this.read(actor, orderId, db);
    });
  }
}
