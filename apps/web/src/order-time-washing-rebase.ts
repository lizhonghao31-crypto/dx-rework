import {BulkWashingAdoptionSchema} from '@dx-rework/contracts/bulk-washing';
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
