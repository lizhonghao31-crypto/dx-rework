import { createHash, randomUUID } from "node:crypto";

import {
  CuttingOrderQuerySchema,
  cuttingAllowedRange,
  cuttingOutOfRange,
  type CorrectCuttingRecord,
  type CreateCuttingRecord,
  type CuttingOrderDetail,
  type CuttingOrderListResponse,
  type CuttingRecordMutationResponse,
} from "@dx-rework/contracts";
import { LIST_PAGE_SIZE } from "@dx-rework/contracts/reporting";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

const VIEW_CAPABILITY = "cutting:orders:view";
const RECORD_CAPABILITY = "cutting:records:create";
const CORRECT_CAPABILITY = "cutting:records:correct";
const ROOT_ROLE = "root_superuser";
const VIEW_ROLES = new Set([
  "cutting_supervisor",
  "cutting_worker",
  "owner_group",
  "production_management",
  "order_merchandiser",
]);
const RECORD_ROLES = new Set(["cutting_supervisor", "cutting_worker"]);
const BROAD_VIEW_ROLES = new Set([
  ROOT_ROLE,
  "cutting_supervisor",
  "cutting_worker",
  "owner_group",
  "production_management",
]);
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const fail = (
  message: string,
  statusCode = 409,
  code = "INVALID_STATE_TRANSITION",
): never => {
  throw new ApplicationError(code, message, statusCode);
};
const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function ensureCuttingOrdersForApproval(
  client: PoolClient,
  sourcingCaseId: string,
  approvalSnapshotId: string,
): Promise<void> {
  const approvedLines = await client.query<{ position: number }>(
    `SELECT line.position
     FROM sourcing_approval_snapshots snapshot
     JOIN sourcing_approval_snapshot_lines line
       ON line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
     WHERE snapshot.sourcing_approval_snapshot_id=$1
       AND snapshot.sourcing_case_id=$2
     ORDER BY line.position`,
    [approvalSnapshotId, sourcingCaseId],
  );
  if (approvedLines.rowCount === 0) {
    fail("批准快照没有可生成的裁床款明细");
  }
  for (const line of approvedLines.rows) {
    await client.query(
      `INSERT INTO cutting_orders(
         cutting_order_id,sourcing_case_id,sourcing_line_position,approval_snapshot_id
       ) VALUES($1,$2,$3,$4)
       ON CONFLICT(sourcing_case_id,sourcing_line_position) DO NOTHING`,
      [randomUUID(), sourcingCaseId, line.position, approvalSnapshotId],
    );
  }
  const positions = approvedLines.rows.map((line) => line.position);
  const persisted = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM cutting_orders
     WHERE sourcing_case_id=$1
       AND sourcing_line_position=ANY($2::integer[])`,
    [sourcingCaseId, positions],
  );
  if (persisted.rows[0]?.count !== positions.length) {
    fail("裁床源单未能完整建立");
  }
}

type CuttingReadRow = {
  cutting_order_id: string;
  sourcing_case_id: string;
  sourcing_line_position: number | string;
  formal_style_no: string | null;
  alternate_style_no: string | null;
  display_style_no: string;
  image_attachment_id: string | null;
  style_name_snapshot: string | null;
  gender: "男装" | "女装" | null;
  color: string | null;
  contract_number: string | null;
  contract_quantity: number | string;
  supplier_id: string;
  supplier_name: string;
  merchandiser_id: string;
  merchandiser_name: string;
  delivery_date: string | null;
  cutting_process: "in_house" | "outsourced" | "other" | null;
  cutting_process_other: string | null;
  processes: string[];
  approved_at: Date | string;
  cutting_record_id: string | null;
  record_version: number | string | null;
  piece_count: number | string | null;
  actual_cut_count: number | string | null;
  initial_piece_count: number | string | null;
  initial_actual_cut_count: number | string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  recorded_at: Date | string | null;
  corrected: boolean | null;
  status: "pending" | "recorded";
  is_out_of_range: boolean | null;
};

const READ_CTE = `
WITH cutting_read AS (
  SELECT cutting.cutting_order_id,cutting.sourcing_case_id,
         cutting.sourcing_line_position,
         source_line.formal_style_no,source_line.alternate_style_no,
         source_line.style_no AS display_style_no,source_line.image_attachment_id,
         snapshot.style_name_snapshot,snapshot.gender,source_line.color,
         contract.contract_number,
         snapshot_line.quantity AS contract_quantity,
         COALESCE(current_decision.supplier_id,snapshot.supplier_id) AS supplier_id,
         COALESCE(current_decision.supplier_name_snapshot,snapshot.supplier_name_snapshot) AS supplier_name,
         source_case.created_by AS merchandiser_id,
         creator.display_name AS merchandiser_name,
         to_char(sourcing_effective_delivery_date(cutting.sourcing_case_id,snapshot.delivery_date),'YYYY-MM-DD') AS delivery_date,
         current_decision.cutting_process,current_decision.cutting_process_other,
         snapshot.processes,
         snapshot.approved_at,
         current_record.cutting_record_id,current_record.version AS record_version,
         current_record.piece_count,current_record.actual_cut_count,
         current_record.initial_piece_count,current_record.initial_actual_cut_count,
         current_record.recorded_by,recorder.display_name AS recorded_by_name,
         current_record.recorded_at,current_record.corrected,
         CASE WHEN current_record.cutting_record_id IS NULL THEN 'pending' ELSE 'recorded' END AS status,
         CASE WHEN current_record.cutting_record_id IS NULL THEN NULL
              ELSE current_record.actual_cut_count*100 < snapshot_line.quantity::bigint*95
                OR current_record.actual_cut_count*100 > snapshot_line.quantity::bigint*105
         END AS is_out_of_range
  FROM cutting_orders cutting
  JOIN sourcing_cases source_case
    ON source_case.sourcing_case_id=cutting.sourcing_case_id
   AND source_case.deleted_at IS NULL
  JOIN current_sourcing_case_lines source_line
    ON source_line.sourcing_case_id=cutting.sourcing_case_id
   AND source_line.position=cutting.sourcing_line_position
  JOIN sourcing_approval_snapshots snapshot
    ON snapshot.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
  JOIN sourcing_approval_snapshot_lines snapshot_line
    ON snapshot_line.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
   AND snapshot_line.position=cutting.sourcing_line_position
  JOIN app_users creator ON creator.id=source_case.created_by
  LEFT JOIN current_cutting_records current_record
    ON current_record.cutting_order_id=cutting.cutting_order_id
  LEFT JOIN app_users recorder ON recorder.id=current_record.recorded_by
  LEFT JOIN LATERAL (
    SELECT decision.supplier_id,decision.supplier_name_snapshot,
           decision.cutting_process,decision.cutting_process_other
    FROM sourcing_decisions decision
    WHERE decision.sourcing_case_id=cutting.sourcing_case_id
    ORDER BY decision.decision_version DESC
    LIMIT 1
  ) current_decision ON true
  LEFT JOIN LATERAL (
    SELECT sourcing_contract_display_number(document.sourcing_contract_document_id,document.contract_number) AS contract_number
    FROM sourcing_contract_documents document
    WHERE document.sourcing_case_id=cutting.sourcing_case_id
    ORDER BY document.contract_version DESC
    LIMIT 1
  ) contract ON true
)
`;

export class CuttingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  private isRoot(actor: TrustedActorContext): boolean {
    return actor.actorRoles.includes(ROOT_ROLE);
  }

  private merchandiserOnly(actor: TrustedActorContext): boolean {
    return !actor.actorRoles.some((role) => BROAD_VIEW_ROLES.has(role))
      && actor.actorRoles.includes("order_merchandiser");
  }

  private assertReader(actor: TrustedActorContext): void {
    if (this.isRoot(actor)) return;
    if (
      actor.authorizationCapability !== VIEW_CAPABILITY
      || !(actor.authorizationCapabilities ?? []).includes(VIEW_CAPABILITY)
      || !actor.actorRoles.some((role) => VIEW_ROLES.has(role))
    ) {
      throw new ApplicationError("FORBIDDEN", "无权查看裁床实裁数据", 403);
    }
  }

  private assertRecorder(actor: TrustedActorContext): void {
    if (this.isRoot(actor)) return;
    if (
      actor.authorizationCapability !== RECORD_CAPABILITY
      || !(actor.authorizationCapabilities ?? []).includes(RECORD_CAPABILITY)
      || !actor.actorRoles.some((role) => RECORD_ROLES.has(role))
    ) {
      throw new ApplicationError("FORBIDDEN", "当前岗位无权登记裁床实裁", 403);
    }
  }

  private assertCorrector(actor: TrustedActorContext): void {
    if (!this.isRoot(actor) || actor.authorizationCapability !== CORRECT_CAPABILITY) {
      throw new ApplicationError("FORBIDDEN", "仅 Root 可以修正已登记裁床数量", 403);
    }
  }

  private canRecord(actor: TrustedActorContext): boolean {
    return this.isRoot(actor) || (
      actor.actorRoles.some((role) => RECORD_ROLES.has(role))
      && (actor.authorizationCapabilities ?? []).includes(RECORD_CAPABILITY)
    );
  }

  private async lockActiveOrder(client: PoolClient, cuttingOrderId: string): Promise<void> {
    const locked = await client.query(
      `SELECT cutting.cutting_order_id
       FROM cutting_orders cutting
       JOIN sourcing_cases source_case
         ON source_case.sourcing_case_id=cutting.sourcing_case_id
        AND source_case.deleted_at IS NULL
       WHERE cutting.cutting_order_id=$1
       FOR UPDATE OF source_case,cutting`,
      [cuttingOrderId],
    );
    if (!locked.rowCount) {
      fail("裁床订单不存在或源订单已删除", 404, "NOT_FOUND");
    }
  }

  async list(actor: TrustedActorContext, input: unknown): Promise<CuttingOrderListResponse> {
    this.assertReader(actor);
    const query = CuttingOrderQuerySchema.parse(input);
    const merchOnly = this.merchandiserOnly(actor);
    const search = query.q.trim();
    const status = query.status;
    const outOnly = query.outOfRange === "true";
    const params = [search, merchOnly, actor.actorId, status, outOnly] as const;
    const filter = `
      WHERE ($1::text='' OR display_style_no ILIKE '%'||$1||'%'
        OR formal_style_no ILIKE '%'||$1||'%'
        OR alternate_style_no ILIKE '%'||$1||'%'
        OR contract_number ILIKE '%'||$1||'%'
        OR supplier_name ILIKE '%'||$1||'%'
        OR merchandiser_name ILIKE '%'||$1||'%'
        OR recorded_by_name ILIKE '%'||$1||'%')
        AND ($2::boolean=false OR merchandiser_id=$3::uuid)
        AND ($4::text='all' OR status=$4::text)
        AND ($5::boolean=false OR is_out_of_range=true)`;
    const totalResult = await this.database.query<{ total_count: number | string }>(
      READ_CTE + `SELECT count(*) AS total_count FROM cutting_read ${filter}`,
      [...params],
    );
    const totalCount = Number(totalResult.rows[0]?.total_count ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / LIST_PAGE_SIZE));
    const page = Math.min(query.page, totalPages);
    const offset = (page - 1) * LIST_PAGE_SIZE;
    const rows = await this.database.query<CuttingReadRow>(
      READ_CTE + `SELECT * FROM cutting_read ${filter}
        ORDER BY (status='pending') DESC,
          CASE WHEN status='pending' THEN approved_at END ASC,
          CASE WHEN status='recorded' THEN recorded_at END DESC,
          cutting_order_id
        LIMIT $6 OFFSET $7`,
      [...params, LIST_PAGE_SIZE, offset],
    );
    return {
      items: rows.rows.map((row) => this.mapListRow(row)),
      page,
      totalPages,
      totalCount,
    };
  }

  async listSources(actor: TrustedActorContext) {
    this.assertReader(actor);
    const merchOnly = this.merchandiserOnly(actor);
    const rows = await this.database.query<CuttingReadRow>(
      READ_CTE + `SELECT * FROM cutting_read
       WHERE ($1::boolean=false OR merchandiser_id=$2::uuid)
       ORDER BY approved_at,cutting_order_id`,
      [merchOnly, actor.actorId],
    );
    return { items: rows.rows.map((row) => this.mapListRow(row)) };
  }

  async get(actor: TrustedActorContext, cuttingOrderId: string): Promise<CuttingOrderDetail> {
    this.assertReader(actor);
    return this.readDetail(this.database, actor, cuttingOrderId);
  }

  private async readDetail(
    db: Queryable,
    actor: TrustedActorContext,
    cuttingOrderId: string,
  ): Promise<CuttingOrderDetail> {
    const merchOnly = this.merchandiserOnly(actor);
    const result = await db.query<CuttingReadRow>(
      READ_CTE + `SELECT * FROM cutting_read
       WHERE cutting_order_id=$1
         AND ($2::boolean=false OR merchandiser_id=$3::uuid)`,
      [cuttingOrderId, merchOnly, actor.actorId],
    );
    const row = result.rows[0] ?? fail("裁床订单不存在或不在当前可读范围", 404, "NOT_FOUND");
    const contractQuantity = Number(row.contract_quantity);
    const base = this.mapListRow(row);
    const photos = row.image_attachment_id
      ? (await db.query<{
          attachment_id: string;
          original_filename: string;
          mime_type: "image/jpeg" | "image/png" | "image/webp";
        }>(
          `SELECT attachment_id,original_filename,mime_type
           FROM attachments
           WHERE attachment_id=$1
             AND entity_type='sourcing_case'
             AND entity_id=$2::text
             AND status='ready'
             AND mime_type IN ('image/jpeg','image/png','image/webp')`,
          [row.image_attachment_id, row.sourcing_case_id],
        )).rows.map((photo) => ({
          attachmentId: photo.attachment_id,
          filename: photo.original_filename,
          mimeType: photo.mime_type,
        }))
      : [];
    let record: CuttingOrderDetail["record"] = null;
    if (row.cutting_record_id && row.recorded_by && row.recorded_by_name && row.recorded_at) {
      const corrections = await db.query<{
        correction_version: number | string;
        piece_count: number | string;
        actual_cut_count: number | string;
        reason: string;
        corrected_by: string;
        corrected_by_name: string;
        corrected_at: Date | string;
      }>(
        `SELECT correction.correction_version,correction.piece_count,
                correction.actual_cut_count,correction.reason,
                correction.corrected_by,actor.display_name AS corrected_by_name,
                correction.corrected_at
         FROM cutting_record_corrections correction
         JOIN app_users actor ON actor.id=correction.corrected_by
         WHERE correction.cutting_record_id=$1
         ORDER BY correction.correction_version`,
        [row.cutting_record_id],
      );
      const cuttingSheetPhotos = await db.query<{
        attachment_id: string;
        original_filename: string;
        mime_type: "image/jpeg" | "image/png" | "image/webp";
      }>(
        `SELECT attachment_id,original_filename,mime_type
         FROM attachments
         WHERE entity_type='cutting_record'
           AND entity_id=$1::text
           AND status='ready'
           AND mime_type IN ('image/jpeg','image/png','image/webp')
         ORDER BY created_at,attachment_id`,
        [row.cutting_record_id],
      );
      record = {
        cuttingRecordId: row.cutting_record_id,
        version: Number(row.record_version),
        pieceCount: Number(row.piece_count),
        actualCutCount: Number(row.actual_cut_count),
        initialPieceCount: Number(row.initial_piece_count),
        initialActualCutCount: Number(row.initial_actual_cut_count),
        recordedBy: row.recorded_by,
        recordedByName: row.recorded_by_name,
        recordedAt: toIso(row.recorded_at)!,
        corrected: row.corrected === true,
        cuttingSheetPhotos: cuttingSheetPhotos.rows.map((photo) => ({
          attachmentId: photo.attachment_id,
          filename: photo.original_filename,
          mimeType: photo.mime_type,
        })),
        corrections: corrections.rows.map((correction) => ({
          version: Number(correction.correction_version) + 1,
          pieceCount: Number(correction.piece_count),
          actualCutCount: Number(correction.actual_cut_count),
          reason: correction.reason,
          correctedBy: correction.corrected_by,
          correctedByName: correction.corrected_by_name,
          correctedAt: toIso(correction.corrected_at)!,
        })),
      };
    }
    return {
      ...base,
      allowedRange: cuttingAllowedRange(contractQuantity),
      photos,
      record,
      canRecord: !record && Boolean(row.formal_style_no) && this.canRecord(actor),
      canCorrect: Boolean(record) && this.isRoot(actor),
    };
  }

  async record(
    actor: TrustedActorContext,
    cuttingOrderId: string,
    input: CreateCuttingRecord,
    idempotencyKey: string,
  ): Promise<{ value: CuttingRecordMutationResponse; reused: boolean }> {
    this.assertRecorder(actor);
    if (!KEY_PATTERN.test(idempotencyKey)) {
      fail("缺少有效操作标识，请重试", 400, "VALIDATION_ERROR");
    }
    const scope = "cutting.record.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute<CuttingRecordMutationResponse>(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash({ cuttingOrderId, ...input }),
        expiresAt: new Date("9999-12-31T00:00:00Z"),
      }, async () => {
        await this.lockActiveOrder(client, cuttingOrderId);
        const source = await client.query<{
          formal_style_no: string | null;
          contract_quantity: number | string;
          cutting_record_id: string | null;
        }>(
          `SELECT line.formal_style_no,snapshot_line.quantity AS contract_quantity,
                  record.cutting_record_id
           FROM cutting_orders cutting
           JOIN current_sourcing_case_lines line
             ON line.sourcing_case_id=cutting.sourcing_case_id
            AND line.position=cutting.sourcing_line_position
           JOIN sourcing_approval_snapshot_lines snapshot_line
             ON snapshot_line.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
            AND snapshot_line.position=cutting.sourcing_line_position
           LEFT JOIN cutting_records record ON record.cutting_order_id=cutting.cutting_order_id
           WHERE cutting.cutting_order_id=$1`,
          [cuttingOrderId],
        );
        const row = source.rows[0] ?? fail("裁床订单不存在", 404, "NOT_FOUND");
        if (row.cutting_record_id) {
          return {
            statusCode: 200,
            response: {
              outcome: "already_recorded" as const,
              item: await this.readDetail(client, actor, cuttingOrderId),
            },
          };
        }
        if (!row.formal_style_no?.trim()) {
          fail("正式款号尚未补齐，暂不能登记实裁", 409, "INVALID_STATE_TRANSITION");
        }
        if (input.attachmentIds.length < 1 || input.attachmentIds.length > 3
          || new Set(input.attachmentIds).size !== input.attachmentIds.length) {
          fail("请上传1至3张不重复的裁床单图片", 400, "VALIDATION_ERROR");
        }
        const readyAttachments = await client.query(
          `SELECT attachment_id
           FROM attachments
           WHERE attachment_id=ANY($1::uuid[])
             AND uploaded_by=$2
             AND status='ready'
             AND entity_type IS NULL
             AND entity_id IS NULL
             AND mime_type IN ('image/jpeg','image/png','image/webp')
           FOR UPDATE`,
          [input.attachmentIds, actor.actorId],
        );
        if (readyAttachments.rowCount !== input.attachmentIds.length) {
          fail("裁床单图片未完成上传、归属不符或格式无效", 400, "VALIDATION_ERROR");
        }
        const outOfRange = cuttingOutOfRange(Number(row.contract_quantity), input.actualCutCount);
        const eventId = await this.events.append(client, actor, {
          action: "cutting.record.create",
          entityType: "cutting_order",
          entityId: cuttingOrderId,
          before: { status: "pending" },
          after: {
            status: "recorded",
            pieceCount: input.pieceCount,
            actualCutCount: input.actualCutCount,
            attachmentIds: input.attachmentIds,
            outOfRange,
          },
          reason: "登记裁床实裁",
        });
        const recordId = randomUUID();
        await client.query(
          `INSERT INTO cutting_records(
             cutting_record_id,cutting_order_id,piece_count,actual_cut_count,
             attachment_ids,recorded_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            recordId, cuttingOrderId, input.pieceCount, input.actualCutCount,
            input.attachmentIds, actor.actorId, eventId, actor.requestId,
          ],
        );
        const boundAttachments = await client.query(
          `UPDATE attachments
           SET entity_type='cutting_record',entity_id=$1::text,updated_at=clock_timestamp()
           WHERE attachment_id=ANY($2::uuid[])
           RETURNING attachment_id`,
          [recordId, input.attachmentIds],
        );
        if (boundAttachments.rowCount !== input.attachmentIds.length) {
          fail("裁床单图片绑定失败，请重试", 409, "INVALID_STATE_TRANSITION");
        }
        return {
          statusCode: 201,
          response: {
            outcome: "created" as const,
            item: await this.readDetail(client, actor, cuttingOrderId),
          },
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async correct(
    actor: TrustedActorContext,
    cuttingOrderId: string,
    input: CorrectCuttingRecord,
    idempotencyKey: string,
  ): Promise<{ value: CuttingRecordMutationResponse; reused: boolean }> {
    this.assertCorrector(actor);
    if (!KEY_PATTERN.test(idempotencyKey)) {
      fail("缺少有效操作标识，请重试", 400, "VALIDATION_ERROR");
    }
    const scope = "cutting.record.correct";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute<CuttingRecordMutationResponse>(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash({ cuttingOrderId, ...input }),
        expiresAt: new Date("9999-12-31T00:00:00Z"),
      }, async () => {
        await this.lockActiveOrder(client, cuttingOrderId);
        const current = await client.query<{
          cutting_record_id: string;
          version: number | string;
          piece_count: number | string;
          actual_cut_count: number | string;
          contract_quantity: number | string;
        }>(
          `SELECT record.cutting_record_id,record.version,record.piece_count,
                  record.actual_cut_count,snapshot_line.quantity AS contract_quantity
           FROM cutting_orders cutting
           JOIN current_cutting_records record
             ON record.cutting_order_id=cutting.cutting_order_id
           JOIN sourcing_approval_snapshot_lines snapshot_line
             ON snapshot_line.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
            AND snapshot_line.position=cutting.sourcing_line_position
           WHERE cutting.cutting_order_id=$1`,
          [cuttingOrderId],
        );
        const row = current.rows[0] ?? fail("该裁床订单尚未登记，不能修正", 409, "INVALID_STATE_TRANSITION");
        const version = Number(row.version);
        if (version !== input.expectedVersion) {
          fail("裁床数量已变化，请刷新后再修正", 409, "CONFLICT");
        }
        const outOfRange = cuttingOutOfRange(Number(row.contract_quantity), input.actualCutCount);
        const eventId = await this.events.append(client, actor, {
          action: "cutting.record.correct",
          entityType: "cutting_record",
          entityId: row.cutting_record_id,
          before: {
            version,
            pieceCount: Number(row.piece_count),
            actualCutCount: Number(row.actual_cut_count),
          },
          after: {
            version: version + 1,
            pieceCount: input.pieceCount,
            actualCutCount: input.actualCutCount,
            outOfRange,
          },
          reason: input.reason,
        });
        await client.query(
          `INSERT INTO cutting_record_corrections(
             cutting_correction_id,cutting_record_id,correction_version,
             piece_count,actual_cut_count,reason,corrected_by,
             operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(), row.cutting_record_id, version,
            input.pieceCount, input.actualCutCount, input.reason,
            actor.actorId, eventId, actor.requestId,
          ],
        );
        return {
          statusCode: 200,
          response: {
            outcome: "corrected" as const,
            item: await this.readDetail(client, actor, cuttingOrderId),
          },
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async canDownload(
    actor: TrustedActorContext,
    binding: Readonly<{ entityType: string; entityId: string; mimeType: string }>,
  ): Promise<boolean> {
    if (!binding.mimeType.startsWith("image/")) return false;
    try {
      this.assertReader(actor);
    } catch (error) {
      if (error instanceof ApplicationError && error.statusCode === 403) return false;
      throw error;
    }
    const merchOnly = this.merchandiserOnly(actor);
    if (binding.entityType === "sourcing_case") {
      const result = await this.database.query(
        `SELECT 1
         FROM cutting_orders cutting
         JOIN sourcing_cases source_case
           ON source_case.sourcing_case_id=cutting.sourcing_case_id
          AND source_case.deleted_at IS NULL
         WHERE cutting.sourcing_case_id=$1::uuid
           AND ($2::boolean=false OR source_case.created_by=$3::uuid)
         LIMIT 1`,
        [binding.entityId, merchOnly, actor.actorId],
      );
      return Boolean(result.rowCount);
    }
    if (binding.entityType === "cutting_record") {
      const result = await this.database.query(
        `SELECT 1
         FROM cutting_records record
         JOIN cutting_orders cutting ON cutting.cutting_order_id=record.cutting_order_id
         JOIN sourcing_cases source_case
           ON source_case.sourcing_case_id=cutting.sourcing_case_id
          AND source_case.deleted_at IS NULL
         WHERE record.cutting_record_id=$1::uuid
           AND ($2::boolean=false OR source_case.created_by=$3::uuid)
         LIMIT 1`,
        [binding.entityId, merchOnly, actor.actorId],
      );
      return Boolean(result.rowCount);
    }
    return false;
  }

  private mapListRow(row: CuttingReadRow) {
    const contractQuantity = Number(row.contract_quantity);
    const actualCutCount = row.actual_cut_count === null ? null : Number(row.actual_cut_count);
    return {
      cuttingOrderId: row.cutting_order_id,
      sourcingCaseId: row.sourcing_case_id,
      sourcePosition: Number(row.sourcing_line_position),
      formalStyleNo: row.formal_style_no,
      alternateStyleNo: row.alternate_style_no,
      displayStyleNo: row.display_style_no,
      styleName: row.style_name_snapshot,
      gender: row.gender,
      color: row.color,
      contractNumber: row.contract_number,
      contractQuantity,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      merchandiserId: row.merchandiser_id,
      merchandiserName: row.merchandiser_name,
      deliveryDate: row.delivery_date,
      cuttingProcess: row.cutting_process,
      cuttingProcessOther: row.cutting_process_other,
      processes: row.processes ?? [],
      approvedAt: toIso(row.approved_at)!,
      status: row.status,
      pieceCount: row.piece_count === null ? null : Number(row.piece_count),
      actualCutCount,
      recordedByName: row.recorded_by_name,
      recordedAt: toIso(row.recorded_at),
      outOfRange: actualCutCount === null
        ? null
        : cuttingOutOfRange(contractQuantity, actualCutCount),
    } as const;
  }
}

// Compatibility for PR01 tests and call sites while PR02 routes use CuttingService.
export class CuttingSourceService extends CuttingService {}
