import { DEVELOPMENT_MEASUREMENTS, type DevelopmentDocument, type DevelopmentMaterial } from "@dx-rework/contracts/digital-development";
import type { DigitalOrderInput, InitialCustomerOrderDraft } from "@dx-rework/contracts/digital-production";
import { createClientRequestId } from "./client-request-id.js";

export type DevelopmentOrderDraft = InitialCustomerOrderDraft;
export function editableDevelopmentOrder(order: DigitalOrderInput): DevelopmentOrderDraft {
  return {...order, lines: order.lines.map(line => ({...line, sizes: line.sizes.map(size => ({...size, quantity: String(size.quantity)}))}))};
}
export function developmentQuantityError(value: string): string | null {
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return "数量须为非负整数（件）";
  if (!Number.isSafeInteger(Number(value)) || Number(value) > 10000000) return "数量最多为10000000件";
  return null;
}
export function developmentQuantityTotal(sizes: DevelopmentOrderDraft["lines"][number]["sizes"]): number | null {
  return sizes.some(size => developmentQuantityError(size.quantity) !== null)
    ? null : sizes.reduce((total, size) => total + Number(size.quantity || 0), 0);
}
export function developmentOrderInput(draft: DevelopmentOrderDraft): DigitalOrderInput {
  return {...draft, lines: draft.lines.map((line, index) => {
    const sizes = line.sizes.map(size => {
      const error = developmentQuantityError(size.quantity);
      if (error) throw new Error(`PO ${index + 1} ${size.size || "尺码"}：${error}`);
      return {...size, quantity: Number(size.quantity || 0)};
    }).filter(size => size.quantity > 0);
    if (!sizes.length) throw new Error(`PO ${index + 1} 至少填写一项正整数订购数量`);
    return {...line, temporaryStyleNo: line.temporaryStyleNo ?? draft.temporaryStyleNo, sizes};
  })};
}
export function initialDevelopmentDocument(template: DevelopmentDocument["template"] = "上衣"): DevelopmentDocument {
  const material = (category: DevelopmentMaterial["category"], label: string): DevelopmentMaterial => ({materialId:createClientRequestId(),category,label,supplier:"",name:"",width:"",weight:"",composition:"",consumption:"",color:"",specification:"",quantity:"",requiredThisRound:false,available:false,expectedDate:null});
  return {documentFormatVersion:2,sizeQuantities:[],template,quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:[],measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:[]})),interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",washingMethod:"",ironing:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[material("主布","主布 A"),material("配布","配布 B"),material("配布","配布 C")],files:[]};
}
export function editableDevelopmentDocument(document:DevelopmentDocument):DevelopmentDocument{
  return {...document,documentFormatVersion:2,sizeQuantities:document.sizeQuantities??document.sizes.map(()=>null)};
}
export function developmentSizeQuantityInputs(document:DevelopmentDocument):string[]{return document.sizes.map((_,index)=>document.sizeQuantities?.[index]==null?"":String(document.sizeQuantities[index]));}
export function developmentMakingQuantityError(value:string):string|null{return value!==""&&(!/^\d+$/.test(value)||Number(value)>100000)?"制作数量须为0—100000整数，未确定时可留空":null;}
export function removeDevelopmentSize(document: DevelopmentDocument, index: number): DevelopmentDocument {
  return {...document, sizes: document.sizes.filter((_, position) => position !== index), ...(document.sizeQuantities?{sizeQuantities:document.sizeQuantities.filter((_,position)=>position!==index)}:{}), measurements: document.measurements.map(row => ({...row, values: row.values.filter((_, position) => position !== index)}))};
}
export function moveDevelopmentSize(document:DevelopmentDocument,from:number,to:number):DevelopmentDocument{
 const move=<T,>(values:T[]):T[]=>{const next=[...values];const item=next.splice(from,1)[0]!;next.splice(to,0,item);return next;};
 if(from<0||to<0||from>=document.sizes.length||to>=document.sizes.length)return document;
 return {...document,sizes:move(document.sizes),...(document.sizeQuantities?{sizeQuantities:move(document.sizeQuantities)}:{}),measurements:document.measurements.map(row=>({...row,values:move(row.values)}))};
}

/** JSONB may return object keys in a different order. Compare every document field; arrays retain their business order. */
const canonicalDevelopmentDocument=(value:unknown):unknown=>Array.isArray(value)?value.map(canonicalDevelopmentDocument):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalDevelopmentDocument(item)])):value;
export const sameDevelopmentDocument=(before:DevelopmentDocument|null,after:DevelopmentDocument)=>JSON.stringify(canonicalDevelopmentDocument(before))===JSON.stringify(canonicalDevelopmentDocument(after));
