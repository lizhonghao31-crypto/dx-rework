import { z } from "zod";

/** Current registered promises; completion continues to use original whole-order facts. */
export const PoDeliveryDateSchema = z.object({
  lineId:z.string().uuid(),position:z.number().int().positive(),poNumber:z.string().nullable(),color:z.string(),
  customerWarehouseArrivalDate:z.iso.date().nullable(),factoryDeliveryDate:z.iso.date().nullable(),sampleTargetDate:z.iso.date().nullable(),
}).strict();
export type PoDeliveryDate = z.infer<typeof PoDeliveryDateSchema>;
export const PoDeliveryRiskSchema=z.object({lineId:z.string().uuid(),poNumber:z.string().nullable(),color:z.string(),kind:z.enum(['factory','customer','sample']),date:z.iso.date(),risk:z.enum(['overdue','due_soon']),nodeKey:z.string()}).strict();
export type PoDeliveryRisk = z.infer<typeof PoDeliveryRiskSchema>;
export function poDateSummary(values:readonly (string|null)[]):string {
  const registered=[...new Set(values.filter((value):value is string=>Boolean(value)))].sort(),missing=values.filter(value=>!value).length;
  const dates=registered.length>1?`${registered[0]} ～ ${registered.at(-1)}（多交期）`:registered[0]??"";
  const absent=missing?`有 PO 日期待补（${missing}/${values.length}）`:"";
  return [dates,absent].filter(Boolean).join(" · ")||"未登记";
}
export function earliestFactoryPo(lines:readonly PoDeliveryDate[]) {
  const date=lines.map(line=>line.factoryDeliveryDate).filter((value):value is string=>Boolean(value)).sort()[0];
  return date?{date,lines:lines.filter(line=>line.factoryDeliveryDate===date)}:null;
}
/** Business-date reminders are separate from node SLA and historical results. */
export function poDeliveryRisks(lines:readonly PoDeliveryDate[],today:string,options:{finished:boolean;factoryFinished:boolean;sampleFinished:boolean}):PoDeliveryRisk[] {
  if(options.finished)return [];
  const result:PoDeliveryRisk[]=[];
  const add=(line:PoDeliveryDate,kind:PoDeliveryRisk["kind"],date:string|null,nodeKey:string)=>{
    if(date&&date<=today)result.push({lineId:line.lineId,poNumber:line.poNumber,color:line.color,kind,date,nodeKey,risk:date<today?"overdue":"due_soon"});
  };
  if(!options.factoryFinished)for(const line of earliestFactoryPo(lines)?.lines??[])add(line,"factory",line.factoryDeliveryDate,"production_reporting");
  for(const line of lines){add(line,"customer",line.customerWarehouseArrivalDate,"packing");if(!options.sampleFinished)add(line,"sample",line.sampleTargetDate,"bulk_ship_sample");}
  return result;
}
