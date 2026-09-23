import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { OperationEventRepository } from "../tools/repositories.js";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { ApplicationError } from "../platform/errors.js";
import { contractReturnState } from "./contract-return-state.js";

const ROOT = "root_superuser";
const READ = "sourcing:view";
const MERCHANDISER = "order_merchandiser";
const OWNER = "owner_group";
const MIME_TYPES = ["application/pdf","image/jpeg","image/png"] as const;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

type MonitorRow = {
  sourcing_case_id: string;
  created_by: string;
  contract_return_monitor_enabled: boolean | null;
  contract_generated_at: Date | string | null;
  contract_return_due_at: Date | string | null;
  contract_returned_at: Date | string | null;
  contract_return_overdue_seconds: number | string | null;
  contract_return_uploaded_by: string | null;
  uploader_name: string | null;
  as_of: Date | string;
};
type FileRow = { attachment_id: string; original_filename: string; mime_type: string; size_bytes: string };
const forbidden = (): never => { throw new ApplicationError("FORBIDDEN","当前账号无权回传合同",403); };
const fileDto = (row: FileRow) => ({
  attachmentId: row.attachment_id,filename: row.original_filename,
  mimeType: row.mime_type as (typeof MIME_TYPES)[number],sizeBytes: Number(row.size_bytes),
});

export class SourcingContractReturnService {
  constructor(private readonly database: Pool, private readonly events = new OperationEventRepository()) {}

  private assertReader(actor: TrustedActorContext): void {
    if (!actor.actorRoles.includes(ROOT) || actor.authorizationCapability !== READ) {
      if (actor.authorizationCapability !== READ || !(actor.authorizationCapabilities ?? []).includes(READ)) forbidden();
    }
  }

  private async canUpload(actor: TrustedActorContext, creator: string): Promise<boolean> {
    if (actor.actorRoles.includes(ROOT)) return true;
    if (!(await memberCanWriteModule(this.database,actor.actorId,"sourcing"))) return false;
    const capabilities = actor.authorizationCapabilities ?? [];
    return actor.actorRoles.includes(MERCHANDISER) && actor.actorId === creator && capabilities.includes("sourcing:contract:record")
      || actor.actorRoles.includes(OWNER) && capabilities.includes("sourcing:owner:approve");
  }

  async get(actor: TrustedActorContext, sourcingCaseId: string) {
    this.assertReader(actor);
    const result = await this.database.query<MonitorRow>(`SELECT source_case.sourcing_case_id,source_case.created_by,
      monitor.contract_return_monitor_enabled,monitor.contract_generated_at,monitor.contract_return_due_at,
      monitor.contract_returned_at,monitor.contract_return_uploaded_by,
      sourcing_contract_return_elapsed_seconds(monitor.contract_return_due_at,
        COALESCE(monitor.contract_returned_at,CURRENT_TIMESTAMP)) AS contract_return_overdue_seconds,
      uploader.display_name AS uploader_name,CURRENT_TIMESTAMP AS as_of
      FROM sourcing_cases source_case
      LEFT JOIN sourcing_contract_return_monitors monitor ON monitor.sourcing_case_id=source_case.sourcing_case_id
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
      ? await this.database.query<FileRow>(`SELECT file.attachment_id,file.original_filename,file.mime_type,file.size_bytes
        FROM sourcing_contract_return_submissions submission
        JOIN sourcing_contract_return_attachments link ON link.submission_id=submission.submission_id
        JOIN attachments file ON file.attachment_id=link.attachment_id AND file.status='ready'
        WHERE submission.sourcing_case_id=$1
          AND submission.revision=(SELECT max(revision) FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1)
        ORDER BY link.position`,[sourcingCaseId]) : null;
    return { ...status,uploadedByName:status.contractReturnMonitoring ? row.uploader_name : null,
      canUpload: status.contractReturnMonitoring && await this.canUpload(actor,row.created_by),
      attachments:files?.rows.map(fileDto) ?? [] };
  }

  async submit(actor: TrustedActorContext,sourcingCaseId: string,attachmentIds: readonly string[],key: string) {
    if (!actor.actorRoles.includes(ROOT) && !(actor.authorizationCapabilities ?? []).includes(READ)) forbidden();
    if (!actor.actorRoles.includes(ROOT) &&
      !(
        actor.authorizationCapability === "sourcing:contract:record" && actor.actorRoles.includes(MERCHANDISER)
        || actor.authorizationCapability === "sourcing:owner:approve" && actor.actorRoles.includes(OWNER)
      )) forbidden();
    if (attachmentIds.length < 1 || attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new ApplicationError("VALIDATION_ERROR","请上传 1 至 10 个不重复的回签合同文件",400);
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR","上传请求标识无效",400);
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      const locked=await client.query<MonitorRow>(`SELECT monitor.sourcing_case_id,source_case.created_by,
          monitor.contract_return_monitor_enabled,monitor.contract_generated_at,monitor.contract_return_due_at,
          monitor.contract_returned_at,monitor.contract_return_uploaded_by,NULL::text AS uploader_name,
          NULL::bigint AS contract_return_overdue_seconds,
          CURRENT_TIMESTAMP AS as_of
        FROM sourcing_contract_return_monitors monitor
        JOIN sourcing_cases source_case ON source_case.sourcing_case_id=monitor.sourcing_case_id
        WHERE monitor.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
        FOR UPDATE OF monitor`,[sourcingCaseId]);
      const monitor=locked.rows[0];
      if (!monitor?.contract_return_monitor_enabled || !monitor.contract_generated_at) {
        throw new ApplicationError("INVALID_STATE_TRANSITION","合同未生成或该订单不属于回签监控范围",409);
      }
      if (!(await this.canUpload(actor,monitor.created_by))) forbidden();
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
      const latest=await client.query<{submitted_by:string;attachment_ids:string[]}>(`SELECT submission.submitted_by,
        array_agg(link.attachment_id::text ORDER BY link.position) AS attachment_ids
        FROM sourcing_contract_return_submissions submission
        JOIN sourcing_contract_return_attachments link ON link.submission_id=submission.submission_id
        WHERE submission.sourcing_case_id=$1
          AND submission.revision=(SELECT max(revision) FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1)
        GROUP BY submission.submission_id`,[sourcingCaseId]);
      if (latest.rows[0]?.submitted_by===actor.actorId
        && JSON.stringify(latest.rows[0].attachment_ids)===JSON.stringify(attachmentIds)) {
        await client.query(`INSERT INTO sourcing_contract_return_requests(
          sourcing_case_id,request_id,submitted_by,attachment_ids
        ) VALUES($1,$2,$3,$4::uuid[])`,[sourcingCaseId,key,actor.actorId,attachmentIds]);
        await client.query("COMMIT");
        return this.get({...actor,authorizationCapability:READ},sourcingCaseId);
      }
      const files=await client.query<FileRow & { uploaded_by: string }>(`SELECT attachment_id,original_filename,mime_type,size_bytes,uploaded_by
        FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'
          AND entity_type IS NULL AND entity_id IS NULL FOR UPDATE`,[attachmentIds]);
      if (files.rows.length!==attachmentIds.length || files.rows.some(file=>file.uploaded_by!==actor.actorId
        || !MIME_TYPES.includes(file.mime_type as (typeof MIME_TYPES)[number])
        || Number(file.size_bytes)>MAX_UPLOAD_BYTES)
        || files.rows.reduce((total,file)=>total+Number(file.size_bytes),0)>MAX_UPLOAD_BYTES
        || (files.rows.some(file=>file.mime_type==="application/pdf") && files.rows.length!==1)) {
        throw new ApplicationError("VALIDATION_ERROR","回签合同须为单份 PDF 或最多 10 张 JPG/PNG，合计不超过 20 MB，且文件必须属于当前上传人",400);
      }
      const next=(await client.query<{revision:number}>(`SELECT COALESCE(max(revision),0)+1 AS revision
        FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1`,[sourcingCaseId])).rows[0]!.revision;
      const submissionId=randomUUID();
      const submission=await client.query<{submitted_at:Date|string}>(`INSERT INTO sourcing_contract_return_submissions(
        submission_id,sourcing_case_id,revision,request_id,submitted_by,submitted_at
      ) VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING submitted_at`,
      [submissionId,sourcingCaseId,next,key,actor.actorId]);
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
        after:{submissionId,revision:next,attachmentIds:[...attachmentIds],firstReturn:monitor.contract_returned_at === null}});
      await client.query("COMMIT");
      return this.get({...actor,authorizationCapability:READ},sourcingCaseId);
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    } finally {client.release();}
  }
}
