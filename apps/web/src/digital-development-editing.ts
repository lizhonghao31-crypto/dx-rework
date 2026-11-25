import { DEVELOPMENT_MEASUREMENTS, type DevelopmentAlternateSizeDraft, type DevelopmentDocument, type DevelopmentMaterial } from "@dx-rework/contracts/digital-development";
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
  return {quotationMode:'automatic_v1',documentFormatVersion:2,template,quantity:null,orderDate:null,returnDate:null,...defaultDevelopmentSizeTable(template),interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",washingMethod:"",ironing:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[material("主布","主布 A"),material("配布","配布 B"),material("配布","配布 C")],files:[]};
}
export function editableDevelopmentDocument(document:DevelopmentDocument):DevelopmentDocument{
  return {...document,documentFormatVersion:2,sizeQuantities:document.sizeQuantities??document.sizes.map(()=>null)};
}
type DevelopmentSizeTable = Pick<DevelopmentAlternateSizeDraft, "unit" | "sizes" | "measurements" | "sampleSize" | "sizeQuantities">;
function emptyDevelopmentSizeTable():DevelopmentSizeTable {
  return {unit:"cm",sizes:[],measurements:[],sampleSize:"",sizeQuantities:[]};
}
export function defaultDevelopmentSizeTable(template:DevelopmentDocument["template"]):DevelopmentSizeTable {
  return {...emptyDevelopmentSizeTable(),measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:[]}))};
}
export type DevelopmentCreationChoices={template:DevelopmentDocument["template"];rush:boolean};
/** New guided forms have chosen identity but an unopened size editor. */
export function initialGuidedDevelopmentDocument(choices:DevelopmentCreationChoices):DevelopmentDocument {
  return {...initialDevelopmentDocument(choices.template),...emptyDevelopmentSizeTable(),templateConfirmed:true,rush:choices.rush};
}
export function initializeGuidedDevelopmentSizes(document:DevelopmentDocument):DevelopmentDocument {
  if(!document.templateConfirmed||document.sizeTableInitialized)return document;
  // Protect saved inputs from older producers that marked the garment, but not initialization.
  const alreadySaved=Boolean(document.sizes.length||document.measurements.length||document.sampleSize||document.unit!=="cm");
  return {...document,...(alreadySaved?{}:defaultDevelopmentSizeTable(document.template)),sizeTableInitialized:true};
}
function creationSizeSnapshot(document:DevelopmentDocument,rawQuantities:string[]):DevelopmentAlternateSizeDraft {
  return {template:document.template,unit:document.unit,sizes:document.sizes,measurements:document.measurements,
    sampleSize:document.sampleSize,sizeQuantities:document.sizeQuantities??document.sizes.map(()=>null),rawQuantities};
}
export function hasCustomizedDevelopmentSizes(document:DevelopmentDocument,rawQuantities:string[]):boolean {
  if(!document.templateConfirmed)return true; // Preserve all legacy input, even an empty matrix.
  if(!document.sizeTableInitialized)return false;
  const {template,rawQuantities:inputs,...sizes}=creationSizeSnapshot(document,rawQuantities);
  return inputs.some(Boolean)||!sameDevelopmentFields(sizes,defaultDevelopmentSizeTable(template));
}
export function changeDevelopmentCreationGarment(document:DevelopmentDocument,template:DevelopmentDocument["template"],rawQuantities:string[]){
  if(!document.templateConfirmed)
    return {document:{...document,template,templateConfirmed:true as const,sizeTableInitialized:true as const},rawQuantities};
  if(document.template===template)return {document,rawQuantities};
  const prior=document.alternateSizeDraft,rest={...document};
  delete rest.alternateSizeDraft;
  delete rest.sizeTableInitialized;
  const alternateSizeDraft=document.sizeTableInitialized?creationSizeSnapshot(document,rawQuantities):undefined;
  const alternate=alternateSizeDraft?{alternateSizeDraft}:{};
  if(prior?.template!==template)
    return {document:{...rest,...alternate,...emptyDevelopmentSizeTable(),template},rawQuantities:[]};
  const {rawQuantities:restored,...table}=prior;
  return {document:{...rest,...alternate,...table,sizeTableInitialized:true as const},rawQuantities:restored};
}
export function attachDevelopmentCraftFile(document:DevelopmentDocument,stepKey:string,attachmentId:string){
  const existing=document.craftRequirements??[];
  const row=existing.find(item=>item.stepKey===stepKey);
  if(row?.attachmentIds.includes(attachmentId))return existing;
  if(row)return existing.map(item=>item===row?{...row,attachmentIds:[...row.attachmentIds,attachmentId]}:item);
  return [...existing,{stepKey,part:"",specification:"",instructions:"",attachmentIds:[attachmentId]}];
}
export function developmentAttachmentReferences(document:DevelopmentDocument,attachmentId:string){
  return {
    linked:document.materials.some(row=>row.sampleAttachmentId===attachmentId)
      ||Boolean(document.craftRequirements?.some(row=>row.attachmentIds.includes(attachmentId))),
    withoutFile:{
      files:document.files.filter(file=>file.attachmentId!==attachmentId),
      materials:document.materials.map(row=>row.sampleAttachmentId===attachmentId?{...row,sampleAttachmentId:null}:row),
      ...(document.craftRequirements?{craftRequirements:document.craftRequirements.map(row=>({
        ...row,attachmentIds:row.attachmentIds.filter(id=>id!==attachmentId),
      }))}:{}),
    },
  };
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
const sameDevelopmentFields=(before:unknown,after:unknown)=>JSON.stringify(canonicalDevelopmentDocument(before))===JSON.stringify(canonicalDevelopmentDocument(after));
const canonicalDevelopmentSaveFields=(document:DevelopmentDocument|null)=>{
 if(!document)return null;
 // Catalog activation and computed line totals are canonical server output,
 // not user input. Keep supplier identity, material values, and ordering exact.
 const fields={...document,materials:document.materials.map(row=>{const inputs={...row};delete inputs.lineTotal;return inputs;})};
 delete fields.materialSupplierCatalog;
 return fields;
};
export const sameDevelopmentDocument=(before:DevelopmentDocument|null,after:DevelopmentDocument)=>sameDevelopmentFields(canonicalDevelopmentSaveFields(before),canonicalDevelopmentSaveFields(after));
