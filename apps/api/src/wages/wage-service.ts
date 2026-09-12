import { requireFinanceWageAccess } from "./wage-access.js";
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
  type IdempotencyService,
  type OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

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
type Permissions = { export: boolean };

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
    _idem?: IdempotencyService,
    _events?: OperationEventRepository,
    _todos?: TodoProjectionService,
  ) { void _idem; void _events; void _todos; }

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

  // Compatibility rejection only; the retired month-close writer has been removed.
  async lock(_actor: TrustedActorContext, _periodId: string, _expectedVersion: number, _note: string | null, _key: string): Promise<never> {
    void _actor; void _periodId; void _expectedVersion; void _note; void _key;
    return fail("旧工资月结已停用",409,"INVALID_STATE_TRANSITION");
  }

  private async requireView(actor: TrustedActorContext) {
    await requireFinanceWageAccess(this.db, actor, "wage:view");
  }

  private async permissions(actor: TrustedActorContext, _executor: Pool | PoolClient): Promise<Permissions> {
    void _executor;
    return {export: actor.authorizationCapabilities?.includes("wage:export") ?? false};
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
      canLock: false,
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

}
