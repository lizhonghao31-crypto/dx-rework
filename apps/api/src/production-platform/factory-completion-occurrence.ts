import {craftParameterKey} from './fixed-work-definition.js';
import type {AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
type Task={task_kind:string;route_instance_id:string};
type Window={kind:string;stepRef?:string|null;complete:boolean;completedAt:string|null};
type Factory={preparationId:string;craftKey:string|null;craftSteps?:readonly AdoptedCraftStep[];facts:Record<string,{businessCompleted?:boolean;batchCoverageComplete?:boolean}>;windows:readonly Window[]};
export type FactoryCompletion={kind:'not_applicable'}|{kind:'unknown'}|{kind:'known';at:string};
/** Completion comes from the exact physical scope. Generic task terminal time
 * is an audit fact and is never an input to this selector. */
export function factoryCompletionOccurrence(task:Task,factory:Factory|null,stepRef?:string|null):FactoryCompletion{
 if(!factory||task.route_instance_id!==factory.preparationId||!['process_logistics','bulk_qc','warehouse_dispatch'].includes(task.task_kind))return {kind:'not_applicable'};
 const fixed=Boolean(factory.craftSteps),scoped=fixed&&task.task_kind!=='warehouse_dispatch';
 const step=scoped?factory.craftSteps!.find(step=>step.stepId===stepRef):null;
 if(scoped&&!step)return {kind:'unknown'};
 const key=task.task_kind==='process_logistics'?step?`${craftParameterKey(step,'bulk')}:${step.stepId}`:factory.craftKey:task.task_kind;
 const fact=key?factory.facts[key]:null;
 // Fixed QC has one all-PO aggregate window per exact immutable step. Its
 // completeness is already checked by the original quantity/QC ledger.
 const scopedQc=scoped&&task.task_kind==='bulk_qc';
 if(!scopedQc&&(!fact?.businessCompleted||fact.batchCoverageComplete!==true))return {kind:'unknown'};
 const windows=factory.windows.filter(window=>window.kind===task.task_kind&&(!scoped||window.stepRef===step!.stepId));
 if(!windows.length||windows.some(window=>!window.complete||!window.completedAt||!Number.isFinite(Date.parse(window.completedAt))))return {kind:'unknown'};
 return {kind:'known',at:new Date(Math.max(...windows.map(window=>Date.parse(window.completedAt!)))).toISOString()};
}
