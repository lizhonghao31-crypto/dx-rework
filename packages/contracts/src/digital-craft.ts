import {z} from 'zod';
import {isSlaDurationMinutes} from './digital-sla.js';

/** Library standards are versioned separately from each order's frozen choice.
 * Missing values are allowed while maintaining the library, not when adopting
 * the applicable stage. Development and bulk never borrow each other's value. */
export const SpecialCraftStageSchema=z.object({
 minutes:z.number().refine(isSlaDurationMinutes,'请填写有效用时，最长365天').nullable(),
 calendar:z.enum(['continuous','natural_days','beijing_sunday_excluded']).nullable(),
 reminder:z.object({enabled:z.boolean(),percent:z.number().int().min(1).max(99)}).strict(),
}).strict();
export const SpecialCraftDefinitionSchema=z.object({
 name:z.string().trim().min(1).max(80),enabled:z.boolean(),
 development:SpecialCraftStageSchema,bulk:SpecialCraftStageSchema,
}).strict();
export type SpecialCraftDefinition=z.infer<typeof SpecialCraftDefinitionSchema>;
export const SpecialCraftSaveSchema=z.object({
 id:z.string().uuid().nullable(),expectedVersion:z.number().int().min(0),
 definition:SpecialCraftDefinitionSchema,
}).strict().superRefine((v,c)=>{
 if(v.id===null&&v.expectedVersion!==0||v.id!==null&&v.expectedVersion===0)c.addIssue({code:'custom',path:['expectedVersion'],message:'请核对工艺当前版本'});
});
export const SpecialCraftVersionSchema=z.object({id:z.string().uuid(),version:z.number().int().positive(),definition:SpecialCraftDefinitionSchema,recordedAt:z.string().datetime()}).strict();
export type SpecialCraftVersion=z.infer<typeof SpecialCraftVersionSchema>;
export type FrozenSpecialCraft={id:string;version:number;name:string;stage:'development'|'bulk';standard:z.infer<typeof SpecialCraftStageSchema>};
export function adoptSpecialCraft(value:SpecialCraftVersion,stage:'development'|'bulk'):FrozenSpecialCraft{
 const definition=SpecialCraftDefinitionSchema.parse(value.definition),standard=definition[stage];
 if(!definition.enabled)throw Error('该特殊工艺已停用，请选择启用的工艺');
 if(standard.minutes===null||standard.calendar===null)throw Error(`${definition.name}的${stage==='development'?'开发样板':'大货'}用时或计时日历尚未设置`);
 return {id:value.id,version:value.version,name:definition.name,stage,standard:structuredClone(standard)};
}

/** Each special library entry is a distinct step. Frozen names and values are
 * verified against the immutable library by the original publication command. */
export const CraftStepChoiceSchema=z.object({
 craftKind:z.enum(['embroidery','printing','special']),sequence:z.number().int().min(1).max(64),
 specialCraft:SpecialCraftVersionSchema.optional(),
}).strict().superRefine((step,ctx)=>{
 if((step.craftKind==='special')!==Boolean(step.specialCraft))ctx.addIssue({code:'custom',message:'特殊工艺须选择工艺库中的具体项目'});
});
export type CraftStepChoice=z.infer<typeof CraftStepChoiceSchema>;
export const craftStepIdentity=(step:Pick<CraftStepChoice,'craftKind'|'specialCraft'>)=>step.craftKind==='special'?`special:${step.specialCraft?.id??'missing'}`:step.craftKind;
export const craftStepLabel=(step:Pick<CraftStepChoice,'craftKind'|'specialCraft'>)=>step.craftKind==='special'?step.specialCraft?.definition.name??'特殊工艺':step.craftKind==='embroidery'?'绣花':'印花';
export const CraftStepChoicesSchema=z.array(CraftStepChoiceSchema).max(64).superRefine((steps,ctx)=>{
 if(new Set(steps.map(craftStepIdentity)).size!==steps.length)ctx.addIssue({code:'custom',message:'同一工艺只能选择一次'});
 if(steps.some((step,index)=>step.sequence!==index+1))ctx.addIssue({code:'custom',message:'请按实际先后顺序排列工艺'});
});
export const ProductionRoutePlanSchema=z.object({craftSteps:CraftStepChoicesSchema.nullable(),preshrink:z.boolean().nullable()}).strict();
export const craftChoiceLabel=(steps:readonly CraftStepChoice[])=>steps.map(craftStepLabel).join(' → ')||'无';
/** Compatibility label only; the immutable steps remain the route authority. */
export const craftLegacyLabel=(steps:readonly CraftStepChoice[]):'无'|'印花'|'绣花'|'印绣花'|'特殊工艺'=>steps.some(s=>s.craftKind==='special')?'特殊工艺':steps.length===2?'印绣花':steps[0]?.craftKind==='embroidery'?'绣花':steps[0]?.craftKind==='printing'?'印花':'无';
export type AdoptedCraftStep=CraftStepChoice&{
 stepId:string;scopeRef:string;canonicalWorkRef:string;
 planningParameterRef:string|null;planningMinutes:number|null;responsibilitySlaRef:string|null;responsibilityMinutes:number|null;responsibilityCalendar:string|null;calendarRef:string|null;adoptedVersion:string;
};

/** The legacy combined policy applies only to the two built-in crafts. */
export const hasBothBuiltinCrafts=(steps:readonly CraftStepChoice[])=>steps.some(step=>step.craftKind==='printing')&&steps.some(step=>step.craftKind==='embroidery');
