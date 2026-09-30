import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  CONTRACT_SUPPLIER_FIELDS, CONTRACT_TERM_LABELS, ContractTemplateSchema,
  type ContractTemplate, type ContractTemplateContent, type ContractTemplateState, type ContractContent,
  type ContractRefreshPreview, type SaveContractTemplate, type RefreshContractInformation,
} from "@dx-rework/contracts";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { renderSourcingContractPdf } from "./sourcing-contract-pdf.js";

const root = (actor: TrustedActorContext): boolean => actor.actorRoles.includes("root_superuser");
type SupplierField = keyof typeof CONTRACT_SUPPLIER_FIELDS;
type SupplierValues = Record<SupplierField, string>;
type CurrentContract = {
  sourcing_contract_document_id: string; sourcing_case_id: string;
  sourcing_approval_snapshot_id: string; sourcing_decision_id: string;
  contract_version: number; template_version: number; identity_version: number;
  information_revision: number; approval_snapshot: Record<string, unknown>;
  status: string; created_by: string; returned: boolean;
};
type Queryable = Pick<Pool | PoolClient, "query">;
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const canRefreshContractInformation = (actor: TrustedActorContext, createdBy: string, returned: boolean): boolean => {
  if (root(actor)) return true;
  if (returned) return false;
  const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
  return (actor.actorRoles.includes("production_management") && capabilities.includes("sourcing:decision:record"))
    || (actor.actorRoles.includes("order_merchandiser") && actor.actorId === createdBy
      && capabilities.includes("sourcing:contract:record"));
};

export class SourcingContractManagementService {
  constructor(private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository()) {}

  private assertRoot(actor: TrustedActorContext): void {
    if (!root(actor)) throw new ApplicationError("FORBIDDEN", "仅Root可设置合同模板", 403);
  }

  private async templateVersions(db:Queryable):Promise<ContractTemplate[]> {
    const result = await db.query(`SELECT template_version AS "templateVersion",
      template_name AS "templateName",party_a_name AS "partyAName",party_a_address AS "partyAAddress",
      signing_place AS "signingPlace",terms,created_at AS "createdAt"
      FROM sourcing_contract_template_versions WHERE template_version>=4 AND effective_from<=CURRENT_TIMESTAMP
      ORDER BY template_version DESC`);
    const items = result.rows.map(row => ContractTemplateSchema.parse({...row,createdAt:new Date(row.createdAt).toISOString()}));
    if (!items[0]) throw new ApplicationError("INVALID_STATE_TRANSITION", "合同模板尚未完成初始化", 409);
    return items;
  }
  async templates(actor: TrustedActorContext): Promise<ContractTemplateState> {
    this.assertRoot(actor);
    const items=await this.templateVersions(this.database);
    return {item:items[0]!,history:items.slice(1)};
  }

  async saveTemplate(actor: TrustedActorContext, input: SaveContractTemplate, key: string): Promise<ContractTemplateState> {
    this.assertRoot(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await this.idempotency.execute(client, {scope:"sourcing.contract.template.save",actorKey:actor.actorId,key,
        requestHash:fingerprint(input),expiresAt:new Date(Date.now()+86400000)}, async () => {
        await client.query("LOCK TABLE sourcing_contract_template_versions IN EXCLUSIVE MODE");
        const current = (await client.query<{template_version:number}>("SELECT max(template_version) AS template_version FROM sourcing_contract_template_versions")).rows[0]!;
        if (current.template_version !== input.expectedVersion) throw new ApplicationError("INVALID_STATE_TRANSITION", "模板已更新，请重新加载后修改", 409);
        const version = current.template_version + 1;
        const content = {templateName:input.templateName,partyAName:input.partyAName,
          partyAAddress:input.partyAAddress,signingPlace:input.signingPlace,terms:input.terms};
        const eventId = await this.events.append(client,actor,{action:"sourcing.contract.template.save",
          entityType:"sourcing_contract_template",entityId:String(version),
          before:{templateVersion:current.template_version},after:{templateVersion:version,...content},reason:"Root修改合同模板"});
        await client.query(`INSERT INTO sourcing_contract_template_versions(
          template_version,template_name,party_a_name,party_a_address,signing_place,terms,effective_from,operation_event_id)
          VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7)`,
          [version,input.templateName,input.partyAName,input.partyAAddress,input.signingPlace,input.terms,eventId]);
        return {statusCode:200,response:{templateVersion:version}};
      });
      await client.query("COMMIT");
      return await this.templates(actor);
    } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally {client.release();}
  }

  async previewTemplate(actor: TrustedActorContext, input: ContractTemplateContent): Promise<Buffer> {
    this.assertRoot(actor);
    return renderSourcingContractPdf({templateVersion:4,contractNumber:"模板预览（示例）",contractDate:"2026-09-30",
      partyAName:input.partyAName,partyAAddress:input.partyAAddress,signingPlace:input.signingPlace,
      partyBName:"示例供应商",partyBAddress:"示例供应商地址",partyBRepresentative:"示例代表",
      payeeName:"示例收款人",bankAccount:"示例银行账号",bankName:"示例开户行",
      gender:"女装",styleName:"示例款式",estimatedCutPieceSendDate:"2026-10-07",deliveryDate:"2026-10-25",
      processes:["车缝","剪线","查货","单程运费","公司做尾","本厂装箱"],
      lines:[{position:1,styleNo:"示例款号",alternateStyleNo:null,color:"红色",quantity:818,unitPrice:"18.2",totalAmount:"14887.60"}],
      totalQuantity:818,totalAmount:"14887.60",terms:input.terms});
  }

  private async current(db: Queryable, actor: TrustedActorContext, caseId: string): Promise<CurrentContract> {
    const row = (await db.query<CurrentContract>(`SELECT document.*,source.created_by,
      EXISTS(SELECT 1 FROM sourcing_contract_return_submissions WHERE sourcing_case_id=source.sourcing_case_id) AS returned
      FROM sourcing_contract_documents document JOIN sourcing_cases source USING(sourcing_case_id)
      WHERE source.sourcing_case_id=$1 AND source.deleted_at IS NULL
      ORDER BY document.contract_version DESC LIMIT 1`,[caseId])).rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "合同不存在", 404);
    if (!canRefreshContractInformation(actor,row.created_by,row.returned)
      || (!root(actor) && !await memberCanWriteModule(db,actor.actorId,"sourcing"))) {
      throw new ApplicationError("FORBIDDEN", row.returned ? "已回传合同仅Root可以更新" : "无权更新此合同的供应商资料",403);
    }
    if (row.status === "generating") throw new ApplicationError("INVALID_STATE_TRANSITION","合同正在生成，请完成后再更新",409);
    return row;
  }

  private async override(db:Queryable,row:CurrentContract):Promise<ContractContent | null> {
    return (await db.query<{content:ContractContent}>("SELECT content FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=$1",[row.sourcing_contract_document_id])).rows[0]?.content ?? null;
  }
  private async effectiveSupplier(db:Queryable,row:CurrentContract):Promise<Record<string,unknown>> {
    const supplements=(await db.query<{field_name:string;field_value:string}>("SELECT field_name,field_value FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=$1",[row.sourcing_contract_document_id])).rows;
    const content=await this.override(db,row);
    return {...row.approval_snapshot,...Object.fromEntries(supplements.map(x=>[x.field_name,x.field_value])),...(content?{
      contractEntityName:content.partyBName,address:content.partyBAddress,partyBRepresentative:content.partyBRepresentative,
      payeeName:content.payeeName,bankAccount:content.bankAccount,bankName:content.bankName}: {})};
  }
  private async supplier(db: Queryable, row: CurrentContract): Promise<{values:SupplierValues;hash:string}> {
    // The catalog view substitutes supplier_name for an absent legal entity.
    // Read the raw version field so that substitution cannot erase contract-only values.
    const profile = (await db.query<{version:number;active:boolean;values:SupplierValues}>(`SELECT catalog.version,catalog.active,
      jsonb_build_object('supplierName',catalog.supplier_name,'supplierCode',catalog.supplier_code,
        'contractEntityName',COALESCE(raw.contract_entity_name,''),'address',COALESCE(catalog.address,''),
        'partyBRepresentative',COALESCE(catalog.party_b_representative,''),'payeeName',COALESCE(catalog.payee_name,''),
        'bankAccount',COALESCE(catalog.bank_account,''),'bankName',COALESCE(catalog.bank_name,'')) AS values
      FROM current_supplier_catalog catalog JOIN supplier_catalog_versions raw USING(supplier_id,version)
      WHERE catalog.supplier_id=$1`,[row.approval_snapshot.supplierId])).rows[0];
    if (!profile) throw new ApplicationError("NOT_FOUND","供应商资料不存在",404);
    // Contract-only supplements remain valid when the master profile still has no value.
    const old = await this.effectiveSupplier(db,row);
    const values = Object.fromEntries((Object.keys(CONTRACT_SUPPLIER_FIELDS) as SupplierField[]).map(field=>[
      field,profile.values[field] || String(old[field] ?? (field === "contractEntityName" ? old.supplierName ?? "" : "")),
    ])) as SupplierValues;
    return {values,hash:fingerprint({supplierId:row.approval_snapshot.supplierId,...profile,values})};
  }

  private async differences(db: Queryable, row: CurrentContract, values: SupplierValues): Promise<ContractRefreshPreview["changes"]> {
    const old = await this.effectiveSupplier(db,row);
    return (Object.keys(CONTRACT_SUPPLIER_FIELDS) as SupplierField[]).flatMap(field => {
      const before = String(old[field] ?? (field === "contractEntityName" ? old.supplierName ?? "" : ""));
      return before === values[field] ? [] : [{field,before,after:values[field]}];
    });
  }

  async previewInformation(actor: TrustedActorContext, caseId: string): Promise<ContractRefreshPreview> {
    const row = await this.current(this.database,actor,caseId);
    const profile = await this.supplier(this.database,row);
    const templates = await this.templateVersions(this.database);
    const latest = templates[0]!;
    return {sourcingContractDocumentId:row.sourcing_contract_document_id,informationFingerprint:fingerprint({supplier:profile.hash,template:latest}),returned:row.returned,
      changes:[...await this.differences(this.database,row,profile.values),...await this.templateDifferences(this.database,row,latest)],
      missingFields:(Object.keys(CONTRACT_SUPPLIER_FIELDS) as SupplierField[]).filter(field=>!profile.values[field].trim())};
  }

  private async templateDifferences(db:Queryable,row:CurrentContract,latest:ContractTemplate):Promise<ContractRefreshPreview["changes"]> {
    if(Number(row.template_version)===latest.templateVersion)return [];
    const stored = (await db.query<{party_a_name:string;party_a_address:string;signing_place:string;terms:Record<string,string>}>(
      "SELECT * FROM sourcing_contract_template_versions WHERE template_version=$1",[row.template_version])).rows[0]!;
    const content=await this.override(db,row);
    const previous=content ? {party_a_name:content.partyAName,party_a_address:content.partyAAddress,signing_place:content.signingPlace,terms:content.terms} : stored;
    const changes:ContractRefreshPreview["changes"]=[{field:"templateVersion",before:`V${row.template_version}`,after:`V${latest.templateVersion}`}];
    for(const field of ["partyAName","partyAAddress","signingPlace"] as const){
      const before={partyAName:previous.party_a_name,partyAAddress:previous.party_a_address,signingPlace:previous.signing_place}[field]??"";
      if(before!==latest[field])changes.push({field,before,after:latest[field]});
    }
    for(const field of Object.keys(CONTRACT_TERM_LABELS) as (keyof typeof CONTRACT_TERM_LABELS)[]){
      const before=previous.terms[field]??(field==="processingResponsibility"?"乙方负责{{工艺}}，甲方提供样板及面/辅料。":"");
      if(before!==latest.terms[field])changes.push({field,before,after:latest.terms[field]});
    }
    return changes;
  }

  async refreshInformation(actor: TrustedActorContext, caseId: string, input: RefreshContractInformation, key: string): Promise<string> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // Same order lock as approval, style edits, dispatch and contract-return uploads.
      await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE",[caseId]);
      await client.query("SELECT sourcing_case_id FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1 FOR UPDATE",[caseId]);
      const result = await this.idempotency.execute<{documentId:string}>(client,{
        scope:"sourcing.contract.information.refresh",actorKey:actor.actorId,key,requestHash:fingerprint({caseId,input}),
        expiresAt:new Date(Date.now()+86400000)},async()=>{
        const row = await this.current(client,actor,caseId);
        // Lock the master item so an authorized profile writer cannot change it between validation and insert.
        await client.query("SELECT supplier_id FROM supplier_catalog_items WHERE supplier_id=$1 FOR SHARE",[row.approval_snapshot.supplierId]);
        await client.query("LOCK TABLE sourcing_contract_template_versions IN SHARE MODE");
        const profile = await this.supplier(client,row);
        const latest = (await this.templateVersions(client))[0]!;
        if (row.sourcing_contract_document_id !== input.sourcingContractDocumentId || fingerprint({supplier:profile.hash,template:latest}) !== input.informationFingerprint) {
          throw new ApplicationError("INVALID_STATE_TRANSITION","合同或供应商资料已变化，请重新查看差异后更新",409);
        }
        if (Object.values(profile.values).some(value=>!value.trim())) throw new ApplicationError("VALIDATION_ERROR","供应商合同资料不完整，请由有维护权限的人员补齐后更新",422);
        const changes = [...await this.differences(client,row,profile.values),...await this.templateDifferences(client,row,latest)];
        if (!changes.length) return {statusCode:200,response:{documentId:row.sourcing_contract_document_id}};
        const id = randomUUID();
        const previousContent=await this.override(client,row);
        const inherited=previousContent ? {...previousContent,partyBName:profile.values.contractEntityName,partyBAddress:profile.values.address,
          partyBRepresentative:profile.values.partyBRepresentative,payeeName:profile.values.payeeName,bankAccount:profile.values.bankAccount,bankName:profile.values.bankName,
          ...(Number(row.template_version)!==latest.templateVersion?{partyAName:latest.partyAName,partyAAddress:latest.partyAAddress,signingPlace:latest.signingPlace,terms:latest.terms}:{})} : null;
        const eventId = await this.events.append(client,actor,{action:"sourcing.contract.information.refresh",
          entityType:"sourcing_contract_document",entityId:id,
          before:{documentId:row.sourcing_contract_document_id},after:{supplierValues:profile.values,templateVersion:latest.templateVersion,changes,returned:row.returned,...(inherited?{mode:"inherit_content",content:inherited}:{})},
          reason:row.returned?"Root更新已回传合同信息":"同步最新供应商资料及合同模板"});
        const supplements = (await client.query<{field_name:string;field_value:string}>(
          "SELECT field_name,field_value FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=$1",[row.sourcing_contract_document_id])).rows;
        const snapshot = {...row.approval_snapshot,...Object.fromEntries(supplements.map(x=>[x.field_name,x.field_value])),...profile.values};
        await client.query(`INSERT INTO sourcing_contract_documents(
          sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,
          contract_version,contract_number,template_version,approval_snapshot,missing_fields,status,prepared_by,
          identity_version,revision_of,information_revision,information_refresh_event_id)
          VALUES($1,$2,$3,$4,$5,'DX-WF-'||to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')||'-'||lpad(nextval('sourcing_contract_number_seq')::text,6,'0'),
            $6,$7,'{}','generation_pending',$8,$9,$10,$11,$12)`,
          [id,caseId,row.sourcing_approval_snapshot_id,row.sourcing_decision_id,Number(row.contract_version)+1,latest.templateVersion,
            snapshot,actor.actorId,row.identity_version,row.sourcing_contract_document_id,Number(row.information_revision)+1,eventId]);
        if (inherited) await client.query("INSERT INTO sourcing_contract_content_overrides(sourcing_contract_document_id,content,operation_event_id) VALUES($1,$2,$3)",[id,inherited,eventId]);
        return {statusCode:200,response:{documentId:id}};
      });
      await client.query("COMMIT");
      return result.response.documentId;
    } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally {client.release();}
  }
}
