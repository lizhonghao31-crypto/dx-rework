import { contractFactoryState, normalizeFactoryContract, editFactoryPoDates } from "../production-platform/po-factory-date-adapter.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ContractContentSchema, type ContractContent, type ContractContentState, type SaveContractContent } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import type { AttachmentService } from "../tools/attachments.js";
import { normalizeSourcingContractImage, renderSourcingContractPdf, type ContractPdfSnapshot } from "./sourcing-contract-pdf.js";

type Queryable = Pick<Pool | PoolClient,"query">;
const hash = (value: unknown):string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const canEditContractContent = (actor:TrustedActorContext,reconciled:boolean):boolean =>
  actor.actorRoles.includes("root_superuser") && !reconciled;
const assertRoot = (actor:TrustedActorContext):void => {
  if (!actor.actorRoles.includes("root_superuser")) throw new ApplicationError("FORBIDDEN","仅Root可修改合同内容",403);
};
export async function loadContractContent(db:Queryable,documentId:string):Promise<ContractPdfSnapshot> {
  const row = (await db.query(`SELECT d.*,t.party_a_name,t.party_a_address,t.signing_place,t.terms,o.content
    FROM sourcing_contract_documents d JOIN sourcing_contract_template_versions t USING(template_version)
    LEFT JOIN sourcing_contract_content_overrides o USING(sourcing_contract_document_id)
    WHERE d.sourcing_contract_document_id=$1`,[documentId])).rows[0];
  if (!row) throw new ApplicationError("NOT_FOUND","合同不存在",404);
  // Overrides use the full-content PDF layout, including edits to legacy templates.
  // The document's stored template_version remains its actual template provenance.
  if (row.content) return {...ContractContentSchema.parse(row.content),templateVersion:Math.max(4,Number(row.template_version))};
  const supplements = (await db.query("SELECT field_name,field_value FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=$1",[documentId])).rows;
  const approval = row.approval_snapshot as Record<string,unknown>;
  const values = {...approval,...Object.fromEntries(supplements.map(x=>[x.field_name,x.field_value]))};
  const parts = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(String(approval.approvedAt ?? row.prepared_at)));
  const date = ["year","month","day"].map(key=>parts.find(p=>p.type===key)?.value ?? "").join("-");
  const lines = Array.isArray(approval.lines) ? approval.lines as Record<string,unknown>[] : [];
  return {
    templateVersion:Number(row.template_version),contractNumber:row.contract_number,contractDate:date,
    partyAName:row.party_a_name,partyAAddress:row.party_a_address ?? "历史未维护",signingPlace:row.signing_place,
    partyBName:String(values.contractEntityName || approval.supplierName || ""),partyBAddress:String(values.address ?? ""),
    partyBRepresentative:String(values.partyBRepresentative ?? ""),payeeName:String(values.payeeName ?? ""),
    bankAccount:String(values.bankAccount ?? ""),bankName:String(values.bankName ?? ""),
    gender:typeof approval.gender==="string"?approval.gender:"历史未维护",styleName:typeof approval.styleName==="string"?approval.styleName:"历史未维护",
    estimatedCutPieceSendDate:String(approval.estimatedCutPieceSendDate ?? "未维护"),deliveryDate:String(approval.deliveryDate ?? "未维护"),
    processes:Array.isArray(approval.processes)?approval.processes.map(String):[],
    lines:lines.map(line=>({position:Number(line.position),styleNo:String(line.styleNo ?? ""),alternateStyleNo:line.alternateStyleNo?String(line.alternateStyleNo):null,
      ...(typeof line.lineId==="string"?{lineId:line.lineId}:{}),...(typeof line.deliveryDate==="string"?{deliveryDate:line.deliveryDate}:{}),
      color:line.color?String(line.color):null,quantity:Number(line.quantity),unitPrice:String(line.unitPrice),totalAmount:String(line.totalAmount),
      ...(typeof line.imageAttachmentId==="string"?{imageAttachmentId:line.imageAttachmentId,...(typeof line.imageSha256==="string"?{imageSha256:line.imageSha256}:{})}:{})})),
    totalQuantity:Number(approval.quantity),totalAmount:String(approval.totalAmount),terms:row.terms,
  };
}
export async function hydrateContractContentImages(attachments:AttachmentService,caseId:string,snapshot:ContractPdfSnapshot):Promise<ContractPdfSnapshot> {
  const images = new Map<string,{bytes:Buffer;sha256:string}>();
  for (const line of snapshot.lines) {
    if (!line.imageAttachmentId || images.has(line.imageAttachmentId)) continue;
    const image = await attachments.readContractContentImage(caseId,line.imageAttachmentId);
    if (line.imageSha256 && line.imageSha256!==image.sha256) throw new ApplicationError("ATTACHMENT_METADATA_MISMATCH","合同款图与冻结快照不一致",422);
    images.set(line.imageAttachmentId,{bytes:await normalizeSourcingContractImage(image.bytes),sha256:image.sha256});
  }
  return {...snapshot,lines:snapshot.lines.map(line=>({...line,...(line.imageAttachmentId?{imageBytes:images.get(line.imageAttachmentId)!.bytes,imageSha256:images.get(line.imageAttachmentId)!.sha256}:{})}))};
}

export class SourcingContractContentService {
  constructor(private readonly database:Pool,private readonly attachments:AttachmentService,
    private readonly idempotency=new IdempotencyService(),private readonly events=new OperationEventRepository()) {}
  private async current(db:Queryable,actor:TrustedActorContext,caseId:string) {
    assertRoot(actor);
    const row = (await db.query(`SELECT d.*,EXISTS(SELECT 1 FROM sourcing_finance_reconciliations f WHERE f.sourcing_case_id=d.sourcing_case_id) AS reconciled
      FROM sourcing_contract_documents d JOIN sourcing_cases s USING(sourcing_case_id)
      WHERE s.sourcing_case_id=$1 AND s.deleted_at IS NULL ORDER BY d.contract_version DESC LIMIT 1`,[caseId])).rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND","合同不存在",404);
    if (!canEditContractContent(actor,row.reconciled)) throw new ApplicationError("FORBIDDEN","财务已核对合同，Root也不能修改合同内容",403);
    if (row.status!=="ready") throw new ApplicationError("INVALID_STATE_TRANSITION","请先完成当前合同生成",409);
    return row;
  }
  async get(actor:TrustedActorContext,caseId:string):Promise<ContractContentState> {
    const row = await this.current(this.database,actor,caseId);
    const {templateVersion,...snapshot} = await loadContractContent(this.database,row.sourcing_contract_document_id);
    // Older templates did not store this dynamic clause; expose its actual rendered text.
    const responsibility = templateVersion && templateVersion>=4 ? snapshot.terms.processingResponsibility : "乙方负责{{工艺}}，甲方提供样板及面/辅料。";
    const content = ContractContentSchema.parse({...snapshot,contractTitle:snapshot.contractTitle ?? "服装加工合同",partyARepresentative:snapshot.partyARepresentative ?? "",
      partyASigningDate:snapshot.partyASigningDate ?? "",partyBSigningDate:snapshot.partyBSigningDate ?? "",terms:{...snapshot.terms,processingResponsibility:responsibility ?? ""}});
    return {sourcingContractDocumentId:row.sourcing_contract_document_id,informationFingerprint:row.snapshot_fingerprint,...await contractFactoryState(this.database,caseId,content,row.sourcing_contract_document_id)};
  }
  private async images(client:Queryable,actor:TrustedActorContext,caseId:string,content:ContractContent,bindTo?:string):Promise<ContractContent> {
    const hashes = new Map<string,string>();
    for (const line of content.lines) {
      const id=line.imageAttachmentId;
      if (!id || hashes.has(id)) continue;
      const row = (await client.query(`SELECT a.* FROM attachments a WHERE a.attachment_id=$1 AND a.status='ready'
        AND a.mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE`,[id])).rows[0];
      if (!row) throw new ApplicationError("ATTACHMENT_NOT_READY","款图尚未上传完成",422);
      const unbound = row.entity_type===null && row.entity_id===null && row.uploaded_by===actor.actorId;
      if (unbound) {
        const image = await this.attachments.readUnboundSourcingImage(client,actor.actorId,id);
        await normalizeSourcingContractImage(image.bytes);
        if (bindTo) await client.query("UPDATE attachments SET entity_type='sourcing_contract_document',entity_id=$2 WHERE attachment_id=$1",[id,bindTo]);
        hashes.set(id,image.sha256);
      } else {
        const belongs = row.entity_type==='sourcing_case' && row.entity_id===caseId || row.entity_type==='sourcing_contract_document'
          && (await client.query("SELECT 1 FROM sourcing_contract_documents WHERE sourcing_case_id=$1 AND sourcing_contract_document_id::text=$2",[caseId,row.entity_id])).rowCount;
        if (!belongs) throw new ApplicationError("FORBIDDEN","不得使用其他订单或账号的款图",403);
        const image = await this.attachments.readContractContentImage(caseId,id);
        await normalizeSourcingContractImage(image.bytes);
        hashes.set(id,image.sha256);
      }
    }
    return {...content,lines:content.lines.map(line=>({...line,...(line.imageAttachmentId?{imageSha256:hashes.get(line.imageAttachmentId)!}:{imageSha256:undefined})}))};
  }
  async save(actor:TrustedActorContext,caseId:string,input:SaveContractContent,key:string):Promise<string> {
    assertRoot(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      // Finance reconciliation takes this same lock. Whichever completes first is observed here.
      await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE",[caseId]);
      const result = await this.idempotency.execute<{documentId:string}>(client,{scope:"sourcing.contract.content.save",actorKey:actor.actorId,key,
        requestHash:hash({caseId,input}),expiresAt:new Date(Date.now()+86400000)},async()=>{
        const row = await this.current(client,actor,caseId);
        if (row.sourcing_contract_document_id!==input.sourcingContractDocumentId || row.snapshot_fingerprint!==input.informationFingerprint)
          throw new ApplicationError("INVALID_STATE_TRANSITION","合同已更新，请重新打开后修改",409);
        await client.query("SELECT sourcing_case_id FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1 FOR UPDATE",[caseId]);
        const templateVersion=Number(row.template_version);
        const id=randomUUID();
        const normalized=await normalizeFactoryContract(client,caseId,input);
        const content=await this.images(client,actor,caseId,normalized.content);
        const supplements=(await client.query("SELECT field_name,field_value FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=$1",[row.sourcing_contract_document_id])).rows;
        const approvalSnapshot={...row.approval_snapshot,...Object.fromEntries(supplements.map(x=>[x.field_name,x.field_value]))};
        const supplierValues=Object.fromEntries(Object.entries(approvalSnapshot).filter(([k])=>["supplierName","supplierCode","address","contractEntityName","partyBRepresentative","payeeName","bankAccount","bankName"].includes(k)));
        const eventId=await this.events.append(client,actor,{action:"sourcing.contract.information.refresh",entityType:"sourcing_contract_document",entityId:id,
          before:{documentId:row.sourcing_contract_document_id},after:{mode:"manual_content",content,supplierValues,templateVersion},reason:"Root修改本单合同内容"});
        await editFactoryPoDates(client,actor,caseId,eventId,normalized.changes);
        await client.query(`INSERT INTO sourcing_contract_documents(sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,
          contract_version,contract_number,template_version,approval_snapshot,missing_fields,status,prepared_by,identity_version,revision_of,information_revision,information_refresh_event_id)
          VALUES($1,$2,$3,$4,$5,'DX-WF-'||to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')||'-'||lpad(nextval('sourcing_contract_number_seq')::text,6,'0'),
          $6,$7,'{}','generation_pending',$8,$9,$10,$11,$12)`,[id,caseId,row.sourcing_approval_snapshot_id,row.sourcing_decision_id,Number(row.contract_version)+1,
          templateVersion,approvalSnapshot,actor.actorId,row.identity_version,row.sourcing_contract_document_id,Number(row.information_revision)+1,eventId]);
        await this.images(client,actor,caseId,content,id);
        await client.query("INSERT INTO sourcing_contract_content_overrides(sourcing_contract_document_id,content,operation_event_id) VALUES($1,$2,$3)",[id,content,eventId]);
        return {statusCode:200,response:{documentId:id}};
      });
      await client.query("COMMIT");
      return result.response.documentId;
    } catch(e) {await client.query("ROLLBACK").catch(()=>undefined);throw e;} finally {client.release();}
  }
  async preview(actor:TrustedActorContext,caseId:string,input:SaveContractContent):Promise<Buffer> {
    assertRoot(actor);
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      const row=await this.current(client,actor,caseId);
      if (row.sourcing_contract_document_id!==input.sourcingContractDocumentId || row.snapshot_fingerprint!==input.informationFingerprint)
        throw new ApplicationError("INVALID_STATE_TRANSITION","合同已更新，请重新打开后修改",409);
      const normalized=await normalizeFactoryContract(client,caseId,input);
      const content=await this.images(client,actor,caseId,normalized.content);
      const lines=[];
      for (const line of content.lines) {
        if (!line.imageAttachmentId) {lines.push(line);continue;}
        const meta=(await client.query("SELECT entity_type FROM attachments WHERE attachment_id=$1",[line.imageAttachmentId])).rows[0];
        const image=meta.entity_type===null ? await this.attachments.readUnboundSourcingImage(client,actor.actorId,line.imageAttachmentId)
          : await this.attachments.readContractContentImage(caseId,line.imageAttachmentId);
        lines.push({...line,imageBytes:await normalizeSourcingContractImage(image.bytes)});
      }
      return await renderSourcingContractPdf({...content,templateVersion:4,lines});
    } finally {await client.query("ROLLBACK").catch(()=>undefined);client.release();}
  }
}
