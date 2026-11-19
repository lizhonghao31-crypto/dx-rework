import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";

export const JIASHUN_CLERK_ROLE = "jiashun_contract_clerk";
export const JIASHUN_READ = "sourcing:jiashun:read";
export const JIASHUN_CONTRACT_RETURN = "sourcing:jiashun:contract_return";
export const JIASHUN_FILE_UPLOAD = "tools:jiashun_contract_file";
export const isJiashunClerk = (roles: readonly string[]): boolean => roles.includes(JIASHUN_CLERK_ROLE);

type QueryClient = Pick<PoolClient, "query">;

const deny = (): never => { throw new ApplicationError("FORBIDDEN", "仅可操作嘉顺七厂、九厂、十厂当前授权订单", 403); };
const stale = (): never => { throw new ApplicationError("INVALID_STATE_TRANSITION", "订单工厂或合同版本已变化，请刷新后重新操作", 409); };

// Only the actual supplier_id from the current approved snapshot is authoritative.
// This fragment belongs inside the paged list's filtered_cases WHERE, before totals/offset.
export const currentJiashunApprovalIdSql = (caseId: string): string => `(
  SELECT latest.sourcing_approval_snapshot_id FROM sourcing_approval_snapshots latest
  WHERE latest.sourcing_case_id=${caseId}
  ORDER BY latest.decision_version DESC,latest.approved_at DESC LIMIT 1
)`;

export const JIASHUN_CASE_FILTER_SQL = `EXISTS (
  SELECT 1 FROM sourcing_approval_snapshots scoped_snapshot
  JOIN sourcing_jiashun_allowed_factories allowed_factory
    ON allowed_factory.supplier_id=scoped_snapshot.supplier_id
  WHERE scoped_snapshot.sourcing_case_id=case_view.sourcing_case_id
    AND scoped_snapshot.sourcing_approval_snapshot_id=${currentJiashunApprovalIdSql("case_view.sourcing_case_id")}
    AND (SELECT count(*) FROM sourcing_jiashun_allowed_factories)=3
)`;

/** The same server-side scope is used by list, details, attachments, and submit. */
export class JiashunContractClerkScope {
  constructor(private readonly database: Pool) {}

  async assertActive(actor: TrustedActorContext, client: QueryClient = this.database): Promise<void> {
    if (actor.actorRoles.length !== 1 || actor.actorRoles[0] !== JIASHUN_CLERK_ROLE) deny();
    const current = await client.query<{role_code:string}>(`SELECT assignment.role_code
      FROM user_role_assignments assignment
      JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled
      JOIN app_users user_account ON user_account.id=assignment.user_id AND user_account.enabled
        AND NOT user_account.manual_access_disabled
      WHERE assignment.user_id=$1 AND assignment.revoked_at IS NULL
      FOR SHARE OF assignment,user_account`,[actor.actorId]);
    if (current.rows.length !== 1 || current.rows[0]?.role_code !== JIASHUN_CLERK_ROLE) deny();
    const capability = await client.query<{capability:string}>(`SELECT capability FROM role_capabilities
      WHERE role_code=$1 AND capability=ANY($2::text[])`,[JIASHUN_CLERK_ROLE,[JIASHUN_READ,JIASHUN_CONTRACT_RETURN,JIASHUN_FILE_UPLOAD]]);
    if (capability.rows.length !== 3) deny();
  }

  async assertCase(actor: TrustedActorContext, sourcingCaseId: string, client: QueryClient = this.database): Promise<void> {
    await this.assertActive(actor,client);
    const result=await client.query<{allowed:boolean}>(`SELECT EXISTS (
      SELECT 1 FROM sourcing_cases case_view
      WHERE case_view.sourcing_case_id=$1 AND case_view.deleted_at IS NULL
        AND ${JIASHUN_CASE_FILTER_SQL}) AS allowed`,[sourcingCaseId]);
    if (!result.rows[0]?.allowed) deny();
  }

  async allowedDocumentIds(actor: TrustedActorContext, sourcingCaseId: string, client: QueryClient = this.database): Promise<Set<string>> {
    await this.assertCase(actor,sourcingCaseId,client);
    const result=await client.query<{sourcing_contract_document_id:string}>(`SELECT document.sourcing_contract_document_id
      FROM sourcing_contract_documents document
      JOIN sourcing_approval_snapshots snapshot
        ON snapshot.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
        AND snapshot.sourcing_case_id=document.sourcing_case_id
      JOIN sourcing_jiashun_allowed_factories factory ON factory.supplier_id=snapshot.supplier_id
      WHERE document.sourcing_case_id=$1`,[sourcingCaseId]);
    return new Set(result.rows.map(row=>row.sourcing_contract_document_id));
  }

  async assertDocument(actor: TrustedActorContext, sourcingCaseId: string, documentId: string, client: QueryClient = this.database): Promise<void> {
    if (!(await this.allowedDocumentIds(actor,sourcingCaseId,client)).has(documentId)) deny();
  }

  async assertHistoricalSnapshot(actor: TrustedActorContext, sourcingCaseId: string, at: string, client: QueryClient = this.database): Promise<void> {
    await this.assertCase(actor,sourcingCaseId,client);
    const result=await client.query<{allowed:boolean}>(`SELECT EXISTS (
      SELECT 1 FROM sourcing_approval_snapshots snapshot
      JOIN sourcing_jiashun_allowed_factories factory ON factory.supplier_id=snapshot.supplier_id
      WHERE snapshot.sourcing_case_id=$1 AND snapshot.approved_at <= $2::timestamptz
        AND snapshot.sourcing_approval_snapshot_id=(SELECT latest.sourcing_approval_snapshot_id
          FROM sourcing_approval_snapshots latest WHERE latest.sourcing_case_id=$1
            AND latest.approved_at <= $2::timestamptz
          ORDER BY latest.decision_version DESC,latest.approved_at DESC LIMIT 1)
    ) AS allowed`,[sourcingCaseId,at]);
    if (!result.rows[0]?.allowed) deny();
  }

  async assertCurrentDocument(actor: TrustedActorContext, sourcingCaseId: string, expectedId: string | null | undefined, client: QueryClient = this.database): Promise<void> {
    if (client !== this.database) {
      await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE",[sourcingCaseId]);
    }
    await this.assertCase(actor,sourcingCaseId,client);
    const current=await client.query<{sourcing_contract_document_id:string;status:string;effective:boolean}>(`SELECT
      sourcing_contract_document_id,status,
      sourcing_approval_snapshot_id=${currentJiashunApprovalIdSql("$1")} AS effective
      FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version DESC LIMIT 1`,[sourcingCaseId]);
    const document=current.rows[0];
    if (!document || !expectedId || document.sourcing_contract_document_id!==expectedId
      || document.status!=="ready" || !document.effective) stale();
  }

  async canDownloadBoundAttachment(actor: TrustedActorContext,binding: Readonly<{
    attachmentId:string;entityType:string;entityId:string;mimeType:string;
  }>): Promise<boolean> {
    if (!["sourcing_case","sourcing_contract_document","sourcing_contract_return"].includes(binding.entityType)) return false;
    try {
      if (binding.entityType==="sourcing_case") {
        if (!binding.mimeType.startsWith("image/")) return false;
        await this.assertCase(actor,binding.entityId);
        return true;
      }
      if (binding.entityType==="sourcing_contract_document") {
        const rows=await this.database.query<{sourcing_case_id:string}>(`SELECT sourcing_case_id
          FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1::uuid`,[binding.entityId]);
        if (!rows.rows[0]) return false;
        await this.assertDocument(actor,rows.rows[0].sourcing_case_id,binding.entityId);
        return ["application/pdf","image/jpeg","image/png","image/webp"].includes(binding.mimeType);
      }
      if (!["application/pdf","image/jpeg","image/png"].includes(binding.mimeType)) return false;
      const rows=await this.database.query<{sourcing_case_id:string;sourcing_contract_document_id:string|null}>(`SELECT submission.sourcing_case_id,submission.sourcing_contract_document_id
        FROM sourcing_contract_return_attachments link
        JOIN sourcing_contract_return_submissions submission ON submission.submission_id=link.submission_id
        WHERE link.attachment_id=$1::uuid AND submission.sourcing_case_id::text=$2`,[binding.attachmentId,binding.entityId]);
      const document=rows.rows[0];
      if (!document?.sourcing_contract_document_id) return false;
      await this.assertDocument(actor,document.sourcing_case_id,document.sourcing_contract_document_id);
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && error.statusCode===403) return false;
      throw error;
    }
  }
}
