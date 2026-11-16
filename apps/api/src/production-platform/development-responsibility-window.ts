/** A captured quota is immutable; an untrusted clock is not a trusted occurrence.
 * Read current event truth separately from the original policy/deadline history. */
export type ResponsibilityTask={task_id:string;entered_at:Date|string|null;entered_quality?:string;completed_at?:Date|string|null;completed_quality?:string;state?:string;returned?:boolean;rejected?:boolean;ready_correction?:ReadyCorrection|null;native_readiness?:{at:string|null;quality:string;eventId:string;reference:string}|null};
type Basis={enteredAt?:string|null;timeQuality?:string;basis?:string[];[key:string]:unknown};
export type ReadyCorrection={at:string|null;eventId:string};
const iso=(at:Date|string|null|undefined)=>at==null?null:new Date(at).toISOString();
const credible=(quality:string|undefined)=>quality==='现场登记'||quality==='已核实';
export function developmentResponsibilityWindow(task:ResponsibilityTask,capturedAt:Date|string|null,basis:Basis|null,proof:readonly ResponsibilityTask[]=[],correction?:ReadyCorrection|null):{at:string|null;quality:string}{
 correction??=task.ready_correction;
 if(correction)return {at:iso(correction.at),quality:correction.at?'已核实':'缺失'};
 // Null is an explicit native result, not permission to revive a previous R.
 if(basis&&Object.hasOwn(basis,'enteredAt')&&basis.enteredAt===null)return {at:null,quality:'缺失'};

 const native=task.native_readiness;
 if(native?.at&&credible(native.quality)&&Array.isArray(basis?.basis)&&basis.basis.includes(native.reference)&&(native.reference===`readiness:${native.eventId}`||native.reference.startsWith('craft-step:'))&&iso(native.at)===iso(capturedAt))return {at:iso(native.at),quality:native.quality};
 // Older derived starts may precede assignment. Verify their own captured
 // predecessor references instead of requiring an unrelated physical handover.
 const refs=Array.isArray(basis?.basis)?basis.basis.filter((ref):ref is string=>typeof ref==='string'&&/^task:[^:]+:completed$/.test(ref)):[];
 if(refs.length){if(capturedAt&&refs.every(ref=>proof.some(row=>ref===`task:${row.task_id}:completed`&&row.state==='completed'&&!row.returned&&!row.rejected&&row.completed_at&&credible(row.completed_quality)&&Date.parse(iso(row.completed_at)!)<=Date.parse(iso(capturedAt)!))))return {at:iso(capturedAt),quality:'现场登记'};return {at:null,quality:'缺失'};}
 if(basis?.timeQuality!==undefined&&!credible(basis.timeQuality))return {at:null,quality:basis.timeQuality};
 if(credible(task.entered_quality))return {at:iso(capturedAt??task.entered_at),quality:task.entered_quality!};
 // Pre-quality legacy fixtures/records retain their original metadata; an
 // explicitly missing or unverified event cannot use that compatibility path.
 if(task.entered_quality===undefined)return {at:iso(capturedAt),quality:capturedAt?'现场登记':'缺失'};
 return {at:null,quality:task.entered_quality};
}
/** Used inside already-authorized task queries; no new per-task SQL round trip. */
export function developmentResponsibilityProofSql(taskAlias:string,basis:string):string{return `coalesce((SELECT jsonb_agg(jsonb_build_object('task_id',proof.task_id,'state',proof.state,'completed_at',proof.completed_at,'completed_quality',proof.completed_quality,'returned',EXISTS(SELECT 1 FROM digital_production_task_events returned WHERE returned.task_id=proof.task_id AND returned.event_kind='material_returned'),'rejected',false)) FROM digital_production_tasks proof JOIN digital_production_task_access proof_access USING(task_id) WHERE proof_access.source_id=${taskAlias}.source_id AND ('task:'||proof.task_id::text||':completed') IN (SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${basis}->'basis')='array' THEN ${basis}->'basis' ELSE '[]'::jsonb END))), '[]'::jsonb)`;}

export function developmentReadyCorrectionSql(taskId:string):string{return `(SELECT jsonb_build_object('at',e.occurred_at,'eventId',e.event_id) FROM digital_production_task_events e JOIN digital_production_task_events original ON original.event_id=e.corrects_event_id AND original.task_id=e.task_id AND original.event_kind='ready' AND coalesce(original.payload->'nativeReadiness'->>'scopeKind','task')='task' WHERE e.task_id=${taskId} AND e.event_kind='time_corrected' AND e.payload->>'originalKind'='ready' AND EXISTS(SELECT 1 FROM digital_production_tasks current_task WHERE current_task.task_id=e.task_id AND current_task.entered_at IS NOT DISTINCT FROM e.occurred_at AND current_task.entered_quality=e.time_quality) ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 1)`;}

/** A captured organizational R may precede task activation/handover. Only the
 * exact enrolled native event named by the captured basis can prove it. */
export function developmentNativeReadySql(taskId:string,basis:string):string{return `(SELECT jsonb_build_object('at',ready.occurred_at,'quality',ready.time_quality,'eventId',ready.event_id,'reference',captured.ref) FROM digital_production_task_events ready CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(${basis}->'basis')='array' THEN ${basis}->'basis' ELSE '[]'::jsonb END) captured(ref) WHERE ready.task_id=${taskId} AND ready.event_kind='ready' AND ready.payload->'nativeReadiness'->>'version'='1' AND coalesce(ready.payload->'nativeReadiness'->>'scopeKind','task')='task' AND (captured.ref='readiness:'||ready.event_id::text OR captured.ref LIKE 'craft-step:%' AND captured.ref IN (SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ready.payload->'nativeReadiness'->'basis')='array' THEN ready.payload->'nativeReadiness'->'basis' ELSE '[]'::jsonb END))) AND EXISTS(SELECT 1 FROM digital_production_task_events enrolled WHERE enrolled.task_id=ready.task_id AND enrolled.event_kind='created' AND enrolled.payload->>'readinessCaptureVersion'='1') ORDER BY ready.recorded_at,ready.event_id,captured.ref LIMIT 1)`;}
