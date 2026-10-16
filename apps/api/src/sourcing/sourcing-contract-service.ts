import { SourcingTransferContractTodos } from "./sourcing-transfer-contract-todos.js";
import { SourcingContractContentService, loadContractContent, hydrateContractContentImages, canEditContractContent } from "./sourcing-contract-content.js";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type {
  SourcingContractDocument,
  SourcingContractMissingField,
  SourcingContractStateResponse,
  SupplementSourcingContract,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { SourcingContractManagementService, canRefreshContractInformation } from "./sourcing-contract-management-service.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import {
  renderSourcingContractPdf,
  normalizeSourcingContractImage,
  sourcingContractFingerprint,
} from "./sourcing-contract-pdf.js";

const ROOT_ROLE = "root_superuser";
const MERCHANDISER_ROLE = "order_merchandiser";
const READ_CAPABILITY = "sourcing:view";
const CONTRACT_CAPABILITY = "sourcing:contract:record";
const FIELD_NAMES = [
  "address","contractEntityName","partyBRepresentative",
  "payeeName","bankAccount","bankName",
] as const satisfies readonly SourcingContractMissingField[];

type ContractRow = Readonly<{
  sourcing_contract_document_id: string;
  sourcing_case_id: string;
  sourcing_approval_snapshot_id: string;
  sourcing_decision_id: string;
  contract_version: number | string;
  contract_number: string;
  template_version: number | string;
  approval_snapshot: Record<string, unknown>;
  missing_fields: SourcingContractMissingField[];
  status: SourcingContractDocument["status"];
  snapshot_fingerprint: string | null;
  pdf_attachment_id: string | null;
  pdf_sha256: string | null;
  failure_reason: string | null;
  prepared_at: Date | string;
  generated_at: Date | string | null;
  created_by: string;
  party_a_name?: string;
  party_a_address?: string;
  signing_place?: string;
  terms?: Record<string, string>;
  returned?: boolean;
  reconciled?: boolean;
  display_contract_number?: string;
}>;

const iso = (value: Date | string): string => value instanceof Date
  ? value.toISOString() : new Date(value).toISOString();

const requestHash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope,payload })).digest("hex");

export class SourcingContractService {
  readonly transferTodos: SourcingTransferContractTodos;
  readonly management: SourcingContractManagementService;
  readonly content: SourcingContractContentService;
  constructor(
    private readonly database: Pool,
    private readonly attachments: AttachmentService,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    todos?: Pick<TodoProjectionService,"actionableForAllAssignedRole"|"cancelOpenByDedupePrefix">,
  ) { this.transferTodos = new SourcingTransferContractTodos(database); this.management = new SourcingContractManagementService(database); this.content = new SourcingContractContentService(database,attachments,undefined,undefined,todos); }

  async validateLineImages(client: Pick<PoolClient, "query">, actor: TrustedActorContext, attachmentIds: readonly string[]): Promise<void> {
    for (const attachmentId of new Set(attachmentIds)) {
      const image = await this.attachments.readUnboundSourcingImage(client,actor.actorId,attachmentId);
      try {
        await normalizeSourcingContractImage(image.bytes);
      } catch {
        throw new ApplicationError("VALIDATION_ERROR",`款图“${image.filename}”无法用于合同，请更换为不超过4000万像素的 JPG、PNG 或 WebP 图片后再提交`,422);
      }
    }
  }

  async resumePendingContracts(batchSize = 50, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const pending = await this.database.query<{
        sourcing_contract_document_id: string;
        sourcing_case_id: string;
        actor_id: string;
        is_root: boolean;
      }>(
        `SELECT document.sourcing_contract_document_id,document.sourcing_case_id,
                COALESCE(root_user.user_id,document.prepared_by) AS actor_id,
                root_user.user_id IS NOT NULL AS is_root
         FROM sourcing_contract_documents document
         LEFT JOIN LATERAL (
           SELECT consumption.user_id FROM owner_bootstrap_consumptions consumption
           WHERE consumption.singleton=true LIMIT 1
         ) root_user ON true
         WHERE document.status='generation_pending'
           AND cardinality(document.missing_fields)=0
         ORDER BY document.prepared_at,document.sourcing_contract_document_id
         LIMIT $1`,
        [batchSize],
      );
      if (!pending.rows.length) return;
      await Promise.allSettled(pending.rows.map((row) => this.generateIfReady({
        actorId: row.actor_id,
        actorRoles: row.is_root ? [ROOT_ROLE] : [],
        authorizationCapability: CONTRACT_CAPABILITY,
        authorizationCapabilities: [READ_CAPABILITY,CONTRACT_CAPABILITY],
        requestId: `sourcing-contract-resume:${row.sourcing_contract_document_id}`,
      }, row.sourcing_case_id, row.sourcing_contract_document_id)));
    }
  }

  async prepareForApproval(
    client: Pick<PoolClient, "query">,
    approvalSnapshotId: string,
    actor: TrustedActorContext,
  ): Promise<string> {
    // Serialize with style corrections, approvals and dispatch before reading the revision.
    await client.query(`SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=(
      SELECT sourcing_case_id FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1) FOR UPDATE`,[approvalSnapshotId]);
    // Enroll the current owner/root approval even when this case has older
    // approval snapshots. A management-only factory change does not qualify.
      await client.query(`INSERT INTO sourcing_contract_return_monitors(
        sourcing_case_id,contract_return_monitor_enabled
      )
      SELECT current_snapshot.sourcing_case_id,true
      FROM sourcing_approval_snapshots current_snapshot
      WHERE current_snapshot.sourcing_approval_snapshot_id=$1
        AND (
          EXISTS (
            SELECT 1 FROM sourcing_owner_decisions owner_decision
            WHERE owner_decision.operation_event_id=current_snapshot.operation_event_id
              AND owner_decision.sourcing_decision_id=current_snapshot.sourcing_decision_id
              AND owner_decision.decision='approved'
          )
          OR EXISTS (
            SELECT 1 FROM sourcing_decisions decision
            JOIN sourcing_factory_change_decisions owner_change
              ON owner_change.factory_change_request_id=decision.source_change_request_id
            WHERE decision.sourcing_decision_id=current_snapshot.sourcing_decision_id
              AND owner_change.operation_event_id=current_snapshot.operation_event_id
              AND owner_change.decision='approved'
              AND owner_change.decision_role='owner_group'
          )
        )
      ON CONFLICT(sourcing_case_id) DO UPDATE
        SET contract_return_monitor_enabled=true
        WHERE NOT sourcing_contract_return_monitors.contract_return_monitor_enabled`,[approvalSnapshotId]);
    const metadata = (await client.query<{identity_version:number;template_version:number}>(`SELECT
      (SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=snapshot.sourcing_case_id) AS identity_version,
      CASE WHEN previous.identity_version<(SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=snapshot.sourcing_case_id)
        AND EXISTS(SELECT 1 FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=previous.sourcing_contract_document_id)
        THEN previous.template_version
        ELSE (SELECT max(template_version) FROM sourcing_contract_template_versions WHERE effective_from<=CURRENT_TIMESTAMP) END AS template_version
      FROM sourcing_approval_snapshots snapshot
      LEFT JOIN LATERAL (SELECT sourcing_contract_document_id,identity_version,template_version FROM sourcing_contract_documents
        WHERE sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id ORDER BY contract_version DESC LIMIT 1) previous ON true
      WHERE snapshot.sourcing_approval_snapshot_id=$1`,[approvalSnapshotId])).rows[0];
    if (!metadata) throw new ApplicationError("INVALID_STATE_TRANSITION","合同批准快照不存在",409);
    const documentId = randomUUID();
    const inserted = await client.query<{ sourcing_contract_document_id: string }>(
      `INSERT INTO sourcing_contract_documents(
         sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,
         sourcing_decision_id,contract_version,contract_number,template_version,
         approval_snapshot,missing_fields,status,prepared_by,identity_version,revision_of
       )
       SELECT $1,snapshot.sourcing_case_id,snapshot.sourcing_approval_snapshot_id,
              snapshot.sourcing_decision_id,GREATEST(snapshot.decision_version,(SELECT COALESCE(max(contract_version),0)+1 FROM sourcing_contract_documents WHERE sourcing_case_id=snapshot.sourcing_case_id)),
              'DX-WF-'||to_char(snapshot.approved_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')||'-'||
                lpad(nextval('sourcing_contract_number_seq')::text,6,'0'),
              template.template_version,
              jsonb_build_object(
                'gender',snapshot.gender,'styleName',snapshot.style_name_snapshot,
                'supplierId',snapshot.supplier_id,
                'supplierCode',snapshot.supplier_code_snapshot,
                'supplierName',snapshot.supplier_name_snapshot,
                'address',snapshot.supplier_address,
                'contractEntityName',COALESCE(snapshot.contract_entity_name,snapshot.supplier_name_snapshot),
                'partyBRepresentative',snapshot.party_b_representative,
                'payeeName',snapshot.payee_name,
                'bankAccount',snapshot.bank_account,
                'bankName',snapshot.bank_name,
                'quantity',snapshot.quantity::text,
                'totalAmount',snapshot.total_amount::text,
                'estimatedCutPieceSendDate',snapshot.estimated_cut_piece_send_date,
                'deliveryDate',snapshot.delivery_date,
                'processes',snapshot.processes,
                'approvedAt',snapshot.approved_at,
                'lines',COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'position',line.position,'styleNo',identity.style_no,'imageAttachmentId',identity.image_attachment_id,
                    'imageSha256',(SELECT sha256 FROM attachments WHERE attachment_id=identity.image_attachment_id),
                    'alternateStyleNo',identity.alternate_style_no,'color',line.color,
                    'quantity',line.quantity,'unitPrice',line.unit_price::text,
                    'totalAmount',line.total_amount::text
                  ) ORDER BY line.position)
                  FROM sourcing_approval_snapshot_lines line
                  JOIN current_sourcing_case_lines identity ON identity.sourcing_case_id=snapshot.sourcing_case_id AND identity.position=line.position
                  WHERE line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
                ),'[]'::jsonb)
              ) || COALESCE(supplements.values,'{}'::jsonb),
              missing.fields,
              CASE WHEN cardinality(missing.fields)>0
                THEN 'pending_supplement' ELSE 'generation_pending' END,
              $2,$4,previous.sourcing_contract_document_id
       FROM sourcing_approval_snapshots snapshot
       LEFT JOIN LATERAL (SELECT * FROM sourcing_contract_documents
         WHERE sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id ORDER BY contract_version DESC LIMIT 1) previous ON true
       LEFT JOIN LATERAL (SELECT (SELECT jsonb_object_agg(field_name,field_value) FROM sourcing_contract_supplements
         WHERE sourcing_contract_document_id=previous.sourcing_contract_document_id)
         || '{}'::jsonb AS direct_values) direct ON true
       LEFT JOIN LATERAL (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) || COALESCE(direct.direct_values,'{}'::jsonb) AS values
         FROM jsonb_each(previous.approval_snapshot) WHERE key=ANY(ARRAY['supplierName','supplierCode','address','contractEntityName','partyBRepresentative','payeeName','bankAccount','bankName'])) supplements ON true
       CROSS JOIN LATERAL (
         SELECT template_version
         FROM sourcing_contract_template_versions
         WHERE template_version=$5
       ) template
       CROSS JOIN LATERAL (
         SELECT array_remove(ARRAY[
           CASE WHEN COALESCE(supplements.values->>'address',snapshot.supplier_address) IS NULL THEN 'address' END,
           CASE WHEN COALESCE(supplements.values->>'partyBRepresentative',snapshot.party_b_representative) IS NULL THEN 'partyBRepresentative' END,
           CASE WHEN COALESCE(supplements.values->>'payeeName',snapshot.payee_name) IS NULL THEN 'payeeName' END,
           CASE WHEN COALESCE(supplements.values->>'bankAccount',snapshot.bank_account) IS NULL THEN 'bankAccount' END,
           CASE WHEN COALESCE(supplements.values->>'bankName',snapshot.bank_name) IS NULL THEN 'bankName' END
         ],NULL)::text[] AS fields
       ) missing
       WHERE snapshot.sourcing_approval_snapshot_id=$3
       ON CONFLICT(sourcing_approval_snapshot_id,identity_version,template_version,information_revision) DO NOTHING
       RETURNING sourcing_contract_document_id`,
      [documentId,actor.actorId,approvalSnapshotId,metadata.identity_version,metadata.template_version],
    );
    if (inserted.rows[0]) await client.query(`INSERT INTO sourcing_contract_content_overrides(sourcing_contract_document_id,content,operation_event_id)
      SELECT d.sourcing_contract_document_id,sourcing_contract_content_for_style_revision(d.sourcing_contract_document_id),r.operation_event_id
      FROM sourcing_contract_documents d JOIN sourcing_contract_documents previous ON previous.sourcing_contract_document_id=d.revision_of
      JOIN sourcing_contract_content_overrides old_content ON old_content.sourcing_contract_document_id=d.revision_of
      JOIN sourcing_style_revisions r ON r.sourcing_case_id=d.sourcing_case_id AND r.revision=d.identity_version AND r.changed_by=d.prepared_by
      WHERE d.sourcing_contract_document_id=$1 AND d.identity_version>previous.identity_version
        AND d.sourcing_approval_snapshot_id=previous.sourcing_approval_snapshot_id AND d.sourcing_decision_id=previous.sourcing_decision_id`,[documentId]);
    const existing = inserted.rows[0] ? null : await client.query<{ sourcing_contract_document_id: string }>(
      `SELECT sourcing_contract_document_id FROM sourcing_contract_documents
       WHERE sourcing_approval_snapshot_id=$1 AND identity_version=$2 AND template_version=$3
       ORDER BY contract_version DESC LIMIT 1`,
      [approvalSnapshotId,metadata.identity_version,metadata.template_version],
    );
    const id = inserted.rows[0]?.sourcing_contract_document_id
      ?? existing?.rows[0]?.sourcing_contract_document_id;
    if (!id) throw new ApplicationError("INVALID_STATE_TRANSITION", "合同批准快照不存在", 409);
    await this.transferTodos.synchronize(client as PoolClient, actor, (await client.query<{sourcing_case_id:string}>("SELECT sourcing_case_id FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1", [approvalSnapshotId])).rows[0]!.sourcing_case_id);
    return id;
  }

  async getCurrent(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingContractStateResponse> {
    this.assertReader(actor);
    const result = await this.database.query<ContractRow>(
      `SELECT document.*,source_case.created_by,
              EXISTS(SELECT 1 FROM sourcing_contract_return_submissions WHERE sourcing_case_id=document.sourcing_case_id) AS returned,
              EXISTS(SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_contract_document_id=document.sourcing_contract_document_id) AS reconciled,
              (SELECT content->>'contractNumber' FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=document.sourcing_contract_document_id) AS display_contract_number
       FROM sourcing_contract_documents document
       JOIN sourcing_cases source_case ON source_case.sourcing_case_id=document.sourcing_case_id
       WHERE document.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
       ORDER BY document.contract_version DESC LIMIT 1`,
      [sourcingCaseId],
    );
    return { item: result.rows[0] ? await this.dto(result.rows[0], actor) : null };
  }

  async supplement(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: SupplementSourcingContract,
    idempotencyKey: string,
  ): Promise<SourcingContractStateResponse> {
    this.assertContractActor(actor);
    const entries = Object.entries(input) as Array<[SourcingContractMissingField,string]>;
    const scope = "sourcing.contract.supplement";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE",[sourcingCaseId]);
      await this.idempotency.execute(client, {
        scope,actorKey: actor.actorId,key: idempotencyKey,
        requestHash: requestHash(scope,{ sourcingCaseId,input }),
        expiresAt: new Date(Date.now()+24*60*60*1000),
      }, async () => {
        const current = await client.query<ContractRow>(
          `SELECT document.*,source_case.created_by
           FROM sourcing_contract_documents document
           JOIN sourcing_cases source_case ON source_case.sourcing_case_id=document.sourcing_case_id
           WHERE document.sourcing_case_id=$1
           ORDER BY document.contract_version DESC LIMIT 1 FOR UPDATE OF document`,
          [sourcingCaseId],
        );
        const row = current.rows[0];
        if (!row) throw new ApplicationError("NOT_FOUND", "合同准备记录不存在", 404);
        if (!actor.actorRoles.includes(ROOT_ROLE) && row.created_by !== actor.actorId) {
          throw new ApplicationError("FORBIDDEN", "仅订单跟单或Root可补充合同缺项", 403);
        }
        if (row.status !== "pending_supplement") {
          throw new ApplicationError("INVALID_STATE_TRANSITION", "合同已冻结，不能修改", 409);
        }
        for (const [field,value] of entries) {
          if (!FIELD_NAMES.includes(field) || !row.missing_fields.includes(field)) {
            throw new ApplicationError("INVALID_STATE_TRANSITION", "只能补充当前合同缺项", 409);
          }
          const eventId = await this.events.append(client, actor, {
            action: "sourcing.contract.supplement",
            entityType: "sourcing_contract_document",
            entityId: row.sourcing_contract_document_id,
            after: { fieldName: field, source: "本合同补充资料" },
            reason: "补充合同生成所需资料",
          });
          await client.query(
            `INSERT INTO sourcing_contract_supplements(
               sourcing_contract_supplement_id,sourcing_contract_document_id,
               field_name,field_value,supplemented_by,operation_event_id,request_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [randomUUID(),row.sourcing_contract_document_id,field,value.trim(),
              actor.actorId,eventId,actor.requestId],
          );
        }
        const remaining = row.missing_fields.filter((field) => !entries.some(([name]) => name === field));
        await client.query(
          `UPDATE sourcing_contract_documents
           SET missing_fields=$2,status=CASE WHEN cardinality($2::text[])=0
             THEN 'generation_pending' ELSE 'pending_supplement' END,
             failure_reason=NULL
           WHERE sourcing_contract_document_id=$1`,
          [row.sourcing_contract_document_id,remaining],
        );
        return { statusCode: 200,response: { documentId: row.sourcing_contract_document_id } };
      });
      await client.query("COMMIT");
      await this.generateIfReady(actor, sourcingCaseId);
      return this.getCurrent(actor, sourcingCaseId);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async generateIfReady(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    sourcingContractDocumentId?: string,
  ): Promise<SourcingContractStateResponse> {
    const claimed = await this.database.query<ContractRow>(
      `UPDATE sourcing_contract_documents document
       SET status='generating',failure_reason=NULL
       FROM sourcing_cases source_case
       WHERE document.sourcing_case_id=$1
         AND source_case.sourcing_case_id=document.sourcing_case_id
         AND source_case.deleted_at IS NULL
         AND (
           ($2::uuid IS NULL AND document.contract_version=(
             SELECT max(latest.contract_version) FROM sourcing_contract_documents latest
             WHERE latest.sourcing_case_id=document.sourcing_case_id
           ))
           OR document.sourcing_contract_document_id=$2::uuid
         )
         AND (
           document.status IN ('generation_pending','generation_failed')
           OR (document.status='generating' AND document.updated_at<CURRENT_TIMESTAMP-INTERVAL '5 minutes')
         )
         AND cardinality(document.missing_fields)=0
       RETURNING document.*,source_case.created_by`,
      [sourcingCaseId,sourcingContractDocumentId ?? null],
    );
    const row = claimed.rows[0];
    if (!row) return this.getCurrent(actor, sourcingCaseId);
    try {
      const source = row;
      const snapshot = await hydrateContractContentImages(this.attachments,source.sourcing_case_id,
        await loadContractContent(this.database,source.sourcing_contract_document_id));
      const fingerprint = sourcingContractFingerprint(snapshot);
      const pdf = await renderSourcingContractPdf(snapshot);
      const attachment = await this.attachments.storeGenerated(actor, {
        filename: `${source.contract_number}.pdf`,mimeType: "application/pdf",
        content: pdf,entityType: "sourcing_contract_document",
        entityId: source.sourcing_contract_document_id,
      });
      const client = await this.database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE", [sourcingCaseId]);
        await client.query(
          `UPDATE sourcing_contract_documents
           SET status='ready',snapshot_fingerprint=$2,pdf_attachment_id=$3,
               pdf_sha256=$4,generated_at=CURRENT_TIMESTAMP,failure_reason=NULL
           WHERE sourcing_contract_document_id=$1 AND status='generating'`,
          [source.sourcing_contract_document_id,fingerprint,attachment.attachmentId,attachment.sha256],
        );
        // A routing configuration problem must not turn a valid generated PDF into a failed contract.
        // Keep an audited retry fact; explicit reconciliation uses the same version-bound projection.
        await client.query("SAVEPOINT transfer_contract_todos");
        try {
          await this.transferTodos.synchronize(client, actor, sourcingCaseId);
          await client.query("RELEASE SAVEPOINT transfer_contract_todos");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT transfer_contract_todos");
          await this.events.append(client, actor, {
            action: "sourcing.transfer_contract_todo.deferred", entityType: "sourcing_case", entityId: sourcingCaseId,
            after: { sourcingContractDocumentId: source.sourcing_contract_document_id },
            reason: error instanceof ApplicationError ? error.message : "待办投影失败，需重试核对",
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      return this.getCurrent(actor, sourcingCaseId);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0,500) : "合同PDF生成失败";
      await this.database.query(
        `UPDATE sourcing_contract_documents
         SET status='generation_failed',failure_reason=$2
         WHERE sourcing_contract_document_id=$1 AND status='generating'`,
        [row.sourcing_contract_document_id,reason],
      ).catch(() => undefined);
      throw error;
    }
  }

  private assertReader(actor: TrustedActorContext): void {
    if (!actor.actorRoles.includes(ROOT_ROLE)
      && !(actor.authorizationCapabilities ?? []).includes(READ_CAPABILITY)) {
      throw new ApplicationError("FORBIDDEN", "无权查看合同数据", 403);
    }
  }

  private assertContractActor(actor: TrustedActorContext): void {
    if (actor.authorizationCapability !== CONTRACT_CAPABILITY
      || (!actor.actorRoles.includes(ROOT_ROLE) && !actor.actorRoles.includes(MERCHANDISER_ROLE))) {
      throw new ApplicationError("FORBIDDEN", "当前岗位无权补充合同资料", 403);
    }
  }

  private async dto(row: ContractRow, actor: TrustedActorContext): Promise<SourcingContractDocument> {
    return {
      sourcingContractDocumentId: row.sourcing_contract_document_id,
      sourcingApprovalSnapshotId: row.sourcing_approval_snapshot_id,
      contractNumber: row.display_contract_number ?? row.contract_number,
      contractVersion: Number(row.contract_version),
      templateVersion: Number(row.template_version),
      status: row.status,
      missingFields: row.missing_fields,
      snapshotFingerprint: row.snapshot_fingerprint,
      pdfAttachmentId: row.pdf_attachment_id,
      pdfSha256: row.pdf_sha256,
      failureReason: row.failure_reason,
      preparedAt: iso(row.prepared_at),
      generatedAt: row.generated_at ? iso(row.generated_at) : null,
      canSupplement: await memberCanWriteModule(this.database, actor.actorId, "sourcing") && (actor.actorRoles.includes(ROOT_ROLE)
        || (actor.actorRoles.includes(MERCHANDISER_ROLE) && actor.actorId === row.created_by)),
      canEditContent: row.status === "ready" && canEditContractContent(actor,row.reconciled !== false),
      canRefreshInformation: row.status !== "generating" && canRefreshContractInformation(actor,row.created_by,row.returned === true)
        && (actor.actorRoles.includes(ROOT_ROLE) || await memberCanWriteModule(this.database,actor.actorId,"sourcing")),
    };
  }
}
