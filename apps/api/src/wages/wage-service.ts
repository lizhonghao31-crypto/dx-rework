import { createHash, randomUUID } from "node:crypto";

import type {
  LargestRemainderAllocation,
  LargestRemainderMember,
  WageItem,
  WagePeriod,
  WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type Status = "ready_to_lock" | "locked";
type PeriodRow = {
  period_id: string;
  period_month: string;
  timezone: "Asia/Singapore";
  status: Status;
  period_version: number;
  source_item_count: number;
  person_count: number;
  original_total: string;
  locked_by: string | null;
  locked_at: Date | null;
  lock_note: string | null;
};
type ItemRow = {
  wage_item_id: string;
  period_id: string;
  order_review_id: string;
  rework_order_id: string;
  configuration_item_id: string;
  work_task_id: string;
  work_report_id: string;
  person_id: string;
  person_name_snapshot: string;
  person_type_snapshot: "internal" | "temporary";
  supplier_name_snapshot: string;
  temporary_wage_multiplier: string;
  rework_no_snapshot: string;
  style_no_snapshot: string;
  process_name_snapshot: string;
  pricing_unit_snapshot: "piece" | "hour";
  unit_price_snapshot: string;
  actual_quantity_snapshot: string;
  assignment_mode: "individual" | "collective";
  group_amount: string;
  exact_person_share: string;
  payable_amount: string;
  fractional_remainder: string;
  remainder_rank: number;
  member_count: number;
  member_snapshot: WageItem["memberSnapshot"];
};
type Permissions = { monthClose: boolean; export: boolean };

export type WageSettlementFilters = Readonly<{
  from: string;
  to: string;
  q?: string;
  personType?: "internal" | "temporary";
}>;
export type WageSettlementSummary = Readonly<{
  personCount: number;
  itemCount: number;
}>;

type SettlementSummaryRow = { person_count: number | string; item_count: number | string };

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const first = <T>(rows: T[], message: string, status = 404): T => {
  const value = rows[0];
  if (value === undefined) throw new ApplicationError("NOT_FOUND", message, status);
  return value;
};
const parseDecimal = (value: string, scale: number) => {
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(value)) {
    fail("金额格式无效", 400, "VALIDATION_ERROR");
  }
  const parts = value.split(".");
  return {
    whole: BigInt(parts[0] ?? "0"),
    fraction: (parts[1] ?? "").padEnd(scale, "0"),
  };
};
const money = (value: bigint): string => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function allocateLargestRemainder(
  groupAmount: string,
  members: readonly LargestRemainderMember[],
): LargestRemainderAllocation[] {
  if (members.length === 0) fail("工资份额不能为空", 400, "VALIDATION_ERROR");
  if (new Set(members.map((member) => member.personId)).size !== members.length) {
    fail("工资份额人员不能重复", 400, "VALIDATION_ERROR");
  }
  const group = parseDecimal(groupAmount, 2);
  const target = group.whole * 100n + BigInt(group.fraction);
  const ranked = members.map((member) => {
    const parsed = parseDecimal(member.exactAmount, 8);
    return {
      ...member,
      base: parsed.whole * 100n + BigInt(parsed.fraction.slice(0, 2)),
      remainder: BigInt(parsed.fraction.slice(2)),
    };
  }).sort((left, right) =>
    left.remainder === right.remainder
      ? left.personId.localeCompare(right.personId)
      : left.remainder > right.remainder ? -1 : 1,
  );
  const remaining = target - ranked.reduce((sum, member) => sum + member.base, 0n);
  if (remaining < 0n || remaining > BigInt(ranked.length)) {
    fail("高精度份额无法按最大余数法对齐组总额", 400, "VALIDATION_ERROR");
  }
  const values = new Map(ranked.map((member, index) => [member.personId, {
    payableAmount: money(member.base + (BigInt(index) < remaining ? 1n : 0n)),
    fractionalRemainder: `0.${member.remainder.toString().padStart(6, "0")}`,
    remainderRank: index + 1,
  }]));
  return members.map((member) => ({ ...member, ...values.get(member.personId)! }));
}

export class WageService {
  constructor(
    private readonly db: Pool,
    private readonly idem = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async list(actor: TrustedActorContext): Promise<WagePeriod[]> {
    await this.requireView(actor);
    const permissions = await this.permissions(actor, this.db);
    const result = await this.db.query<PeriodRow>(
      `SELECT period_id,period_month::text,timezone,status,period_version,
              source_item_count,person_count,original_total::text,
              locked_by,locked_at,lock_note
       FROM rework_wage_periods
       WHERE status='locked' OR source_item_count>0
       ORDER BY period_month DESC`,
    );
    return result.rows.map((row) => this.periodDto(row, permissions));
  }

  async get(actor: TrustedActorContext, periodId: string): Promise<WagePeriodDetail> {
    await this.requireView(actor);
    const permissions = await this.permissions(actor, this.db);
    const [periods, items] = await Promise.all([
      this.db.query<PeriodRow>(
        `SELECT period_id,period_month::text,timezone,status,period_version,
                source_item_count,person_count,original_total::text,
                locked_by,locked_at,lock_note
         FROM rework_wage_periods
         WHERE period_id=$1 AND (status='locked' OR source_item_count>0)`,
        [periodId],
      ),
      this.db.query<ItemRow>(
        `${this.itemSelect()} WHERE item.period_id=$1 ORDER BY item.person_name_snapshot,item.created_at,item.wage_item_id`,
        [periodId],
      ),
    ]);
    return {
      period: this.periodDto(first(periods.rows, "工资期间不存在"), permissions),
      items: items.rows.map((row) => this.itemDto(row)),
    };
  }

  async item(actor: TrustedActorContext, itemId: string): Promise<WageItem> {
    await this.requireView(actor);
    const result = await this.db.query<ItemRow>(
      `${this.itemSelect()} WHERE item.wage_item_id=$1`,
      [itemId],
    );
    return this.itemDto(first(result.rows, "工资明细不存在"));
  }

  /** Legacy compatibility only. No current web route exposes month-close locking. */
  async lock(
    actor: TrustedActorContext,
    periodId: string,
    expectedVersion: number,
    note: string | null,
    key: string,
  ): Promise<Result<{ closureId: string; periodId: string; status: "locked"; periodVersion: number }>> {
    await this.requireDirect(actor, "wage_month_close_accountant", "wage:month_close");
    return this.mutate(actor, "wage.month_close", key, { periodId, expectedVersion, note }, async (client) => {
      const period = await this.period(client, periodId);
      if (period.period_version !== expectedVersion || period.status !== "ready_to_lock") {
        fail("工资期间尚未进入可月结状态或版本冲突");
      }
      const ended = await client.query<{ ended: boolean }>(
        `SELECT CURRENT_TIMESTAMP >= (($1::date+interval '1 month')::timestamp
          AT TIME ZONE 'Asia/Singapore') ended`,
        [period.period_month],
      );
      if (!first(ended.rows, "月份边界校验失败", 409).ended) {
        fail("自然月结束前不能锁定", 409, "INVALID_STATE_TRANSITION");
      }
      const eventId = await this.events.append(
        client,
        { ...actor, authorizationCapability: "wage:month_close" },
        {
          action: "wage.month_close",
          entityType: "wage_period",
          entityId: periodId,
          before: this.periodAudit(period),
          after: { ...this.periodAudit(period), status: "locked" },
          ...(note ? { reason: note } : {}),
        },
      );
      await this.context(client, eventId, actor.requestId);
      const closureId = randomUUID();
      await client.query(
        `INSERT INTO rework_wage_month_closures(
           closure_id,period_id,period_version_snapshot,item_count,person_count,
           original_total,adjustment_total,final_total,locked_by,locked_at,
           lock_note,operation_event_id,operation_request_id
         ) VALUES($1,$2,$3,$4,$5,$6::numeric,0,$6::numeric,$7,
           CURRENT_TIMESTAMP,$8,$9,$10)`,
        [
          closureId,
          periodId,
          period.period_version,
          period.source_item_count,
          period.person_count,
          period.original_total,
          actor.actorId,
          note,
          eventId,
          actor.requestId,
        ],
      );
      await client.query(
        `INSERT INTO rework_wage_month_close_lines(
           closure_line_id,closure_id,line_type,wage_item_id,adjustment_id,
           person_id,person_name_snapshot,person_type_snapshot,rework_no_snapshot,
           style_no_snapshot,process_name_snapshot,quantity_snapshot,unit_snapshot,
           unit_price_snapshot,assignment_mode,member_snapshot,original_amount,
           adjustment_amount,final_amount)
         SELECT gen_random_uuid(),$2,'wage_item',wage_item_id,NULL,person_id,
           person_name_snapshot,person_type_snapshot,rework_no_snapshot,
           style_no_snapshot,process_name_snapshot,actual_quantity_snapshot,
           pricing_unit_snapshot,unit_price_snapshot,assignment_mode,member_snapshot,
           payable_amount,0,payable_amount
         FROM rework_wage_items
         WHERE period_id=$1 AND invalidated_at IS NULL`,
        [periodId, closureId],
      );
      await client.query(
        `SET CONSTRAINTS wage_closure_complete_on_closure,wage_closure_complete_on_line IMMEDIATE`,
      );
      await client.query(
        `UPDATE rework_wage_periods SET status='locked',locked_by=$2,
          locked_at=CURRENT_TIMESTAMP,lock_note=$3,locked_operation_event_id=$4,
          locked_request_id=$5,period_version=period_version+1,
          adjustment_total=0,final_total=original_total,
          updated_at=CURRENT_TIMESTAMP WHERE period_id=$1`,
        [periodId, actor.actorId, note, eventId, actor.requestId],
      );
      await this.todos?.completeOpenByDedupeKey(
        client,
        actor,
        `wage-month-lock:${periodId}:${period.period_version}`,
        "Wage month was locked",
      );
      return {
        closureId,
        periodId,
        status: "locked" as const,
        periodVersion: expectedVersion + 1,
      };
    });
  }

  async settlementSummary(
    actor: TrustedActorContext,
    filters: WageSettlementFilters,
  ): Promise<WageSettlementSummary> {
    this.requireSettlement(actor);
    const result = await this.db.query<SettlementSummaryRow>(
      `SELECT count(*) item_count,count(DISTINCT wage.person_id) person_count
       FROM rework_wage_items wage
       JOIN rework_work_reports report ON report.work_report_id=wage.work_report_id
       JOIN rework_orders order_record ON order_record.rework_order_id=wage.rework_order_id
       LEFT JOIN rework_wage_settlement_marks mark ON mark.wage_item_id=wage.wage_item_id
       WHERE wage.invalidated_at IS NULL
         AND order_record.status<>'deleted'
         AND mark.wage_item_id IS NULL
         AND (report.completed_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date
         AND ($3::text IS NULL OR wage.person_name_snapshot ILIKE $3 OR wage.rework_no_snapshot ILIKE $3 OR wage.style_no_snapshot ILIKE $3)
         AND ($4::text IS NULL OR wage.person_type_snapshot=$4)`,
      [filters.from, filters.to, filters.q ? `%${filters.q}%` : null, filters.personType ?? null],
    );
    const row = first(result.rows, "工资结算范围统计失败", 500);
    return { personCount: Number(row.person_count), itemCount: Number(row.item_count) };
  }

  async settleFiltered(
    actor: TrustedActorContext,
    filters: WageSettlementFilters,
    key: string,
  ): Promise<Result<WageSettlementSummary>> {
    this.requireSettlement(actor);
    return this.mutate(actor, "wage.settlement_mark", key, filters, async (client) => {
      const batchId = randomUUID();
      const eventId = await this.events.append(
        client,
        { ...actor, authorizationCapability: "wage:settlement_mark" },
        {
          action: "wage.settlement_mark",
          entityType: "wage_settlement_batch",
          entityId: batchId,
          after: {
            from: filters.from,
            to: filters.to,
            q: filters.q ?? null,
            personType: filters.personType ?? null,
          },
        },
      );
      const result = await client.query<SettlementSummaryRow>(
        `WITH candidates AS (
           SELECT wage.wage_item_id,wage.person_id
           FROM rework_wage_items wage
           JOIN rework_work_reports report ON report.work_report_id=wage.work_report_id
           JOIN rework_orders order_record ON order_record.rework_order_id=wage.rework_order_id
           LEFT JOIN rework_wage_settlement_marks mark ON mark.wage_item_id=wage.wage_item_id
           WHERE wage.invalidated_at IS NULL
             AND order_record.status<>'deleted'
             AND mark.wage_item_id IS NULL
             AND (report.completed_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date
             AND ($3::text IS NULL OR wage.person_name_snapshot ILIKE $3 OR wage.rework_no_snapshot ILIKE $3 OR wage.style_no_snapshot ILIKE $3)
             AND ($4::text IS NULL OR wage.person_type_snapshot=$4)
           FOR UPDATE OF wage
         ), inserted AS (
           INSERT INTO rework_wage_settlement_marks(
             wage_item_id,settled_by,operation_event_id,operation_request_id
           )
           SELECT wage_item_id,$5,$6,$7 FROM candidates
           ON CONFLICT(wage_item_id) DO NOTHING
           RETURNING wage_item_id
         )
         SELECT count(*) item_count,count(DISTINCT candidate.person_id) person_count
         FROM candidates candidate JOIN inserted USING(wage_item_id)`,
        [
          filters.from,
          filters.to,
          filters.q ? `%${filters.q}%` : null,
          filters.personType ?? null,
          actor.actorId,
          eventId,
          actor.requestId,
        ],
      );
      const row = first(result.rows, "工资结算标记失败", 500);
      return { personCount: Number(row.person_count), itemCount: Number(row.item_count) };
    });
  }

  private async requireView(actor: TrustedActorContext) {
    if (!actor.authorizationCapabilities?.includes("wage:view")) {
      fail("缺少工资查看能力", 403, "FORBIDDEN");
    }
    await this.db.query("SELECT access_authorized_actor_roles($1,'wage:view')", [actor.actorId]);
  }

  private requireSettlement(actor: TrustedActorContext): void {
    const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (!actor.actorRoles.includes("root_superuser") && !capabilities.includes("wage:settlement_mark")) {
      fail("缺少工资结算标记权限", 403, "FORBIDDEN");
    }
  }

  private async requireDirect(actor: TrustedActorContext, role: string, capability: string) {
    const result = await this.db.query<{ allowed: boolean }>(
      "SELECT wage_has_direct_role($1,$2,$3) allowed",
      [actor.actorId, role, capability],
    );
    if (!first(result.rows, "工资权限校验失败", 403).allowed) {
      fail("必须由直接有效业务角色执行", 403, "FORBIDDEN");
    }
  }

  private async permissions(
    actor: TrustedActorContext,
    executor: Pool | PoolClient,
  ): Promise<Permissions> {
    const result = await executor.query<Permissions>(
      `SELECT wage_has_direct_role($1,'wage_month_close_accountant','wage:month_close') "monthClose",
        $2::boolean export`,
      [actor.actorId, actor.authorizationCapabilities?.includes("wage:export") ?? false],
    );
    return first(result.rows, "工资权限校验失败", 403);
  }

  private periodDto(row: PeriodRow, permission: Permissions): WagePeriod {
    return {
      periodId: row.period_id,
      periodMonth: row.period_month,
      timezone: row.timezone,
      status: row.status,
      periodVersion: row.period_version,
      sourceItemCount: row.source_item_count,
      personCount: row.person_count,
      totalAmount: row.original_total,
      lockedBy: row.locked_by,
      lockedAt: iso(row.locked_at),
      lockNote: row.lock_note,
      canLock: permission.monthClose && row.status === "ready_to_lock",
      canExport: permission.export,
    };
  }

  private itemDto(row: ItemRow): WageItem {
    return {
      wageItemId: row.wage_item_id,
      periodId: row.period_id,
      orderReviewId: row.order_review_id,
      reworkOrderId: row.rework_order_id,
      configurationItemId: row.configuration_item_id,
      workTaskId: row.work_task_id,
      workReportId: row.work_report_id,
      personId: row.person_id,
      personNameSnapshot: row.person_name_snapshot,
      personTypeSnapshot: row.person_type_snapshot,
      supplierNameSnapshot: row.supplier_name_snapshot,
      temporaryWageMultiplier: row.temporary_wage_multiplier,
      reworkNoSnapshot: row.rework_no_snapshot,
      styleNoSnapshot: row.style_no_snapshot,
      processNameSnapshot: row.process_name_snapshot,
      pricingUnitSnapshot: row.pricing_unit_snapshot,
      unitPriceSnapshot: row.unit_price_snapshot,
      actualQuantitySnapshot: row.actual_quantity_snapshot,
      assignmentMode: row.assignment_mode,
      groupAmount: row.group_amount,
      exactPersonShare: row.exact_person_share,
      payableAmount: row.payable_amount,
      fractionalRemainder: row.fractional_remainder,
      remainderRank: row.remainder_rank,
      memberCount: row.member_count,
      memberSnapshot: row.member_snapshot,
    };
  }

  private itemSelect() {
    return `SELECT item.wage_item_id,item.period_id,item.order_review_id,item.rework_order_id,
      item.configuration_item_id,item.work_task_id,item.work_report_id,item.person_id,
      item.person_name_snapshot,item.person_type_snapshot,
      CASE WHEN orders.processing_factory_type='own_factory' THEN '本厂'
           ELSE COALESCE(supplier.supplier_name,'供应商资料不可用') END supplier_name_snapshot,
      COALESCE(coefficient.multiplier,'1.000') temporary_wage_multiplier,
      item.rework_no_snapshot,item.style_no_snapshot,item.process_name_snapshot,
      item.pricing_unit_snapshot,item.unit_price_snapshot::text,
      item.actual_quantity_snapshot::text,item.assignment_mode,
      item.group_amount::text,item.exact_person_share::text,item.payable_amount::text,
      item.fractional_remainder::text,item.remainder_rank,item.member_count,item.member_snapshot
      FROM rework_wage_items item
      JOIN rework_orders orders
        ON orders.rework_order_id=item.rework_order_id
       AND item.invalidated_at IS NULL
      LEFT JOIN current_supplier_catalog supplier
        ON supplier.supplier_id=orders.processing_factory_supplier_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(coefficient.multiplier,1)::numeric(8,3)::text multiplier
        FROM rework_tail_completion_confirmations confirmation
        LEFT JOIN rework_tail_completion_coefficients coefficient
          ON coefficient.confirmation_id=confirmation.confirmation_id
         AND coefficient.configuration_item_id=item.configuration_item_id
         AND coefficient.person_id=item.person_id
        WHERE confirmation.rework_order_id=item.rework_order_id
        ORDER BY confirmation.confirmed_at DESC,confirmation.confirmation_id DESC
        LIMIT 1
      ) coefficient ON true`;
  }

  private async period(client: PoolClient, periodId: string): Promise<PeriodRow> {
    const result = await client.query<PeriodRow>(
      `SELECT period_id,period_month::text,timezone,status,period_version,
        source_item_count,person_count,original_total::text,locked_by,locked_at,lock_note
       FROM rework_wage_periods WHERE period_id=$1 FOR UPDATE`,
      [periodId],
    );
    return first(result.rows, "工资期间不存在");
  }

  private async context(client: PoolClient, eventId: string, requestId: string) {
    await client.query(
      `SELECT set_config('dx_rework.wage_event_id',$1,true),
        set_config('dx_rework.wage_request_id',$2,true)`,
      [eventId, requestId],
    );
  }

  private periodAudit(row: PeriodRow): Record<string, unknown> {
    return {
      periodId: row.period_id,
      periodMonth: row.period_month,
      status: row.status,
      periodVersion: row.period_version,
      sourceItemCount: row.source_item_count,
      personCount: row.person_count,
      totalAmount: row.original_total,
    };
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    scope: string,
    key: string,
    payload: unknown,
    work: (client: PoolClient) => Promise<T>,
    statusCode = 200,
  ): Promise<Result<T>> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idem.execute(
        client,
        {
          scope,
          actorKey: actor.actorId,
          key,
          requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        async () => ({ statusCode, response: await work(client) }),
      );
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
