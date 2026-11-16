import type {ScheduleOccurrence} from '@dx-rework/contracts';

export type PackingReadinessScope='whole_po'|'receipt_allocation';
export type PackingReadinessCondition={reference:string;complete:boolean;occurred:ScheduleOccurrence};
export type PackingScopeReadinessInput={
 scope:PackingReadinessScope;scopeRef:string;observedAt:string;
 expectedQuantity:number|null;receivedQuantity:number|null;qualifiedQuantity:number|null;
 conditions:readonly PackingReadinessCondition[];
};
export type PackingScopeReadiness={scope:PackingReadinessScope;scopeRef:string;ready:ScheduleOccurrence;
 state:'ready'|'not_ready'|'unknown';evidenceRefs:string[];reason:string|null};
const unknown={precision:'unknown'} as const;
const quantity=(value:number|null):value is number=>value!==null&&Number.isSafeInteger(value)&&value>=0;

/** The producer must bind the exact native scope and sanitize unverified times.
 * A whole-PO convergence is explicitly different from a receipt allocation;
 * neither cumulative packing nor a later edit proves individual batch starts. */
export function packingScopeReadiness(input:PackingScopeReadinessInput):PackingScopeReadiness{
 const evidenceRefs=[...new Set(input.conditions.map(c=>c.reference))];
 const result=(state:PackingScopeReadiness['state'],reason:string|null,ready:ScheduleOccurrence=unknown):PackingScopeReadiness=>
  ({scope:input.scope,scopeRef:input.scopeRef,ready,state,evidenceRefs,reason});
 if(!input.scopeRef||!quantity(input.expectedQuantity)||input.expectedQuantity===0
  ||!quantity(input.receivedQuantity)||!quantity(input.qualifiedQuantity)
  ||input.qualifiedQuantity>input.receivedQuantity)return result('unknown','原应交范围或有效收货／合格覆盖待核');
 if(input.receivedQuantity>input.expectedQuantity)return result('unknown','超出应交范围，需明确实际装箱对应批次');
 if(input.receivedQuantity<input.expectedQuantity||input.qualifiedQuantity<input.expectedQuantity)
  return result('not_ready','本范围有效收货或合格数量尚未齐');
 if(!input.conditions.length||input.conditions.some(c=>!c.reference))return result('unknown','原可装作业条件依据待核');
 if(input.conditions.some(c=>!c.complete))return result('not_ready','本范围仍有未完成的必要作业条件');
 const instants=input.conditions.map(c=>c.occurred.precision==='instant'?Date.parse(c.occurred.at):NaN);
 if(!Number.isFinite(Date.parse(input.observedAt))||instants.some(t=>!Number.isFinite(t)||t>Date.parse(input.observedAt)))return result('unknown','必要作业条件尚无完整可信时刻，不推定责任起点');
 return result('ready',null,{precision:'instant',at:new Date(Math.max(...instants)).toISOString()});
}
