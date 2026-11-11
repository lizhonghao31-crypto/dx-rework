import {z} from 'zod';

/** Choice order is explicit source material, not an inferred combined step. */
export const CraftStepChoicesSchema=z.array(z.object({craftKind:z.enum(['embroidery','printing']),sequence:z.number().int().min(1).max(2)}).strict()).max(2).superRefine((steps,ctx)=>{
 if(new Set(steps.map(step=>step.craftKind)).size!==steps.length)ctx.addIssue({code:'custom',message:'同一工艺只能选择一次'});
 if(steps.some((step,index)=>step.sequence!==index+1))ctx.addIssue({code:'custom',message:'请按实际先后顺序排列工艺'});
});
export type CraftStepChoice=z.infer<typeof CraftStepChoicesSchema>[number];
/** A declared later production route; unknown is distinct from no craft. */
export const ProductionRoutePlanSchema=z.object({craftSteps:CraftStepChoicesSchema.nullable(),preshrink:z.boolean().nullable()}).strict();
export const craftChoiceLabel=(steps:readonly CraftStepChoice[])=>steps.map(step=>step.craftKind==='embroidery'?'绣花':'印花').join(' → ')||'无';
/** Compatibility text only; native v2 tasks always use their own stepRef. */
export const craftLegacyLabel=(steps:readonly CraftStepChoice[]):'无'|'印花'|'绣花'|'印绣花'=>steps.length===2?'印绣花':steps[0]?.craftKind==='embroidery'?'绣花':steps[0]?.craftKind==='printing'?'印花':'无';
export type AdoptedCraftStep=CraftStepChoice&{
 stepId:string;scopeRef:string;canonicalWorkRef:string;
 planningParameterRef:string|null;planningMinutes:number|null;responsibilitySlaRef:string|null;responsibilityMinutes:number|null;responsibilityCalendar:string|null;calendarRef:string|null;adoptedVersion:string;
};
