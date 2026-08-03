import { createHash, randomUUID } from "node:crypto";

import type {
  CreateWageAdjustment,
  LargestRemainderAllocation,
  LargestRemainderMember,
  WageAdjustment,
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

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type Status = "pending_tail_review" | "pending_admin_review" | "ready_to_lock" | "locked";
type PeriodRow = {
  period_id: string; period_month: string; timezone: "Asia/Singapore";
  status: Status; period_version: number; source_item_count: number;
  person_count: number; original_total: string; adjustment_total: string;
  final_total: string; locked_by: string | null; locked_at: Date | null;
  lock_note: string | null;
};
type ItemRow = {
  wage_item_id: string; period_id: string; order_review_id: string;
  rework_order_id: string; configuration_item_id: string; work_task_id: string;
  work_report_id: string; person_id: string; person_name_snapshot: string;
  person_type_snapshot: "internal" | "temporary"; rework_no_snapshot: string;
  style_no_snapshot: string; process_name_snapshot: string;
  pricing_unit_snapshot: "piece" | "hour"; unit_price_snapshot: string;
  actual_quantity_snapshot: string; assignment_mode: "individual" | "collective";
  group_amount: string; exact_person_share: string; payable_amount: string;
  fractional_remainder: string; remainder_rank: number; member_count: number;
  member_snapshot: WageItem["memberSnapshot"];
};
type AdjustmentRow = {
  adjustment_id: string; original_wage_item_id: string; target_period_id: string;
  target_period_version_snapshot: number; person_id: string;
  adjustment_amount: string; reason: string; attachment_ids: string[];
  status: "pending" | "approved" | "rejected"; requested_by: string;
  requested_at: Date; decided_by: string | null; decided_at: Date | null;
  decision_reason: string | null; version: number;
};
type ReviewRow = {
  review_action_id: string; period_id: string; period_version_snapshot: number;
  stage: "tail" | "administrative"; decision: "approved" | "returned";
  reason: string | null; acted_by: string;
  actor_role_snapshot: "tail_supervisor" | "administrative_clerk";
  acted_at: Date;
};
type Permissions = {
  tail: boolean; administrative: boolean; monthClose: boolean; export: boolean;
};

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const first = <T>(rows: T[], message: string, status = 404): T => {
  const value = rows[0];
  if (value === undefined) fail(message, status, "NOT_FOUND");
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
  ) {}

  async list(actor: TrustedActorContext): Promise<WagePeriod[]> {
    await this.requireView(actor);
    const permissions = await this.permissions(actor, this.db);
    const result = await this.db.query<PeriodRow>(
      `SELECT period_id,period_month::text,timezone,status,period_version,
              source_item_count,person_count,original_total::text,
              adjustment_total::text,final_total::text,locked_by,locked_at,lock_note
       FROM rework_wage_periods ORDER BY period_month DESC`,
    );
    return result.rows.map((row) => this.periodDto(row, permissions));
  }

  async get(actor: TrustedActorContext, periodId: string): Promise<WagePeriodDetail> {
    await this.requireView(actor);
    const permissions = await this.permissions(actor, this.db);
    const [periods, items, adjustments, actions] = await Promise.all([
      this.db.query<PeriodRow>(
        `SELECT period_id,period_month::text,timezone,status,period_version,
                source_item_count,person_count,original_total::text,
                adjustment_total::text,final_total::text,locked_by,locked_at,lock_note
         FROM rework_wage_periods WHERE period_id=$1`, [periodId],
      ),
      this.db.query<ItemRow>(`${this.itemSelect()} WHERE period_id=$1 ORDER BY person_name_snapshot,created_at,wage_item_id`, [periodId]),
      this.db.query<AdjustmentRow>(`${this.adjustmentSelect()} WHERE target_period_id=$1 ORDER BY requested_at,adjustment_id`, [periodId]),
      this.db.query<ReviewRow>(
        `SELECT review_action_id,period_id,period_version_snapshot,stage,decision,
                reason,acted_by,actor_role_snapshot,acted_at
         FROM rework_wage_review_actions WHERE period_id=$1
         ORDER BY acted_at,review_action_id`, [periodId],
      ),
    ]);
    return {
      period: this.periodDto(first(periods.rows, "工资期间不存在"), permissions),
      items: items.rows.map((row) => this.itemDto(row)),
      adjustments: adjustments.rows.map((row) => this.adjustmentDto(row)),
      reviewActions: actions.rows.map((row) => ({
        reviewActionId: row.review_action_id,
        periodId: row.period_id,
        periodVersionSnapshot: row.period_version_snapshot,
        stage: row.stage,
        decision: row.decision,
        reason: row.reason,
        actedBy: row.acted_by,
        actorRoleSnapshot: row.actor_role_snapshot,
        actedAt: row.acted_at.toISOString(),
      })),
    };
  }

  async item(actor: TrustedActorContext, itemId: string): Promise<WageItem> {
    await this.requireView(actor);
    const result = await this.db.query<ItemRow>(`${this.itemSelect()} WHERE wage_item_id=$1`, [itemId]);
    return this.itemDto(first(result.rows, "工资明细不存在"));
  }

  async review(
    actor: TrustedActorContext,
    periodId: string,
    expectedVersion: number,
    kind: "tail" | "administrative_approve" | "administrative_return",
    reason: string | null,
    key: string,
  ): Promise<Result<WagePeriod>> {
    const role = kind === "tail" ? "tail_supervisor" : "administrative_clerk";
    const capability = kind === "tail" ? "wage:tail_review" : "wage:administrative_review";
    await this.requireDirect(actor, role, capability);
    return this.mutate(actor, `wage.${kind}`, key, { periodId, expectedVersion, reason }, async (client) => {
      const period = await this.period(client, periodId);
      if (period.period_version !== expectedVersion) fail("工资期间版本冲突");
      const required: Status = kind === "tail" ? "pending_tail_review" : "pending_admin_review";
      if (period.status !== required) fail("工资期间状态不允许该操作", 409, "INVALID_STATE_TRANSITION");
      if (kind === "administrative_return" && !reason?.trim()) fail("行政退回必须填写原因", 400, "VALIDATION_ERROR");
      const next: Status = kind === "tail" ? "pending_admin_review" : kind === "administrative_approve" ? "ready_to_lock" : "pending_tail_review";
      const action = kind === "tail" ? "wage.tail_approve" : kind === "administrative_approve" ? "wage.administrative_approve" : "wage.administrative_return";
      const eventId = await this.events.append(client, { ...actor, authorizationCapability: capability }, {
        action, entityType: "wage_period", entityId: periodId,
        before: this.periodAudit(period), after: { ...this.periodAudit(period), status: next },
        ...(reason ? { reason } : {}),
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        `INSERT INTO rework_wage_review_actions(
           review_action_id,period_id,period_version_snapshot,stage,decision,
           reason,acted_by,actor_role_snapshot,operation_event_id,operation_request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), periodId, expectedVersion, kind === "tail" ? "tail" : "administrative", kind === "administrative_return" ? "returned" : "approved", reason, actor.actorId, role, eventId, actor.requestId],
      );
      await client.query(
        `UPDATE rework_wage_periods SET status=$2,period_version=period_version+1,
          updated_at=CURRENT_TIMESTAMP WHERE period_id=$1`, [periodId, next],
      );
      return this.periodDto(await this.period(client, periodId), await this.permissions(actor, client));
    });
  }

  async requestAdjustment(
    actor: TrustedActorContext,
    input: CreateWageAdjustment,
    key: string,
  ): Promise<Result<WageAdjustment>> {
    await this.requireDirect(actor, "tail_supervisor", "wage:adjustment_request");
    return this.mutate(actor, "wage.adjustment.request", key, input, async (client) => {
      const target = await this.period(client, input.targetPeriodId);
      if (target.period_version !== input.expectedVersion || target.status === "locked") fail("目标工资期间已锁定或版本冲突");
      const sources = await client.query<ItemRow & { source_status: Status; source_month: string }>(
        `SELECT item.*,source.status source_status,source.period_month::text source_month
         FROM rework_wage_items item JOIN rework_wage_periods source ON source.period_id=item.period_id
         WHERE item.wage_item_id=$1 FOR SHARE OF item,source`, [input.originalWageItemId],
      );
      const source = first(sources.rows, "原工资明细不存在");
      if ((source.source_status !== "locked" && source.period_id !== target.period_id)
        || (source.source_status === "locked" && target.period_month <= source.source_month)) {
        fail("工资调整目标月份不符合锁定规则", 400, "VALIDATION_ERROR");
      }
      if (new Set(input.attachmentIds).size !== input.attachmentIds.length) fail("调整附件不能重复", 400, "VALIDATION_ERROR");
      if (input.attachmentIds.length > 0) {
        const ready = await client.query(
          `SELECT attachment_id FROM attachments
           WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready'
             AND entity_type IS NULL AND entity_id IS NULL FOR UPDATE`,
          [input.attachmentIds, actor.actorId],
        );
        if (ready.rowCount !== input.attachmentIds.length) fail("附件未完成、并非本人上传或已绑定其他业务", 409, "ATTACHMENT_NOT_READY");
      }
      const adjustmentId = randomUUID();
      const eventId = await this.events.append(client, { ...actor, authorizationCapability: "wage:adjustment_request" }, {
        action: "wage.adjustment.request", entityType: "wage_adjustment", entityId: adjustmentId,
        after: { adjustmentId, originalWageItemId: input.originalWageItemId, targetPeriodId: input.targetPeriodId, personId: source.person_id, adjustmentAmount: input.adjustmentAmount, attachmentIds: input.attachmentIds },
        reason: input.reason,
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        `INSERT INTO rework_wage_adjustments(
           adjustment_id,original_wage_item_id,target_period_id,target_period_version_snapshot,
           person_id,adjustment_amount,reason,attachment_ids,requested_by,
           request_operation_event_id,request_operation_request_id
         ) VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10,$11)`,
        [adjustmentId, input.originalWageItemId, input.targetPeriodId, target.period_version, source.person_id, input.adjustmentAmount, input.reason, input.attachmentIds, actor.actorId, eventId, actor.requestId],
      );
      if (input.attachmentIds.length > 0) {
        await client.query(
          `UPDATE attachments SET entity_type='wage_adjustment',entity_id=$2,
            updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($1::uuid[])`,
          [input.attachmentIds, adjustmentId],
        );
      }
      return this.adjustmentDto(await this.adjustmentRow(client, adjustmentId, false));
    }, 201);
  }

  async decideAdjustment(
    actor: TrustedActorContext,
    adjustmentId: string,
    expectedVersion: number,
    approved: boolean,
    reason: string | null,
    key: string,
  ): Promise<Result<WageAdjustment>> {
    await this.requireDirect(actor, "administrative_clerk", "wage:adjustment_approve");
    return this.mutate(actor, approved ? "wage.adjustment.approve" : "wage.adjustment.reject", key, { adjustmentId, expectedVersion, reason }, async (client) => {
      const adjustment = await this.adjustmentRow(client, adjustmentId, true);
      if (adjustment.version !== expectedVersion || adjustment.status !== "pending") fail("调整版本或状态冲突");
      if (adjustment.requested_by === actor.actorId) fail("发起人不得审批自己的调整", 403, "FORBIDDEN");
      if (!approved && !reason?.trim()) fail("拒绝必须填写原因", 400, "VALIDATION_ERROR");
      const target = await this.period(client, adjustment.target_period_id);
      if (target.status === "locked") fail("锁定月份不得处理调整");
      if (approved) {
        const check = await client.query<{ valid: boolean }>(
          `SELECT (COALESCE((SELECT sum(payable_amount) FROM rework_wage_items
             WHERE period_id=$1 AND person_id=$2),0)
           +COALESCE((SELECT sum(adjustment_amount) FROM rework_wage_adjustments
             WHERE target_period_id=$1 AND person_id=$2 AND status='approved'),0)
           +$3::numeric)>=0 valid`,
          [target.period_id, adjustment.person_id, adjustment.adjustment_amount],
        );
        if (!first(check.rows, "工资金额校验失败", 409).valid) fail("减少调整会使人员月度工资为负", 400, "VALIDATION_ERROR");
      }
      const action = approved ? "wage.adjustment.approve" : "wage.adjustment.reject";
      const eventId = await this.events.append(client, { ...actor, authorizationCapability: "wage:adjustment_approve" }, {
        action, entityType: "wage_adjustment", entityId: adjustmentId,
        before: this.adjustmentDto(adjustment), after: { status: approved ? "approved" : "rejected" },
        ...(reason ? { reason } : {}),
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_wage_adjustments SET status=$2,decided_by=$3,
          decided_at=CURRENT_TIMESTAMP,decision_reason=$4,
          decision_operation_event_id=$5,decision_operation_request_id=$6,
          version=version+1 WHERE adjustment_id=$1`,
        [adjustmentId, approved ? "approved" : "rejected", actor.actorId, reason, eventId, actor.requestId],
      );
      if (approved) {
        await client.query(
          `UPDATE rework_wage_periods SET
             adjustment_total=(SELECT COALESCE(sum(adjustment_amount),0)
               FROM rework_wage_adjustments WHERE target_period_id=$1 AND status='approved'),
             final_total=original_total+(SELECT COALESCE(sum(adjustment_amount),0)
               FROM rework_wage_adjustments WHERE target_period_id=$1 AND status='approved'),
             status='pending_tail_review',period_version=period_version+1,
             updated_at=CURRENT_TIMESTAMP WHERE period_id=$1`, [target.period_id],
        );
      }
      return this.adjustmentDto(await this.adjustmentRow(client, adjustmentId, false));
    });
  }

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
      if (period.period_version !== expectedVersion || period.status !== "ready_to_lock") fail("工资期间尚未完成复核或版本冲突");
      const ended = await client.query<{ ended: boolean }>(
        `SELECT CURRENT_TIMESTAMP >= (($1::date+interval '1 month')::timestamp
          AT TIME ZONE 'Asia/Singapore') ended`, [period.period_month],
      );
      if (!first(ended.rows, "月份边界校验失败", 409).ended) fail("自然月结束前不能锁定", 409, "INVALID_STATE_TRANSITION");
      if ((await client.query(`SELECT 1 FROM rework_wage_adjustments WHERE target_period_id=$1 AND status='pending' LIMIT 1`, [periodId])).rowCount) fail("仍有待处理工资调整，不能锁定");
      const eventId = await this.events.append(client, { ...actor, authorizationCapability: "wage:month_close" }, {
        action: "wage.month_close", entityType: "wage_period", entityId: periodId,
        before: this.periodAudit(period), after: { ...this.periodAudit(period), status: "locked" },
        ...(note ? { reason: note } : {}),
      });
      await this.context(client, eventId, actor.requestId);
      const closureId = randomUUID();
      await client.query(
        `INSERT INTO rework_wage_month_closures(
           closure_id,period_id,period_version_snapshot,item_count,person_count,
           original_total,adjustment_total,final_total,locked_by,locked_at,
           lock_note,operation_event_id,operation_request_id
         ) VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,
           CURRENT_TIMESTAMP,$10,$11,$12)`,
        [closureId, periodId, period.period_version, period.source_item_count, period.person_count, period.original_total, period.adjustment_total, period.final_total, actor.actorId, note, eventId, actor.requestId],
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
         FROM rework_wage_items WHERE period_id=$1`, [periodId, closureId],
      );
      await client.query(
        `INSERT INTO rework_wage_month_close_lines(
           closure_line_id,closure_id,line_type,wage_item_id,adjustment_id,
           person_id,person_name_snapshot,person_type_snapshot,rework_no_snapshot,
           style_no_snapshot,process_name_snapshot,quantity_snapshot,unit_snapshot,
           unit_price_snapshot,assignment_mode,member_snapshot,original_amount,
           adjustment_amount,final_amount)
         SELECT gen_random_uuid(),$2,'adjustment',NULL,adjustment.adjustment_id,
           adjustment.person_id,item.person_name_snapshot,item.person_type_snapshot,
           item.rework_no_snapshot,item.style_no_snapshot,item.process_name_snapshot,
           item.actual_quantity_snapshot,item.pricing_unit_snapshot,
           item.unit_price_snapshot,item.assignment_mode,item.member_snapshot,
           0,adjustment.adjustment_amount,adjustment.adjustment_amount
         FROM rework_wage_adjustments adjustment JOIN rework_wage_items item
           ON item.wage_item_id=adjustment.original_wage_item_id
         WHERE adjustment.target_period_id=$1 AND adjustment.status='approved'`, [periodId, closureId],
      );
      await client.query(`SET CONSTRAINTS wage_closure_complete_on_closure,wage_closure_complete_on_line IMMEDIATE`);
      await client.query(
        `UPDATE rework_wage_periods SET status='locked',locked_by=$2,
          locked_at=CURRENT_TIMESTAMP,lock_note=$3,locked_operation_event_id=$4,
          locked_request_id=$5,period_version=period_version+1,
          updated_at=CURRENT_TIMESTAMP WHERE period_id=$1`,
        [periodId, actor.actorId, note, eventId, actor.requestId],
      );
      return { closureId, periodId, status: "locked" as const, periodVersion: expectedVersion + 1 };
    });
  }

  private async requireView(actor: TrustedActorContext) {
    if (!actor.authorizationCapabilities?.includes("wage:view")) fail("缺少工资查看能力", 403, "FORBIDDEN");
    await this.db.query("SELECT access_authorized_actor_roles($1,'wage:view')", [actor.actorId]);
  }
  private async requireDirect(actor: TrustedActorContext, role: string, capability: string) {
    const result = await this.db.query<{ allowed: boolean }>("SELECT wage_has_direct_role($1,$2,$3) allowed", [actor.actorId, role, capability]);
    if (!first(result.rows, "工资权限校验失败", 403).allowed) fail("必须由直接有效业务角色执行", 403, "FORBIDDEN");
  }
  private async permissions(actor: TrustedActorContext, executor: Pool | PoolClient): Promise<Permissions> {
    const result = await executor.query<Permissions>(
      `SELECT wage_has_direct_role($1,'tail_supervisor','wage:tail_review') tail,
        wage_has_direct_role($1,'administrative_clerk','wage:administrative_review') administrative,
        wage_has_direct_role($1,'wage_month_close_accountant','wage:month_close') "monthClose",
        $2::boolean export`,
      [actor.actorId, actor.authorizationCapabilities?.includes("wage:export") ?? false],
    );
    return first(result.rows, "工资权限校验失败", 403);
  }
  private periodDto(row: PeriodRow, permission: Permissions): WagePeriod {
    return {
      periodId: row.period_id, periodMonth: row.period_month, timezone: row.timezone,
      status: row.status, periodVersion: row.period_version,
      sourceItemCount: row.source_item_count, personCount: row.person_count,
      originalTotal: row.original_total, adjustmentTotal: row.adjustment_total,
      finalTotal: row.final_total, lockedBy: row.locked_by, lockedAt: iso(row.locked_at),
      lockNote: row.lock_note,
      canTailReview: permission.tail && row.status === "pending_tail_review",
      canAdministrativeReview: permission.administrative && row.status === "pending_admin_review",
      canLock: permission.monthClose && row.status === "ready_to_lock",
      canRequestAdjustment: permission.tail,
      canApproveAdjustment: permission.administrative && row.status !== "locked",
      canExport: permission.export,
    };
  }
  private itemDto(row: ItemRow): WageItem {
    return {
      wageItemId: row.wage_item_id, periodId: row.period_id,
      orderReviewId: row.order_review_id, reworkOrderId: row.rework_order_id,
      configurationItemId: row.configuration_item_id, workTaskId: row.work_task_id,
      workReportId: row.work_report_id, personId: row.person_id,
      personNameSnapshot: row.person_name_snapshot,
      personTypeSnapshot: row.person_type_snapshot,
      reworkNoSnapshot: row.rework_no_snapshot, styleNoSnapshot: row.style_no_snapshot,
      processNameSnapshot: row.process_name_snapshot,
      pricingUnitSnapshot: row.pricing_unit_snapshot,
      unitPriceSnapshot: row.unit_price_snapshot,
      actualQuantitySnapshot: row.actual_quantity_snapshot,
      assignmentMode: row.assignment_mode, groupAmount: row.group_amount,
      exactPersonShare: row.exact_person_share, payableAmount: row.payable_amount,
      fractionalRemainder: row.fractional_remainder,
      remainderRank: row.remainder_rank, memberCount: row.member_count,
      memberSnapshot: row.member_snapshot,
    };
  }
  private adjustmentDto(row: AdjustmentRow): WageAdjustment {
    return {
      adjustmentId: row.adjustment_id,
      originalWageItemId: row.original_wage_item_id,
      targetPeriodId: row.target_period_id, personId: row.person_id,
      adjustmentAmount: row.adjustment_amount, reason: row.reason,
      attachmentIds: row.attachment_ids, status: row.status,
      requestedBy: row.requested_by, requestedAt: row.requested_at.toISOString(),
      decidedBy: row.decided_by, decidedAt: iso(row.decided_at),
      decisionReason: row.decision_reason, version: row.version,
    };
  }
  private itemSelect() {
    return `SELECT wage_item_id,period_id,order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      person_name_snapshot,person_type_snapshot,rework_no_snapshot,
      style_no_snapshot,process_name_snapshot,pricing_unit_snapshot,
      unit_price_snapshot::text,actual_quantity_snapshot::text,assignment_mode,
      group_amount::text,exact_person_share::text,payable_amount::text,
      fractional_remainder::text,remainder_rank,member_count,member_snapshot
      FROM rework_wage_items`;
  }
  private adjustmentSelect() {
    return `SELECT adjustment_id,original_wage_item_id,target_period_id,
      target_period_version_snapshot,person_id,adjustment_amount::text,reason,
      attachment_ids,status,requested_by,requested_at,decided_by,decided_at,
      decision_reason,version FROM rework_wage_adjustments`;
  }
  private async period(client: PoolClient, periodId: string): Promise<PeriodRow> {
    const result = await client.query<PeriodRow>(
      `SELECT period_id,period_month::text,timezone,status,period_version,
        source_item_count,person_count,original_total::text,adjustment_total::text,
        final_total::text,locked_by,locked_at,lock_note
       FROM rework_wage_periods WHERE period_id=$1 FOR UPDATE`, [periodId],
    );
    return first(result.rows, "工资期间不存在");
  }
  private async adjustmentRow(client: PoolClient, id: string, lock: boolean): Promise<AdjustmentRow> {
    const result = await client.query<AdjustmentRow>(`${this.adjustmentSelect()} WHERE adjustment_id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
    return first(result.rows, "工资调整不存在");
  }
  private async context(client: PoolClient, eventId: string, requestId: string) {
    await client.query(
      `SELECT set_config('dx_rework.wage_event_id',$1,true),
        set_config('dx_rework.wage_request_id',$2,true)`, [eventId, requestId],
    );
  }
  private periodAudit(row: PeriodRow): Record<string, unknown> {
    return { periodId: row.period_id, periodMonth: row.period_month,
      status: row.status, periodVersion: row.period_version,
      sourceItemCount: row.source_item_count, personCount: row.person_count,
      originalTotal: row.original_total, adjustmentTotal: row.adjustment_total,
      finalTotal: row.final_total };
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
      const result = await this.idem.execute(client, {
        scope, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode, response: await work(client) }));
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
