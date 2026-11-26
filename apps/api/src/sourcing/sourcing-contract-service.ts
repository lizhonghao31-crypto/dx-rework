import { recordContractBusinessReady } from "../production-platform/contract-business-ready.js";
import { DigitalProductionTaskService } from "../production-platform/task-service.js";
import { SourcingTransferContractTodos } from "./sourcing-transfer-contract-todos.js";
import {effectiveSourcingMerchandiser,lockDigitalSourcingHandover} from "./current-merchandiser.js";
import { SourcingContractContentService, loadContractContent, hydrateContractContentImages, canEditContractContent } from "./sourcing-contract-content.js";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import type { AcceptanceClockRuntime } from "../acceptance-clock/runtime.js";
import { renderRecoveryContract } from "./sourcing-contract-recovery-render.js";
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
  normalizeSourcingContractSnapshotImages,
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
  generation_attempt_id: string | null;
}>;

type RecoveryCursor = Readonly<{ prepared_at: string; document_id: string }>;
type RecoveryCandidate = RecoveryCursor & Readonly<{ case_id: string; version: number; waiting_ms: number }>;
type RecoveryOptions = Readonly<{
  acceptanceClock?: AcceptanceClockRuntime;
  cursor?: RecoveryCursor | null;
  stop?: () => boolean;
  budgetMs?: number;
  jobTimeoutMs?: number;
  report?: (fields: Record<string, unknown>, message: string) => void;
}>;
type GenerationOptions = Readonly<{
  recoveryVersion: number;
  signal: AbortSignal;
  report?: RecoveryOptions["report"];
}>;
const staleGeneration = `document.status='generating'
  AND COALESCE(document.generation_lease_until,document.updated_at+INTERVAL '5 minutes') <= clock_timestamp()`;

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

  async resumePendingContracts(batchSize = 50, options: RecoveryOptions = {}) {
    const started = performance.now();
    const batch = await this.database.query<RecoveryCandidate>(
      `SELECT document.sourcing_contract_document_id AS document_id, document.sourcing_case_id AS case_id,
         document.contract_version AS version, document.prepared_at::text AS prepared_at,
         extract(epoch FROM (clock_timestamp()-document.prepared_at))*1000 AS waiting_ms
       FROM sourcing_contract_documents document
       JOIN sourcing_cases source_case USING(sourcing_case_id)
       JOIN sourcing_approval_snapshots approved ON approved.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
         AND approved.sourcing_case_id=document.sourcing_case_id AND approved.sourcing_decision_id=document.sourcing_decision_id
       WHERE source_case.deleted_at IS NULL
         AND document.status IN ('generation_pending','generating')
         AND (document.status='generation_pending' OR (${staleGeneration}))
         AND cardinality(document.missing_fields)=0
         AND ($2::timestamptz IS NULL OR (document.prepared_at, document.sourcing_contract_document_id)>($2::timestamptz,$3::uuid))
       ORDER BY document.prepared_at,document.sourcing_contract_document_id LIMIT $1`,
      [batchSize, options.cursor?.prepared_at ?? null, options.cursor?.document_id ?? null],
    );
    let cursor = options.cursor ?? null;
    let advanced = 0;
    let ready = 0;
    for (const candidate of batch.rows) {
      if (options.stop?.() || performance.now() - started >= (options.budgetMs ?? 30_000)) break;
      cursor = { prepared_at: candidate.prepared_at, document_id: candidate.document_id };
      advanced++;
      const refs = { caseId: candidate.case_id, documentId: candidate.document_id, version: candidate.version };
      try {
        const identity = await this.recoveryIdentity(candidate);
        if (!identity) {
          options.report?.(refs, "contract recovery requires the original authorized identity and order binding");
          continue;
        }
        if (identity.scenarioId && !options.acceptanceClock) {
          options.report?.(refs, "contract recovery requires the verified Acceptance clock");
          continue;
        }
        if (options.stop?.()) break;
        const run = async () => {
          if (options.stop?.()) return;
          return this.generateIfReady(identity.actor, candidate.case_id, candidate.document_id, {
            recoveryVersion: candidate.version, signal: AbortSignal.timeout(options.jobTimeoutMs ?? 240_000),
            ...(options.report ? { report: options.report } : {}),
          });
        };
        const result = identity.scenarioId
          ? await options.acceptanceClock!.run(identity.scenarioId, identity.actor, run)
          : await run();
        if (result?.item?.status === "ready") ready++;
      } catch (error) {
        options.report?.({ ...refs, code: error instanceof ApplicationError ? error.code : "RECOVERY_FAILED" }, "contract recovery could not finish");
      }
    }
    if (advanced === batch.rows.length && batch.rows.length < batchSize) cursor = null;
    return { cursor, candidates: batch.rows.length, advanced, ready, waitingMs: Number(batch.rows[0]?.waiting_ms ?? 0) };
  }

  private async recoveryIdentity(candidate: RecoveryCandidate): Promise<{ actor: TrustedActorContext; scenarioId: string | null } | null> {
    const row = (await this.database.query<{
      actor_id: string; capability: string; generation: string | null; order_count: number; scenario_id: string | null;
    }>(`SELECT COALESCE(event.actor_id,document.prepared_by) AS actor_id,
         COALESCE(event.authorization_capability,'sourcing:contract:record') AS capability,
         source.workflow_generation AS generation, links.order_count, links.scenario_id
       FROM sourcing_contract_documents document JOIN sourcing_cases source USING(sourcing_case_id)
       JOIN sourcing_approval_snapshots approved ON approved.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
       LEFT JOIN LATERAL (
         SELECT operation.actor_id,operation.authorization_capability FROM operation_events operation
         WHERE operation.event_id IN (
           SELECT operation_event_id FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=$1
           UNION ALL SELECT operation_event_id FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=$1
           UNION ALL SELECT document.information_refresh_event_id
           UNION ALL SELECT operation_event_id FROM sourcing_style_revisions
             WHERE sourcing_case_id=source.sourcing_case_id AND revision=document.identity_version AND changed_by=document.prepared_by
           UNION ALL SELECT approved.operation_event_id WHERE approved.approved_by=document.prepared_by
         ) ORDER BY operation.created_at DESC,operation.event_id DESC LIMIT 1
       ) event ON true
       CROSS JOIN LATERAL (
         SELECT count(*)::integer AS order_count, (array_agg(clock.scenario_id))[1] AS scenario_id
         FROM digital_production_child_links link
         LEFT JOIN acceptance_sla_clock_resources clock ON clock.resource_kind='order' AND clock.resource_id=link.production_order_id
         WHERE link.module='sourcing' AND link.child_id=document.sourcing_case_id
       ) links
       JOIN app_users user_account ON user_account.id=COALESCE(event.actor_id,document.prepared_by)
       WHERE document.sourcing_contract_document_id=$1 AND source.deleted_at IS NULL
         AND user_account.enabled AND NOT user_account.manual_access_disabled`, [candidate.document_id])).rows[0];
    if (!row || row.order_count > 1 || (row.generation === "digital_production_v1" && row.order_count !== 1)) return null;
    const roles = (await this.database.query<{ roles: string[] }>(
      "SELECT access_authorized_actor_roles($1,$2) AS roles, access_authorized_actor_roles($1,$3) AS reader_roles",
      [row.actor_id, row.capability, READ_CAPABILITY],
    )).rows[0]?.roles;
    if (!roles?.length) return null;
    return {
      actor: { actorId: row.actor_id, actorRoles: roles, authorizationCapability: row.capability,
        authorizationCapabilities: [READ_CAPABILITY, row.capability], requestId: `sourcing-contract-resume:${candidate.document_id}` },
      scenarioId: row.scenario_id,
    };
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
      CASE WHEN (previous.sourcing_approval_snapshot_id IS DISTINCT FROM snapshot.sourcing_approval_snapshot_id OR previous.identity_version<(SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=snapshot.sourcing_case_id))
        AND EXISTS(SELECT 1 FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=previous.sourcing_contract_document_id)
        THEN previous.template_version
        ELSE (SELECT max(template_version) FROM sourcing_contract_template_versions WHERE effective_from<=CURRENT_TIMESTAMP) END AS template_version
      FROM sourcing_approval_snapshots snapshot
      LEFT JOIN LATERAL (SELECT sourcing_contract_document_id,sourcing_approval_snapshot_id,identity_version,template_version FROM sourcing_contract_documents
        WHERE sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
          OR sourcing_decision_id=(SELECT supersedes_decision_id FROM sourcing_decisions
            WHERE sourcing_decision_id=snapshot.sourcing_decision_id AND source_type='factory_change')
        ORDER BY contract_version DESC LIMIT 1) previous ON true
      WHERE snapshot.sourcing_approval_snapshot_id=$1`,[approvalSnapshotId])).rows[0];
    if (!metadata) throw new ApplicationError("INVALID_STATE_TRANSITION","合同批准快照不存在或关联缺失；请订单跟单在本单合同页核对当前批准方案，由Root核查合同关联，不要重复点击批准",409);
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
                'deliveryDate',COALESCE((SELECT min(po.factory_delivery_date) FROM digital_production_child_lines child JOIN digital_production_po_lines po USING(production_order_id,line_id) WHERE child.module='sourcing' AND child.child_id=snapshot.sourcing_case_id),snapshot.delivery_date),
                'processes',snapshot.processes,
                'approvedAt',snapshot.approved_at,
                'lines',COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'position',line.position,'styleNo',identity.style_no,'imageAttachmentId',identity.image_attachment_id,
                    'imageSha256',(SELECT sha256 FROM attachments WHERE attachment_id=identity.image_attachment_id),
                    'alternateStyleNo',identity.alternate_style_no,'color',line.color,
                    'quantity',line.quantity,'unitPrice',line.unit_price::text,
                    'totalAmount',line.total_amount::text
                  ) || COALESCE((SELECT jsonb_build_object('lineId',po.line_id,'deliveryDate',po.factory_delivery_date::text)
                    FROM digital_production_child_lines child JOIN digital_production_po_lines po USING(production_order_id,line_id)
                    WHERE child.module='sourcing' AND child.child_id=snapshot.sourcing_case_id
                      AND child.child_line_key=line.position::text AND po.factory_delivery_date IS NOT NULL),'{}'::jsonb) ORDER BY line.position)
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
         WHERE sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
          OR sourcing_decision_id=(SELECT supersedes_decision_id FROM sourcing_decisions
            WHERE sourcing_decision_id=snapshot.sourcing_decision_id AND source_type='factory_change')
        ORDER BY contract_version DESC LIMIT 1) previous ON true
       LEFT JOIN LATERAL (SELECT (SELECT jsonb_object_agg(field_name,field_value) FROM sourcing_contract_supplements
         WHERE sourcing_contract_document_id=previous.sourcing_contract_document_id
           AND previous.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id)
         || '{}'::jsonb AS direct_values) direct ON true
       LEFT JOIN LATERAL (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) || COALESCE(direct.direct_values,'{}'::jsonb) AS values
         FROM jsonb_each(previous.approval_snapshot) WHERE previous.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id AND key=ANY(ARRAY['supplierName','supplierCode','address','contractEntityName','partyBRepresentative','payeeName','bankAccount','bankName'])) supplements ON true
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
    if (inserted.rows[0]) await this.inheritFactoryContent(client,documentId);
    const existing = inserted.rows[0] ? null : await client.query<{ sourcing_contract_document_id: string }>(
      `SELECT sourcing_contract_document_id FROM sourcing_contract_documents
       WHERE sourcing_approval_snapshot_id=$1 AND identity_version=$2 AND template_version=$3
       ORDER BY contract_version DESC LIMIT 1`,
      [approvalSnapshotId,metadata.identity_version,metadata.template_version],
    );
    const id = inserted.rows[0]?.sourcing_contract_document_id
      ?? existing?.rows[0]?.sourcing_contract_document_id;
    if (!id) throw new ApplicationError("INVALID_STATE_TRANSITION", "合同批准快照不存在或关联缺失；请订单跟单在本单合同页核对当前批准方案，由Root核查合同关联，不要重复点击批准", 409);
    return id;
  }

  private async inheritFactoryContent(client: Pick<PoolClient,"query">,documentId:string):Promise<void> {
    await client.query(`INSERT INTO sourcing_contract_content_overrides(sourcing_contract_document_id,content,operation_event_id)
      SELECT d.sourcing_contract_document_id,sourcing_contract_content_for_factory_change(d.sourcing_contract_document_id),snapshot.operation_event_id
      FROM sourcing_contract_documents d JOIN sourcing_contract_documents previous ON previous.sourcing_contract_document_id=d.revision_of
      JOIN sourcing_contract_content_overrides old_content ON old_content.sourcing_contract_document_id=d.revision_of
      JOIN sourcing_approval_snapshots snapshot ON snapshot.sourcing_approval_snapshot_id=d.sourcing_approval_snapshot_id
      WHERE d.sourcing_contract_document_id=$1 AND d.sourcing_approval_snapshot_id<>previous.sourcing_approval_snapshot_id
        AND d.status='generation_pending' AND NOT EXISTS(SELECT 1 FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=d.sourcing_contract_document_id)`,[documentId]);
  }

  async getCurrent(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    sourcingContractDocumentId?:string,
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
         AND ($2::uuid IS NULL OR document.sourcing_contract_document_id=$2)
       ORDER BY document.contract_version DESC LIMIT 1`,
      [sourcingCaseId,sourcingContractDocumentId??null],
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
      await lockDigitalSourcingHandover(client,sourcingCaseId,actor);
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
        if (!actor.actorRoles.includes(ROOT_ROLE) && await effectiveSourcingMerchandiser(client,sourcingCaseId,row.created_by) !== actor.actorId) {
          throw new ApplicationError("FORBIDDEN", "仅订单跟单或Root可补充合同缺项", 403);
        }
        if (row.status !== "pending_supplement") {
          throw new ApplicationError("INVALID_STATE_TRANSITION", "合同已冻结，不能直接修改；请订单跟单在本单合同页核对当前版本，资料不符时提供合同链接给Root核查，不能覆盖原批准内容", 409);
        }
        for (const [field,value] of entries) {
          if (!FIELD_NAMES.includes(field) || !row.missing_fields.includes(field)) {
            throw new ApplicationError("INVALID_STATE_TRANSITION", "只能补充当前合同缺项；请订单跟单重新读取本单合同页列出的缺项，仅填写仍缺失的字段，已冻结字段不在本入口修改", 409);
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
        if (remaining.length===0) await this.inheritFactoryContent(client,row.sourcing_contract_document_id);
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
    recovery?: GenerationOptions,
  ): Promise<SourcingContractStateResponse> {
    const attemptId = randomUUID();
    const signal = recovery?.signal;
    signal?.throwIfAborted();
    const claimed = await this.database.query<ContractRow>(
      `UPDATE sourcing_contract_documents document
       SET status='generating',failure_reason=NULL,generation_attempt_id=$4,
           generation_lease_until=clock_timestamp()+INTERVAL '5 minutes'
       FROM sourcing_cases source_case, sourcing_approval_snapshots approved
       WHERE document.sourcing_case_id=$1 AND source_case.sourcing_case_id=document.sourcing_case_id
         AND source_case.deleted_at IS NULL
         AND approved.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
         AND approved.sourcing_case_id=document.sourcing_case_id AND approved.sourcing_decision_id=document.sourcing_decision_id
         AND (($2::uuid IS NULL AND document.contract_version=(
             SELECT max(latest.contract_version) FROM sourcing_contract_documents latest
             WHERE latest.sourcing_case_id=document.sourcing_case_id
           )) OR document.sourcing_contract_document_id=$2::uuid)
         AND ($3::integer IS NULL OR document.contract_version=$3)
         AND (document.status='generation_pending' OR ($3::integer IS NULL AND document.status='generation_failed') OR (${staleGeneration}))
         AND cardinality(document.missing_fields)=0
       RETURNING document.*,source_case.created_by`,
      [sourcingCaseId, sourcingContractDocumentId ?? null, recovery?.recoveryVersion ?? null, attemptId],
    );
    const row = claimed.rows[0];
    if (!row) return this.getCurrent(actor, sourcingCaseId, sourcingContractDocumentId);
    const documentId = row.sourcing_contract_document_id;
    const read = () => this.getCurrent(actor, sourcingCaseId, documentId);
    const refs = { caseId: sourcingCaseId, documentId, version: Number(row.contract_version), attemptId };
    recovery?.report?.(refs, "contract generation claimed");

    // Loading frozen facts is separate from rendering so transient DB reads
    // leave the lease recoverable, without asserting an actual PDF failure.
    const content = await loadContractContent(this.database, documentId);
    let pdf: Buffer;
    let fingerprint: string;
    let staged: ReturnType<AttachmentService["stageContractPdf"]>;
    try {
      const snapshot = await hydrateContractContentImages(this.attachments, sourcingCaseId, content, signal);
      fingerprint = sourcingContractFingerprint(snapshot);
      pdf = signal ? await renderRecoveryContract(snapshot, signal)
        : await renderSourcingContractPdf(await normalizeSourcingContractSnapshotImages(snapshot));
      staged = this.attachments.stageContractPdf(`${row.contract_number}.pdf`, pdf);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (await this.failGeneration(sourcingCaseId, documentId, attemptId, error)) throw error;
      recovery?.report?.(refs, "contract generation ownership lost after render failure");
      return read();
    }
    const reusableAttachmentId = await this.attachments.reusableContractPdf(documentId, staged, signal);
    if (!reusableAttachmentId) {
      const recorded = await this.database.query(
        `INSERT INTO sourcing_contract_generation_staging(generation_attempt_id,sourcing_contract_document_id,object_key,sha256)
         SELECT $3, sourcing_contract_document_id, $4, $5 FROM sourcing_contract_documents
         WHERE sourcing_case_id=$1 AND sourcing_contract_document_id=$2 AND generation_attempt_id=$3 AND status='generating'`,
        [sourcingCaseId, documentId, attemptId, staged.objectKey, staged.sha256],
      );
      if (recorded.rowCount !== 1) {
        recovery?.report?.(refs, "contract generation ownership lost before staging");
        return read();
      }
      try {
        await this.attachments.writeContractPdf(staged, pdf, signal);
      } catch (error) {
        // A failed object-store acknowledgement may have written the private
        // object. Keep its durable identity for reconciliation.
        if (signal?.aborted) throw signal.reason;
        if (await this.failGeneration(sourcingCaseId, documentId, attemptId, error)) throw error;
        recovery?.report?.(refs, "contract generation ownership lost after storage failure");
        return read();
      }
    }

    signal?.throwIfAborted();
    const client = await this.database.connect();
    let commitAttempted = false;
    let publicationStarted = false;
    let destroyConnection = false;
    let lost = false;
    let transactionError: unknown;
    try {
      await client.query("BEGIN");
      await lockDigitalSourcingHandover(client, sourcingCaseId, actor);
      const liveCase = await client.query(
        "SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE", [sourcingCaseId],
      );
      const owner = await client.query(
        `SELECT 1 FROM sourcing_contract_documents
         WHERE sourcing_case_id=$1 AND sourcing_contract_document_id=$2 AND generation_attempt_id=$3 AND status='generating' FOR UPDATE`,
        [sourcingCaseId, documentId, attemptId],
      );
      if (!liveCase.rowCount || !owner.rowCount) {
        lost = true;
        await client.query("ROLLBACK");
      } else {
        signal?.throwIfAborted();
        publicationStarted = true;
        const attachmentId = reusableAttachmentId ?? await this.attachments.publishContractPdf(client, actor, documentId, staged);
        await client.query(
          `UPDATE sourcing_contract_documents
           SET status='ready', snapshot_fingerprint=$4, pdf_attachment_id=$5, pdf_sha256=$6,
               generated_at=COALESCE(generated_at,CURRENT_TIMESTAMP), failure_reason=NULL,
               generation_attempt_id=NULL, generation_lease_until=NULL
           WHERE sourcing_case_id=$1 AND sourcing_contract_document_id=$2 AND generation_attempt_id=$3 AND status='generating'`,
          [sourcingCaseId, documentId, attemptId, fingerprint, attachmentId, staged.sha256],
        );
        if (!reusableAttachmentId) {
          await client.query("UPDATE sourcing_contract_generation_staging SET published_attachment_id=$2 WHERE generation_attempt_id=$1", [attemptId, attachmentId]);
        }
        if (row.generated_at === null) {
          const ready = await recordContractBusinessReady(client, this.database, actor, this.events, sourcingCaseId, documentId);
          if (ready.created && ready.first && ready.orderId) {
            await new DigitalProductionTaskService(this.database).refreshFactoryBatchTimingWithClient(client, actor, ready.orderId);
          }
        }
        await this.synchronizeGeneratedContract(client, actor, sourcingCaseId, documentId);
        commitAttempted = true;
        await client.query("COMMIT");
      }
    } catch (error) {
      transactionError = error;
      destroyConnection = commitAttempted;
      await client.query("ROLLBACK").catch(() => { destroyConnection = true; });
    } finally { client.release(destroyConnection); }

    if (commitAttempted && transactionError) {
      // The document's immutable pointer (and the staging key, when used)
      // resolve a lost COMMIT acknowledgement on a fresh pool checkout.
      const committed = await this.database.query(
        `SELECT 1 FROM sourcing_contract_documents document JOIN attachments file ON file.attachment_id=document.pdf_attachment_id
         WHERE document.sourcing_case_id=$1 AND document.sourcing_contract_document_id=$2 AND document.status='ready'
           AND document.pdf_sha256=$3 AND (file.object_key=$4 OR file.attachment_id=$5::uuid)`,
        [sourcingCaseId, documentId, staged.sha256, staged.objectKey, reusableAttachmentId],
      );
      if (committed.rowCount === 1) {
        recovery?.report?.(refs, "contract publication confirmed after lost acknowledgement");
        return read();
      }
      throw transactionError;
    }
    if (transactionError) {
      if (publicationStarted && !destroyConnection && !signal?.aborted
        && await this.failGeneration(sourcingCaseId, documentId, attemptId, transactionError, "合同正式就绪未提交，请核对后重试")) {
        if (!reusableAttachmentId) await this.discardContractStaging(attemptId, staged.objectKey);
        throw transactionError;
      }
      // Interruption and uncertain database reads retain staging for reconciliation.
      throw transactionError;
    }
    if (lost && !reusableAttachmentId) await this.discardContractStaging(attemptId, staged.objectKey);
    recovery?.report?.(refs, lost ? "contract generation ownership lost before publication" : "contract generation published");
    return read();
  }

  private async failGeneration(caseId: string, documentId: string, attemptId: string, error: unknown, message?: string): Promise<boolean> {
    const reason = message ?? (error instanceof Error ? error.message.slice(0,500) : "合同PDF生成失败");
    const result = await this.database.query(
      `UPDATE sourcing_contract_documents document
       SET status='generation_failed',failure_reason=$4,generation_attempt_id=NULL,generation_lease_until=NULL
       FROM sourcing_cases source_case
       WHERE document.sourcing_case_id=$1 AND document.sourcing_contract_document_id=$2 AND document.generation_attempt_id=$3
         AND document.status='generating' AND source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL`,
      [caseId, documentId, attemptId, reason],
    );
    return result.rowCount === 1;
  }

  private async discardContractStaging(attemptId: string, objectKey: string): Promise<void> {
    try {
      const unattached = await this.database.query(
        `SELECT 1 FROM sourcing_contract_generation_staging stage
         JOIN sourcing_contract_documents document USING(sourcing_contract_document_id)
         WHERE stage.generation_attempt_id=$1 AND stage.object_key=$2 AND stage.published_attachment_id IS NULL
           AND document.generation_attempt_id IS DISTINCT FROM stage.generation_attempt_id
           AND NOT EXISTS(SELECT 1 FROM attachments WHERE object_key=stage.object_key)`,
        [attemptId, objectKey],
      );
      if (unattached.rowCount !== 1) return;
      await this.attachments.discardStagedContractPdf(objectKey);
      await this.database.query("UPDATE sourcing_contract_generation_staging SET discarded_at=clock_timestamp() WHERE generation_attempt_id=$1", [attemptId]);
    } catch {
      process.emitWarning("Unpublished contract object remains in the staging inventory", { code: "CONTRACT_STAGING_CLEANUP_FAILED" });
    }
  }

  private async synchronizeGeneratedContract(client: PoolClient, actor: TrustedActorContext, caseId: string, documentId: string) {
    await client.query("SAVEPOINT transfer_contract_todos");
    try {
      await this.transferTodos.synchronize(client, actor, caseId, { documentId });
      await client.query("RELEASE SAVEPOINT transfer_contract_todos");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT transfer_contract_todos");
      await this.events.append(client, actor, {
        action: "sourcing.transfer_contract_todo.deferred", entityType: "sourcing_case", entityId: caseId,
        after: { sourcingContractDocumentId: documentId },
        reason: error instanceof ApplicationError ? error.message : "待办投影失败，需重试核对",
      });
    }
  }

  /** Explicit recovery of enrolled new business only; never scans or enrolls historical orders. */
  async retryReturnTodos(actor: TrustedActorContext, caseId: string, documentId: string, key: string) {
    if (!actor.actorRoles.includes(ROOT_ROLE)) throw new ApplicationError("FORBIDDEN","仅Root可恢复合同待办",403);
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      await lockDigitalSourcingHandover(client,caseId,actor);
      const outcome=await this.idempotency.execute(client,{
        scope:"sourcing.contract-return-todo.retry",actorKey:actor.actorId,key,
        requestHash:requestHash("sourcing.contract-return-todo.retry",{caseId,documentId}),expiresAt:new Date(Date.now()+86400000),
      },async()=>{
        await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE",[caseId]);
        const {current}=await this.transferTodos.inspect(client,caseId);
        const enrolled=(await client.query("SELECT 1 FROM sourcing_contract_return_cycles WHERE sourcing_approval_snapshot_id=$1 AND origin='business'",[current?.return_cycle_id??null])).rowCount;
        if (!enrolled || current?.sourcing_contract_document_id!==documentId || current.status!=="ready")
          throw new ApplicationError("CONFLICT","仅可恢复明确纳入新规则且已就绪的当前业务合同；历史补录需单独预检",409);
        const result=await this.transferTodos.synchronize(client,actor,caseId);
        await this.events.append(client,actor,{action:"sourcing.contract_return_todo.retry",entityType:"sourcing_case",entityId:caseId,
          after:{documentId,...result}});
        return {statusCode:200,response:result};
      });
      await client.query("COMMIT");return {...outcome.response,reused:outcome.reused};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
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
    const currentMerchandiser=await effectiveSourcingMerchandiser(this.database,row.sourcing_case_id,row.created_by);
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
        || (actor.actorRoles.includes(MERCHANDISER_ROLE) && actor.actorId === currentMerchandiser)),
      canEditContent: row.status === "ready" && canEditContractContent(actor,row.reconciled !== false),
      canRefreshInformation: row.status !== "generating" && canRefreshContractInformation(actor,currentMerchandiser,row.returned === true)
        && (actor.actorRoles.includes(ROOT_ROLE) || await memberCanWriteModule(this.database,actor.actorId,"sourcing")),
    };
  }
}
