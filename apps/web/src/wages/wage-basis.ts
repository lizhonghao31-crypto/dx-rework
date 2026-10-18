import type { ReportPreviewResponse } from "@dx-rework/contracts/reporting";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { businessValue } from "../business-display.js";

type Row = ReportPreviewResponse["rows"][number];
export const wageBasisFields = new Set(["unitPrice", "sourceAmount", "roundAmount", "actualHours", "temporaryWageMultiplier", "groupAmount", "exactPersonShare"]);
export function wageBasisValue(value: string | number | boolean | null | undefined): string {
  if(value == null) return "—";
  const text=String(value),digits=text.match(/\.(\d+)$/)?.[1].length ?? 0;
  return formatBusinessDecimal(text,Math.min(20,digits));
}
export function wageBasis(row: Row): string {
  const number=(key:string)=>wageBasisValue(row[key]);
  if(row.wageKind === "pattern_rework") return `本段 ${number("sourceAmount")} 元 / 整轮 ${number("roundAmount")} 元`;
  if(row.wageKind === "misc") return `${number("actualHours")} 小时 × ${number("unitPrice")} 元/小时`;
  const unit=businessValue("unit",row.unit);
  if(row.wageSource === "pattern_room") return `整轮 ${number("quantity")} ${unit} × ${number("unitPrice")} 元/${unit}；本段 ${number("sourceAmount")} 元`;
  const multiplier=row.personType === "temporary" ? row.temporaryWageMultiplier == null ? "；临时工系数历史未记录" : ` × 临时工系数 ${number("temporaryWageMultiplier")}` : "";
  if(row.assignmentMode === "collective") return `集体计薪：组总额 ${number("groupAmount")} 元，${number("memberCount")} 人；个人份额 ${number("exactPersonShare")} 元${row.personType === "temporary" ? `；临时工系数 ${number("temporaryWageMultiplier")}` : ""}；工资以已保存金额为准`;
  return `${number("quantity")} ${unit} × ${number("unitPrice")} 元/${unit}${multiplier}；工资以已保存金额为准`;
}
