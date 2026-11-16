import {BulkWashingAdoptionSchema,type BulkWashingMode} from '@dx-rework/contracts/bulk-washing';
import type {OrderTimeCheckResult,OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';

const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function changedFields(base:unknown,draft:unknown,current:unknown):unknown{
 if(equal(base,draft))return structuredClone(current);
 if(object(base)&&object(draft)&&object(current)&&base.mode===draft.mode&&base.mode===current.mode){
  return Object.fromEntries([...new Set([...Object.keys(current),...Object.keys(draft)])].map(key=>[key,changedFields(base[key],draft[key],current[key])]));
 }
 return structuredClone(draft);
}

/** Only after explicit conflict acknowledgement. Preserve deliberate edits,
 * adopt the fresh native version and keep read-only fee provenance current. */
export function rebaseWashingChanges(base:OrderTimeCheckResult['washing'],changes:OrderTimeWashingChanges,current:OrderTimeCheckResult['washing']):OrderTimeWashingChanges{
 return changes.map(change=>{
  const before=base?.find(row=>row.lineId===change.lineId),fresh=current?.find(row=>row.lineId===change.lineId);
  if(!fresh)throw new Error('原洗水PO范围已变化，请核对后重新填写');
  const document=changedFields(before?.document,change.document,fresh.document);
  if(!object(document)||!object(document.arrangement))throw new Error('原洗水安排已变化，请核对后重新填写');
  if(document.arrangement.mode!=='none')document.arrangement.revision=fresh.version+1;
  document.fee=structuredClone(fresh.document?.fee??{kind:'pending'});
  return {lineId:change.lineId,expectedVersion:fresh.version,document:BulkWashingAdoptionSchema.parse(document)};
 });
}

export type WashingEditorDraft={mode:BulkWashingMode;accounting:'additional'|'included_in_factory';washing:string;inspection:string;calendar:string;inspectionCalendar:string;logisticsId:string;inspectorId:string};
type WashingRow=NonNullable<OrderTimeCheckResult['washing']>[number];
export function washingEditorDraft(row:WashingRow):WashingEditorDraft{
 const a=row.document?.arrangement;
 return {mode:a?.mode??'none',accounting:a&&a.mode!=='none'?a.accounting:'additional',washing:a&&a.mode!=='none'?String(a.washing.minutes/60):'',inspection:a&&a.mode!=='none'?String(a.inspection.minutes/60):'',calendar:a&&a.mode!=='none'?a.washing.calendar:'continuous',inspectionCalendar:a&&a.mode!=='none'?a.inspection.calendar:'continuous',logisticsId:row.document?.staff?.logisticsId??'',inspectorId:row.document?.staff?.inspectorId??''};
}
/** Apply the same three-way baseline to visible raw editor fields. Invalid
 * text is a deliberate unsaved edit too; acknowledgement must not erase it. */
export function rebaseWashingEditorDrafts(base:readonly WashingRow[],drafts:Record<string,WashingEditorDraft>,current:readonly WashingRow[]):Record<string,WashingEditorDraft>{
 return Object.fromEntries(Object.entries(drafts).map(([lineId,draft])=>{
  const old=base.find(row=>row.lineId===lineId),fresh=current.find(row=>row.lineId===lineId);if(!old||!fresh)return [lineId,draft];
  const before=washingEditorDraft(old),next=washingEditorDraft(fresh),keepArrangement=before.mode!==draft.mode||before.mode!==next.mode;
  const merged=Object.fromEntries(Object.entries(draft).map(([key,value])=>{
   const field=key as keyof WashingEditorDraft,original=before[field],unchanged=(field==='washing'||field==='inspection')&&value.trim()&&original.trim()&&Number.isFinite(Number(value))&&Number.isFinite(Number(original))?Number(value)===Number(original):value===original;
   return [key,keepArrangement&&!['logisticsId','inspectorId'].includes(key)||!unchanged?value:next[field]];
  })) as WashingEditorDraft;
  return [lineId,merged];
 }));
}
