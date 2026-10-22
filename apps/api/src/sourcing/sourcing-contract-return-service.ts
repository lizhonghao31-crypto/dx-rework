import { transferContractVersionPrefix } from "./sourcing-transfer-contract-todos.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { OperationEventRepository } from "../tools/repositories.js";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { ApplicationError } from "../platform/errors.js";
import { TodoProjectionService } from "../todos/projection-service.js";
import { TodoService } from "../todos/service.js";
import { contractReturnState } from "./contract-return-state.js";

const ROOT = "root_superuser";
const READ = "sourcing:view";
const MERCHANDISER = "order_merchandiser";
const MANAGEMENT = "production_management";
const OWNER = "owner_group";
const MIME_TYPES = ["application/pdf","image/jpeg","image/png"] as const;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

type MonitorRow = {
  sourcing_case_id: string;
  created_by: string;
  additional_merchandiser_user_id: string | null;
  contract_return_monitor_enabled: boolean | null;
  contract_return_catchup: boolean | null;
  contract_generated_at: Date | string | null;
  contract_return_due_at: Date | string | null;
  contract_returned_at: Date | string | null;
  contract_return_overdue_seconds: number | string | null;
  contract_return_uploaded_by: string | null;
  uploader_name: string | null;
  return_cycle_id: string | null;
  current_contract_returned: boolean;
  current_contract_accepts_upload: boolean;
  current_contract_document_id: string | null;
  as_of: Date | string;
};
type FileRow = { attachment_id: string; original_filename: string; mime_type: string; size_bytes: string;
  revision: number; submitted_at: Date | string; uploaded_by_name: string;
  signed_contract_document_id: string | null; signed_contract_version: number | null; signed_contract_number: string | null };
const forbidden = (): never => { throw new ApplicationError("FORBIDDEN","当前账号无权回传合同",403); };
const fileDto = (row: FileRow) => ({
  attachmentId: row.attachment_id,filename: row.original_filename,
  mimeType: row.mime_type as (typeof MIME_TYPES)[number],sizeBytes: Number(row.size_bytes),
});

export class SourcingContractReturnService {
  constructor(private readonly database: Pool, private readonly events = new OperationEventRepository(),
    private readonly todos = new TodoProjectionService(new TodoService(database))) {}

  private assertReader(actor: TrustedActorContext): void {
    if (!actor.actorRoles.includes(ROOT) || actor.authorizationCapability !== READ) {
      if (actor.authorizationCapability !== READ || !(actor.authorizationCapabilities ?? []).includes(READ)) forbidden();
    }
  }

  private async canUpload(actor: TrustedActorContext, creator: string, additional: string | null): Promise<boolean> {
    if (actor.actorRoles.includes(ROOT)) return true;
    if (!(await memberCanWriteModule(this.database,actor.actorId,"sourcing"))) return false;
    const capabilities = actor.authorizationCapabilities ?? [];
    return actor.actorRoles.includes(OWNER) && capabilities.includes("sourcing:owner:approve")
      || actor.actorRoles.includes(MANAGEMENT) && capabilities.includes("sourcing:decision:record")
      || actor.actorRoles.includes(MERCHANDISER)
        && (actor.actorId === creator || actor.actorId === additional) && capabilities.includes("sourcing:contract:record");
  }

  async get(actor: TrustedActorContext, sourcingCaseId: string) {
    this.assertReader(actor);
    const result = await this.database.query<MonitorRow>(`SELECT source_case.sourcing_case_id,source_case.created_by,
      nullif(to_jsonb(source_case)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
      monitor.contract_return_monitor_enabled,monitor.contract_return_catchup,monitor.contract_generated_at,monitor.contract_return_due_at,
      monitor.contract_returned_at,monitor.contract_return_uploaded_by,monitor.return_cycle_id,
      sourcing_contract_return_elapsed_seconds(monitor.contract_return_due_at,
        COALESCE(monitor.contract_returned_at,CURRENT_TIMESTAMP)) AS contract_return_overdue_seconds,
      uploader.display_name AS uploader_name,CURRENT_TIMESTAMP AS as_of,
      COALESCE((SELECT (decision.source_change_request_id IS NULL AND NOT EXISTS(SELECT 1 FROM sourcing_contract_return_cycles cycle WHERE cycle.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id)) OR document.status='ready'
        FROM sourcing_contract_documents document
        JOIN sourcing_decisions decision ON decision.sourcing_decision_id=document.sourcing_decision_id
        WHERE document.sourcing_case_id=source_case.sourcing_case_id
        ORDER BY document.contract_version DESC LIMIT 1),true) AS current_contract_accepts_upload,
      (SELECT document.sourcing_contract_document_id FROM sourcing_contract_documents document
        WHERE document.sourcing_case_id=source_case.sourcing_case_id
        ORDER BY document.contract_version DESC LIMIT 1) AS current_contract_document_id,
      EXISTS(SELECT 1 FROM sourcing_contract_return_submissions signed
        JOIN sourcing_contract_return_attachments link ON link.submission_id=signed.submission_id
        JOIN attachments file ON file.attachment_id=link.attachment_id AND file.status='ready'
        WHERE signed.sourcing_contract_document_id=(SELECT document.sourcing_contract_document_id
          FROM sourcing_contract_documents document WHERE document.sourcing_case_id=source_case.sourcing_case_id
          ORDER BY document.contract_version DESC LIMIT 1)) AS current_contract_returned
      FROM sourcing_cases source_case
      LEFT JOIN LATERAL sourcing_contract_return_facts(source_case.sourcing_case_id) monitor ON true
      LEFT JOIN app_users uploader ON uploader.id=COALESCE(
        monitor.contract_return_latest_uploaded_by,monitor.contract_return_uploaded_by)
      WHERE source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL`,[sourcingCaseId]);
    const row=result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND","外发订单不存在",404);
    const status=contractReturnState({ ...row,contract_return_monitor_enabled:row.contract_return_monitor_enabled === true },row.as_of);
    const canViewFile=actor.actorRoles.includes(ROOT)
      || (actor.authorizationCapabilities ?? []).includes(READ)
        && (actor.authorizationCapabilities ?? []).includes("supplier_contract_data:read");
    const files=canViewFile && status.contractReturnMonitoring
      ? await this.database.query<FileRow>(`SELECT submission.revision,submission.submitted_at,
        uploader.display_name AS uploaded_by_name,
        file.attachment_id,file.original_filename,file.mime_type,file.size_bytes,
        document.sourcing_contract_document_id AS signed_contract_document_id,
        document.contract_version AS signed_contract_version,COALESCE((SELECT content->>'contractNumber' FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=document.sourcing_contract_document_id),document.contract_number) AS signed_contract_number
        FROM sourcing_contract_return_submissions submission
        JOIN sourcing_contract_return_attachments link ON link.submission_id=submission.submission_id
        JOIN attachments file ON file.attachment_id=link.attachment_id AND file.status='ready'
        JOIN app_users uploader ON uploader.id=submission.submitted_by
        LEFT JOIN sourcing_contract_documents document ON document.sourcing_contract_document_id=submission.sourcing_contract_document_id
        WHERE submission.sourcing_case_id=$1
        ORDER BY submission.revision DESC,link.position`,[sourcingCaseId]) : null;
    const versions=new Map<number,{revision:number;submittedAt:string;uploadedByName:string;
      signedContractDocumentId:string|null;signedContractVersion:number|null;signedContractNumber:string|null;
      attachments:ReturnType<typeof fileDto>[] }>();
    for (const file of files?.rows ?? []) {
      if (!versions.has(file.revision)) versions.set(file.revision,{
        revision:file.revision,
        submittedAt:file.submitted_at instanceof Date ? file.submitted_at.toISOString() : new Date(file.submitted_at).toISOString(),
        uploadedByName:file.uploaded_by_name,
        signedContractDocumentId:file.signed_contract_document_id,
        signedContractVersion:file.signed_contract_version,signedContractNumber:file.signed_contract_number,
        attachments:[],
      });
      versions.get(file.revision)!.attachments.push(fileDto(file));
    }
    const [current,...history]=[...versions.values()];
    const totals=(await this.database.query<{count:number;bytes:string}>(`SELECT count(*)::int AS count,COALESCE(sum(file.size_bytes),0)::text AS bytes
      FROM sourcing_contract_return_submissions submission
      JOIN sourcing_contract_return_attachments link ON link.submission_id=submission.submission_id
      JOIN attachments file ON file.attachment_id=link.attachment_id
      WHERE submission.sourcing_case_id=$1
        AND submission.sourcing_contract_document_id IS NOT DISTINCT FROM $2::uuid`,[sourcingCaseId,row.current_contract_document_id])).rows[0] ?? {count:0,bytes:"0"};
    // Display additions together only when they belong to the same recorded contract version.
    const currentFiles=current ? [...versions.values()].filter(version=>version.signedContractDocumentId===current.signedContractDocumentId)
      .reverse().flatMap(version=>version.attachments) : [];

    return { ...status,contractReturnCycleId:row.return_cycle_id,uploadedByName:status.contractReturnMonitoring ? row.uploader_name : null,
      currentContractReturned:row.current_contract_returned,
      currentContractDocumentId:row.current_contract_document_id,
      signedContractDocumentId:current?.signedContractDocumentId ?? null,
      signedContractVersion:current?.signedContractVersion ?? null,signedContractNumber:current?.signedContractNumber ?? null,
      canUpload: status.contractReturnMonitoring && row.current_contract_accepts_upload
        && totals.count < 2 && Number(totals.bytes) < MAX_UPLOAD_BYTES && await this.canUpload(actor,row.created_by,row.additional_merchandiser_user_id),
      uploadedFileCount:totals.count,uploadedTotalBytes:Number(totals.bytes),
      attachments:currentFiles,history };
  }

  async submit(actor: TrustedActorContext,sourcingCaseId: string,attachmentIds: readonly string[],key: string,expectedContractDocumentId?: string | null) {
    if (!actor.actorRoles.includes(ROOT) && !(actor.authorizationCapabilities ?? []).includes(READ)) forbidden();
    if (!actor.actorRoles.includes(ROOT) &&
      !(
        actor.authorizationCapability === "sourcing:contract:record" && actor.actorRoles.includes(MERCHANDISER)
        || actor.authorizationCapability === "sourcing:owner:approve" && actor.actorRoles.includes(OWNER)
        || actor.authorizationCapability === "sourcing:decision:record" && actor.actorRoles.includes(MANAGEMENT)
      )) forbidden();
    if (attachmentIds.length < 1 || attachmentIds.length > 2 || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new ApplicationError("VALIDATION_ERROR","请上传 1 至 2 个不重复的回签合同文件",400);
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR","上传请求标识无效",400);
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      // Serialize version selection with refresh, style edits and approvals.
      await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE",[sourcingCaseId]);
      const locked=await client.query<MonitorRow>(`SELECT monitor.sourcing_case_id,source_case.created_by,
          nullif(to_jsonb(source_case)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
          monitor.contract_return_monitor_enabled,monitor.contract_return_catchup,monitor.contract_generated_at,monitor.contract_return_due_at,
          monitor.contract_returned_at,monitor.contract_return_uploaded_by,NULL::text AS uploader_name,
          NULL::bigint AS contract_return_overdue_seconds,
          CURRENT_TIMESTAMP AS as_of
        FROM sourcing_contract_return_monitors monitor
        JOIN sourcing_cases source_case ON source_case.sourcing_case_id=monitor.sourcing_case_id
        WHERE monitor.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
        FOR UPDATE OF monitor`,[sourcingCaseId]);
      const monitor=locked.rows[0];
      if (!monitor?.contract_return_monitor_enabled) {
        throw new ApplicationError("INVALID_STATE_TRANSITION","该订单尚未批准，暂不能回传合同",409);
      }
      if (!(await this.canUpload(actor,monitor.created_by,monitor.additional_merchandiser_user_id))) forbidden();
      const previous=await client.query<{submitted_by:string;attachment_ids:string[]}>(`SELECT submission.submitted_by,
        submission.attachment_ids
        FROM sourcing_contract_return_requests submission
        WHERE submission.sourcing_case_id=$1 AND submission.request_id=$2`,[sourcingCaseId,key]);
      if (previous.rows[0]) {
        if (previous.rows[0].submitted_by !== actor.actorId
          || JSON.stringify(previous.rows[0].attachment_ids)!==JSON.stringify(attachmentIds)) {
          throw new ApplicationError("INVALID_STATE_TRANSITION","该请求标识已用于另一份回签合同",409);
        }
        await client.query("COMMIT");
        return this.get({...actor,authorizationCapability:READ},sourcingCaseId);
      }
      const document=(await client.query<{sourcing_contract_document_id:string;is_transfer:boolean;status:string;requires_version:boolean}>(`SELECT document.sourcing_contract_document_id,document.status,
          EXISTS(SELECT 1 FROM sourcing_contract_return_cycles cycle WHERE cycle.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id) AS requires_version,
          EXISTS(SELECT 1 FROM sourcing_decisions decision WHERE decision.sourcing_decision_id=document.sourcing_decision_id
            AND decision.source_change_request_id IS NOT NULL) AS is_transfer
        FROM sourcing_contract_documents document WHERE document.sourcing_case_id=$1 ORDER BY document.contract_version DESC LIMIT 1`,[sourcingCaseId])).rows[0];
      const documentId=document?.sourcing_contract_document_id ?? null;
      if ((document?.is_transfer || document?.requires_version || expectedContractDocumentId !== undefined) && expectedContractDocumentId !== documentId) {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "合同版本已变化，请重新打开当前合同并回传对应版本", 409);
      }
      if ((document?.is_transfer || document?.requires_version) && document.status !== "ready") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "当前转厂合同尚未生成完成，请生成后再回传签署文件", 409);
      }
      const existing=await client.query<{attachment_id:string;size_bytes:string;submitted_by:string;sourcing_contract_document_id:string|null}>(`SELECT link.attachment_id::text,file.size_bytes,submission.submitted_by,submission.sourcing_contract_document_id
        FROM sourcing_contract_return_submissions submission
        JOIN sourcing_contract_return_attachments link ON link.submission_id=submission.submission_id
        JOIN attachments file ON file.attachment_id=link.attachment_id
        WHERE submission.sourcing_case_id=$1`,[sourcingCaseId]);
      // A fresh key may retry the very same already-bound files; it consumes no slot or revision.
      if (attachmentIds.every(id=>existing.rows.some(file=>file.attachment_id===id && file.submitted_by===actor.actorId))) {
        await client.query(`INSERT INTO sourcing_contract_return_requests(sourcing_case_id,request_id,submitted_by,attachment_ids)
          VALUES($1,$2,$3,$4::uuid[])`,[sourcingCaseId,key,actor.actorId,attachmentIds]);
        await client.query("COMMIT");
        return this.get({...actor,authorizationCapability:READ},sourcingCaseId);
      }
      const currentVersionFiles=existing.rows.filter(file=>file.sourcing_contract_document_id===documentId);
      if (currentVersionFiles.length + attachmentIds.length > 2) {
        throw new ApplicationError("INVALID_STATE_TRANSITION","当前合同版本回签文件累计最多 2 个，已保存文件和历史版本保留，不能再追加",409);
      }
      const existingBytes=currentVersionFiles.reduce((total,file)=>total+Number(file.size_bytes),0);
      const files=await client.query<FileRow & { uploaded_by: string }>(`SELECT attachment_id,original_filename,mime_type,size_bytes,uploaded_by
        FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'
          AND entity_type IS NULL AND entity_id IS NULL FOR UPDATE`,[attachmentIds]);
      if (files.rows.length!==attachmentIds.length || files.rows.some(file=>file.uploaded_by!==actor.actorId
        || !MIME_TYPES.includes(file.mime_type as (typeof MIME_TYPES)[number])
        || Number(file.size_bytes)>MAX_UPLOAD_BYTES)
        || existingBytes+files.rows.reduce((total,file)=>total+Number(file.size_bytes),0)>MAX_UPLOAD_BYTES) {
        throw new ApplicationError("VALIDATION_ERROR","当前合同版本回签须为 1 至 2 个 PDF/JPG/PNG 文件，累计不超过 20 MB，且文件必须属于当前上传人",400);
      }
      const next=(await client.query<{revision:number}>(`SELECT COALESCE(max(revision),0)+1 AS revision
        FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1`,[sourcingCaseId])).rows[0]!.revision;
      const submissionId=randomUUID();
      const submission=await client.query<{submitted_at:Date|string}>(`INSERT INTO sourcing_contract_return_submissions(
        submission_id,sourcing_case_id,revision,request_id,submitted_by,submitted_at,sourcing_contract_document_id
      ) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6) RETURNING submitted_at`,
      [submissionId,sourcingCaseId,next,key,actor.actorId,documentId]);
      for (let index=0;index<attachmentIds.length;index++) {
        const attachmentId=attachmentIds[index]!;
        await client.query(`UPDATE attachments SET entity_type='sourcing_contract_return',entity_id=$2,
          updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1`,[attachmentId,sourcingCaseId]);
        await client.query(`INSERT INTO sourcing_contract_return_attachments(submission_id,attachment_id,position)
          VALUES($1,$2,$3)`,[submissionId,attachmentId,index+1]);
      }
      await client.query(`INSERT INTO sourcing_contract_return_requests(
        sourcing_case_id,request_id,submitted_by,attachment_ids
      ) VALUES($1,$2,$3,$4::uuid[])`,[sourcingCaseId,key,actor.actorId,attachmentIds]);
      await client.query(`UPDATE sourcing_contract_return_monitors
        SET contract_returned_at=COALESCE(contract_returned_at,$2::timestamptz),
            contract_return_uploaded_by=COALESCE(contract_return_uploaded_by,$3::uuid),
            contract_return_latest_uploaded_by=$3::uuid
        WHERE sourcing_case_id=$1`,[sourcingCaseId,submission.rows[0]!.submitted_at,actor.actorId]);
      await this.events.append(client,actor,{action:"sourcing.contract_return.upload",
        entityType:"sourcing_case",entityId:sourcingCaseId,
        after:{submissionId,revision:next,attachmentIds:[...attachmentIds],sourcingContractDocumentId:documentId,firstReturn:monitor.contract_returned_at === null}});
      if (documentId) await this.todos.completeOpenByDedupePrefix(
        client, actor, transferContractVersionPrefix(sourcingCaseId, documentId), "当前版本合同已有效回传",
      );
      if (monitor.contract_returned_at === null) {
        await this.todos.completeOpenByDedupePrefix(
          client,actor,`sourcing:${sourcingCaseId}:return:`,"回签合同已上传",
        );
      }
      await client.query("COMMIT");
      return this.get({...actor,authorizationCapability:READ},sourcingCaseId);
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    } finally {client.release();}
  }
}
