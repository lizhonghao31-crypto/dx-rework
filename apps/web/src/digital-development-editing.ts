import { DEVELOPMENT_MEASUREMENTS, type DevelopmentDocument, type DevelopmentMaterial } from "@dx-rework/contracts/digital-development";
import type { DigitalOrderInput } from "@dx-rework/contracts/digital-production";
import { createClientRequestId } from "./client-request-id.js";

export type DevelopmentOrderDraft = Omit<DigitalOrderInput, "lines"> & {
  lines: Array<Omit<DigitalOrderInput["lines"][number], "sizes"> & { sizes: Array<{size: string; quantity: string}> }>;
};
export function editableDevelopmentOrder(order: DigitalOrderInput): DevelopmentOrderDraft {
  return {...order, lines: order.lines.map(line => ({...line, sizes: line.sizes.map(size => ({...size, quantity: String(size.quantity)}))}))};
}
export function developmentOrderInput(draft: DevelopmentOrderDraft): DigitalOrderInput {
  return {...draft, lines: draft.lines.map((line, index) => ({...line, temporaryStyleNo: line.temporaryStyleNo ?? draft.temporaryStyleNo,
    sizes: line.sizes.map(size => {
      if (!/^\d+$/.test(size.quantity) || Number(size.quantity) < 1 || Number(size.quantity) > 10000000) throw new Error(`PO ${index + 1} ${size.size || "尺码"}数量须为1—10000000整数`);
      return {...size, quantity: Number(size.quantity)};
    })}))};
}
export function initialDevelopmentDocument(template: DevelopmentDocument["template"] = "上衣"): DevelopmentDocument {
  const material = (category: DevelopmentMaterial["category"], label: string): DevelopmentMaterial => ({materialId:createClientRequestId(),category,label,supplier:"",name:"",width:"",weight:"",composition:"",consumption:"",color:"",specification:"",quantity:"",requiredThisRound:false,available:false,expectedDate:null});
  return {template,quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:["M","L"],measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:["",""]})),interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",washingMethod:"",ironing:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[material("主布","主布 A"),material("配布","配布 B"),material("配布","配布 C")],files:[]};
}
export function removeDevelopmentSize(document: DevelopmentDocument, index: number): DevelopmentDocument {
  return {...document, sizes: document.sizes.filter((_, position) => position !== index), measurements: document.measurements.map(row => ({...row, values: row.values.filter((_, position) => position !== index)}))};
}
