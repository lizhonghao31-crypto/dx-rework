import { businessCellValue, translateTechnicalDetails } from "@dx-rework/contracts/business-display";
import type { Pool } from "pg";

import { assertWageDataExportAllowed } from "../access/export-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { buildWorkbook, workbookNumberCell, type WorkbookCell } from "../reporting/xlsx-workbook.js";
import type { TrustedActorContext } from "../tools/repositories.js";

type Cell = WorkbookCell;
type PeriodRow = {
  period_month: string;
  status: string;
  original_total: string;
  locked_by: string | null;
  locked_at: Date | null;
};
type ExportLine = {
  period_month: string;
  person_id: string;
  person_name: string;
  person_type: string;
  supplier_name: string;
  rework_no: string;
  style_no: string;
  process_name: string;
  quantity: string;
  unit: string;
  unit_price: string;
  temporary_wage_multiplier: string;
  assignment_mode: string;
  member_count: number;
  member_snapshot: unknown;
  group_amount: string;
  exact_share: string;
  wage_amount: string;
};

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const first = <T>(rows: T[], message: string): T => {
  const value = rows[0];
  if (value === undefined) throw new ApplicationError("NOT_FOUND", message, 404);
  return value;
};
export function buildWageWorkbook(detailRows: Cell[][], summaryRows: Cell[][]): Buffer {
  return buildWorkbook([
    { name: "工资明细", rows: detailRows },
    { name: "人员汇总", rows: summaryRows },
  ]);
}

const cents = (value: string): bigint => {
  if (!/^-?\d+\.\d{2}$/.test(value)) fail("工资导出金额格式异常", 500, "INTERNAL_ERROR");
  const negative = value.startsWith("-");
  const parts = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(parts[0] ?? "0") * 100n + BigInt(parts[1] ?? "0");
  return negative ? -result : result;
};
const money = (value: bigint): string => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};

export class WageExportService {
  constructor(private readonly db: Pool) {}

  async export(actor: TrustedActorContext, periodId: string): Promise<{ filename: string; content: Buffer }> {
    assertWageDataExportAllowed(actor.actorRoles);
    const root = actor.actorRoles.includes("root_superuser");
    const currentCapabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (!root && !currentCapabilities.includes("wage:view")) fail("缺少工资查看能力", 403, "FORBIDDEN");
    if (!root && !currentCapabilities.includes("wage:export")) fail("缺少工资导出能力", 403, "FORBIDDEN");
    if (!root) await this.db.query("SELECT access_authorized_actor_roles($1,'wage:export')", [actor.actorId]);
    const periodResult = await this.db.query<PeriodRow>(
      `SELECT period_month::text,status,original_total::text,locked_by,locked_at
       FROM rework_wage_periods
       WHERE period_id=$1 AND (status='locked' OR source_item_count>0)`,
      [periodId],
    );
    const period = first(periodResult.rows, "工资期间不存在");
    const lines = period.status === "locked"
      ? await this.db.query<ExportLine>(
        `SELECT period.period_month::text,lines.person_id,
          lines.person_name_snapshot person_name,lines.person_type_snapshot person_type,
          CASE WHEN orders.processing_factory_type='own_factory' THEN '本厂'
               ELSE COALESCE(supplier.supplier_name,'供应商资料不可用') END supplier_name,
          lines.rework_no_snapshot rework_no,lines.style_no_snapshot style_no,
          lines.process_name_snapshot process_name,lines.quantity_snapshot::text quantity,
          lines.unit_snapshot unit,lines.unit_price_snapshot::text unit_price,
          COALESCE(coefficient.multiplier,'1.000') temporary_wage_multiplier,
          lines.assignment_mode,jsonb_array_length(lines.member_snapshot) member_count,
          lines.member_snapshot,COALESCE(item.group_amount,0)::text group_amount,
          COALESCE(item.exact_person_share,0)::text exact_share,
          lines.final_amount::text wage_amount
         FROM rework_wage_month_closures closure
         JOIN rework_wage_periods period ON period.period_id=closure.period_id
         JOIN rework_wage_month_close_lines lines ON lines.closure_id=closure.closure_id
         JOIN rework_wage_items item ON item.wage_item_id=lines.wage_item_id
         JOIN rework_orders orders ON orders.rework_order_id=item.rework_order_id
         LEFT JOIN current_supplier_catalog supplier
           ON supplier.supplier_id=orders.processing_factory_supplier_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(multiplier.multiplier,1)::numeric(8,3)::text multiplier
           FROM rework_tail_completion_confirmations confirmation
           LEFT JOIN rework_tail_completion_coefficients multiplier
             ON multiplier.confirmation_id=confirmation.confirmation_id
            AND multiplier.configuration_item_id=item.configuration_item_id
            AND multiplier.person_id=item.person_id
           WHERE confirmation.rework_order_id=item.rework_order_id
           ORDER BY confirmation.confirmed_at DESC,confirmation.confirmation_id DESC
           LIMIT 1
         ) coefficient ON true
         WHERE closure.period_id=$1 AND lines.line_type='wage_item'
         ORDER BY lines.person_name_snapshot,lines.closure_line_id`,
        [periodId],
      )
      : await this.db.query<ExportLine>(
        `SELECT period.period_month::text,item.person_id,
          item.person_name_snapshot person_name,item.person_type_snapshot person_type,
          CASE WHEN orders.processing_factory_type='own_factory' THEN '本厂'
               ELSE COALESCE(supplier.supplier_name,'供应商资料不可用') END supplier_name,
          item.rework_no_snapshot rework_no,item.style_no_snapshot style_no,
          item.process_name_snapshot process_name,item.actual_quantity_snapshot::text quantity,
          item.pricing_unit_snapshot unit,item.unit_price_snapshot::text unit_price,
          COALESCE(coefficient.multiplier,'1.000') temporary_wage_multiplier,
          item.assignment_mode,item.member_count,item.member_snapshot,
          item.group_amount::text group_amount,item.exact_person_share::text exact_share,
          item.payable_amount::text wage_amount
         FROM rework_wage_items item
         JOIN rework_wage_periods period ON period.period_id=item.period_id
         JOIN rework_orders orders ON orders.rework_order_id=item.rework_order_id
         LEFT JOIN current_supplier_catalog supplier
           ON supplier.supplier_id=orders.processing_factory_supplier_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(multiplier.multiplier,1)::numeric(8,3)::text multiplier
           FROM rework_tail_completion_confirmations confirmation
           LEFT JOIN rework_tail_completion_coefficients multiplier
             ON multiplier.confirmation_id=confirmation.confirmation_id
            AND multiplier.configuration_item_id=item.configuration_item_id
            AND multiplier.person_id=item.person_id
           WHERE confirmation.rework_order_id=item.rework_order_id
           ORDER BY confirmation.confirmed_at DESC,confirmation.confirmation_id DESC
           LIMIT 1
         ) coefficient ON true
         WHERE item.period_id=$1
           AND item.invalidated_at IS NULL
         ORDER BY item.person_name_snapshot,item.created_at,item.wage_item_id`,
        [periodId],
      );

    const detailRows: Cell[][] = [
      [period.status === "locked" ? "正式月结文件" : "未锁定预览"],
      ["工资月份","供应商","工人稳定ID","工人姓名快照","正式工/临时工","返工单号","款号","工序","数量/工时","单位","基础单价","临时工系数","个人/集体","集体成员人数","成员快照","组总额","高精度个人份额","工资金额","月结状态","锁定人","锁定时间"],
      ...lines.rows.map((line) => [
        line.period_month.slice(0, 7),line.supplier_name,line.person_id,line.person_name,
        businessCellValue("personType", line.person_type),
        line.rework_no,line.style_no,line.process_name,workbookNumberCell(line.quantity),
        businessCellValue("unit", line.unit),workbookNumberCell(line.unit_price),
        workbookNumberCell(line.temporary_wage_multiplier, "precise"),
        businessCellValue("assignmentMode", line.assignment_mode),line.member_count,
        JSON.stringify(translateTechnicalDetails(line.member_snapshot)),
        workbookNumberCell(line.group_amount),workbookNumberCell(line.exact_share, "precise"),
        workbookNumberCell(line.wage_amount),
        businessCellValue("periodStatus", period.status),period.locked_by,
        businessCellValue("lockedAt", period.locked_at?.toISOString() ?? ""),
      ]),
    ];
    const summaries = new Map<string, { name: string; type: string; total: bigint }>();
    let total = 0n;
    for (const line of lines.rows) {
      const entry = summaries.get(line.person_id) ?? { name: line.person_name, type: line.person_type, total: 0n };
      entry.total += cents(line.wage_amount);
      total += cents(line.wage_amount);
      summaries.set(line.person_id, entry);
    }
    if (money(total) !== period.original_total) fail("工资导出明细合计与期间总额不一致");
    const summaryRows: Cell[][] = [
      ["工资月份","工人稳定ID","工人姓名快照","人员类型","工资金额"],
      ...[...summaries.entries()]
        .sort((left, right) => left[1].name.localeCompare(right[1].name))
        .map(([id, value]) => [period.period_month.slice(0, 7),id,value.name,businessCellValue("personType", value.type),workbookNumberCell(money(value.total))]),
      ["合计","","","",workbookNumberCell(money(total))],
    ];
    const month = period.period_month.slice(0, 7);
    return {
      filename: period.status === "locked" ? `返工工资月结-${month}.xlsx` : `未锁定预览-返工工资-${month}.xlsx`,
      content: buildWageWorkbook(detailRows, summaryRows),
    };
  }
}
