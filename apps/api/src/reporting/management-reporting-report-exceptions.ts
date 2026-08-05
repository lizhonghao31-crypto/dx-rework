import type { ReportQuery } from "@dx-rework/contracts/reporting";

import { type Queryable, type Range, type ReportRow, type ReportData } from "./management-reporting-shared.js";
import { exceptions } from "./management-reporting-exceptions.js";

export async function exceptionReport(source: Queryable, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
  const rows=(await exceptions(limit,source,{
    from:range.from,to:range.to,
    ...(query.q?{q:query.q}:{}),
    ...(query.status?{status:query.status}:{}),
  })).map((item)=>({exceptionType:item.exceptionType,entityId:item.entityId,reworkOrderId:item.reworkOrderId,label:item.label,occurredAt:item.occurredAt,deepLink:item.deepLink}));
  return {columns:[{key:"exceptionType",label:"异常类型"},{key:"label",label:"异常说明"},{key:"reworkOrderId",label:"返工单ID"},{key:"occurredAt",label:"发生/到期时间"},{key:"deepLink",label:"下钻地址"}],rows,totals:{exceptionCount:String(rows.length)}};
}

export function recalculateDisplayedTotals(rows: ReportRow[], original: Record<string, string>): Record<string, string> {
  const moneyKeys = Object.keys(original).filter((key) => rows.some((row) => typeof row[key] === "string" && /^-?\d+\.\d{2}$/.test(String(row[key]))));
  if (moneyKeys.length === 0) return { ...original, ...(Object.hasOwn(original, "exceptionCount") ? { exceptionCount: String(rows.length) } : {}) };
  return totals(rows, moneyKeys);
}

export function totals(rows: ReportRow[], keys: string[]): Record<string,string> {
  const result:Record<string,string>={};
  for(const key of keys){
    let cents=0n;
    for(const row of rows){const value=row[key];if(typeof value!=="string"||!/^[-]?\d+\.\d{2}$/.test(value))continue;const negative=value.startsWith("-");const [whole,fraction]=(negative?value.slice(1):value).split(".");const amount=BigInt(whole??"0")*100n+BigInt(fraction??"0");cents+=negative?-amount:amount;}
    const absolute=cents<0n?-cents:cents;result[key]=`${cents<0n?"-":""}${absolute/100n}.${(absolute%100n).toString().padStart(2,"0")}`;
  }
  return result;
}
