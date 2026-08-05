import type { ReportQuery, ReportType } from "@dx-rework/contracts/reporting";

import { type Queryable, type Range, type ReportData, fail } from "./management-reporting-shared.js";
import { factDto } from "./management-reporting-dto.js";
import { fetchFacts } from "./management-reporting-orders.js";
import { wageReport } from "./management-reporting-report-wages.js";
import { responsibilityReport, ownFactoryReport, externalReport } from "./management-reporting-report-responsibility.js";
import { exceptionReport, totals } from "./management-reporting-report-exceptions.js";

export async function reportData(source: Queryable, reportType: ReportType, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
  switch (reportType) {
    case "rework_overview": return reworkReport(source, query, limit);
    case "wages": return wageReport(source, query, range, limit);
    case "responsibilities": return responsibilityReport(source, query, range, limit);
    case "own_factory": return ownFactoryReport(source, query, range, limit);
    case "external_deductions": return externalReport(source, query, range, limit);
    case "exceptions": return exceptionReport(source, query, range, limit);
    default: return fail("不支持的报表类型", 400, "VALIDATION_ERROR");
  }
}

export async function reworkReport(source: Queryable, query: ReportQuery, limit: number): Promise<ReportData> {
  const facts = await fetchFacts(source, {
    ...(query.q ? { q: query.q } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    limit,
  });
  const rows = facts.rows.map((row) => {
    const dto = factDto(row);
    return {
      reworkOrderId: dto.reworkOrderId,reworkNo: dto.reworkNo,styleNo: dto.styleNo,orderNo: dto.orderNo,
      status: dto.status,node: dto.nodeLabel,nodeEnteredAt: dto.nodeEnteredAt,agingSeconds: dto.agingSeconds,
      wageAmount: dto.wageAmount,responsibilityAmount: dto.responsibilityAmount,ownFactoryAmount: dto.ownFactoryAmount,
      externalProposedAmount: dto.externalProposedAmount,externalDeductedAmount: dto.externalDeductedAmount,
      externalRemainingAmount: dto.externalRemainingAmount,overdue: dto.overdue,exceptionCount: dto.exceptionCount,
    };
  });
  return { columns: [
    {key:"reworkNo",label:"返工单号"},{key:"styleNo",label:"款号"},{key:"orderNo",label:"订单号"},
    {key:"status",label:"状态"},{key:"node",label:"当前节点"},{key:"nodeEnteredAt",label:"节点进入时间"},
    {key:"wageAmount",label:"工资金额"},{key:"responsibilityAmount",label:"责任金额"},
    {key:"ownFactoryAmount",label:"本厂承担"},{key:"externalProposedAmount",label:"外部拟扣"},
    {key:"externalDeductedAmount",label:"累计实扣"},{key:"externalRemainingAmount",label:"未扣差额"},
    {key:"overdue",label:"是否逾期"},{key:"exceptionCount",label:"异常数"},
  ], rows, totals: totals(rows,["wageAmount","responsibilityAmount","ownFactoryAmount","externalProposedAmount","externalDeductedAmount","externalRemainingAmount"]) };
}

