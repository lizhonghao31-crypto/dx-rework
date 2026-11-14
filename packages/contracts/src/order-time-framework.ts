import {z} from 'zod';
import {CraftStepChoiceSchema} from './digital-craft.js';
import {FrozenOrderTimePlanSchema,OrderTimeCalendarSchema} from './order-time-plan.js';
import {SeriesDateSchema,SeriesMilestoneKeySchema} from './digital-series-plan.js';

const reference=z.string().trim().min(1).max(300);
const instant=z.iso.datetime({offset:true});
export const FrameworkAnchorSchema=z.discriminatedUnion('precision',[
 z.object({precision:z.literal('instant'),value:instant,source:reference}).strict(),
 z.object({precision:z.literal('date'),value:SeriesDateSchema,source:reference}).strict(),
 z.object({precision:z.literal('unknown'),reason:reference}).strict(),
]);
export const FrameworkTimeSchema=z.object({at:instant.nullable(),exclusive:z.boolean(),reasons:z.array(reference)}).strict()
 .refine(time=>time.at!==null||time.reasons.length>0,'未知时间必须保留原因');
export const FrameworkTargetSchema=z.object({id:reference,start:FrameworkTimeSchema,end:FrameworkTimeSchema}).strict()
 .refine(row=>!row.start.at||!row.end.at||Date.parse(row.start.at)<=Date.parse(row.end.at),'计划结束不能早于开始');
export const FrameworkRetainedWorkSchema=z.object({target:FrameworkTargetSchema,sourceRef:reference,actualCompletion:FrameworkTimeSchema.optional()}).strict();
/** Native per-scope duration, e.g. the exact washing adoption or its explicit
 * factory-inclusive remainder. Not a client override of a responsibility clock. */
export const FrameworkNativeDurationSchema=z.object({reference,minutes:z.number().nonnegative().max(525600).nullable(),calendar:OrderTimeCalendarSchema.nullable()}).strict();
export const FrameworkWorkSchema=z.object({id:reference,parameterKey:reference,stage:z.number().int().min(1).max(7),
 dependsOn:z.array(reference),craftStep:CraftStepChoiceSchema.optional(),nativeDuration:FrameworkNativeDurationSchema.optional(),includedIn:reference.optional(),includedPosition:z.enum(['start','end']).optional(),canonicalWorkRef:reference.optional(),
}).strict();
export const FrameworkMilestoneStandardSchema=z.object({reference,revision:z.number().int().positive(),
 offsets:z.record(SeriesMilestoneKeySchema,z.number().int().min(0).max(365).nullable()),
}).strict();
export const FrameworkMilestoneBindingSchema=z.object({key:SeriesMilestoneKeySchema,workIds:z.array(reference).min(1)}).strict();

/** A frozen input is not a live settings lookup. Scope identity includes the
 * original PO/round/batch references; adapters own authorization and membership.
 */
export const TimeFrameworkInputSchema=z.object({
 scopeRef:reference,route:z.enum(['A','B']),acceptedAt:FrameworkAnchorSchema,
 customerDelivery:z.object({date:SeriesDateSchema,source:reference,revision:z.number().int().positive()}).strict(),
 plan:FrozenOrderTimePlanSchema,milestoneStandard:FrameworkMilestoneStandardSchema,
 work:z.array(FrameworkWorkSchema).min(1),bindings:z.array(FrameworkMilestoneBindingSchema),
 notBefore:z.record(z.string(),FrameworkAnchorSchema),
}).strict().superRefine((value,context)=>{
 const ids=new Set(value.work.map(row=>row.id));
 if(ids.size!==value.work.length)context.addIssue({code:'custom',path:['work'],message:'工作身份重复'});
 const keys=new Set<string>(value.bindings.map(row=>row.key));
 if(keys.size!==value.bindings.length)context.addIssue({code:'custom',path:['bindings'],message:'里程碑关联重复'});
 for(const [key,days] of Object.entries(value.milestoneStandard.offsets)){
  const applicable=key!=='color_confirmation'||value.route==='A';
  if(applicable?(days===null||!keys.has(key)):(days!==null||keys.has(key)))context.addIssue({code:'custom',path:['bindings'],message:'里程碑必须完整对应本单 A/B 路线'});
 }
 if(value.milestoneStandard.offsets.planned_shipment!==0)context.addIssue({code:'custom',path:['milestoneStandard'],message:'出货里程碑必须使用本单客户交货日'});
 for(const binding of value.bindings)if(new Set(binding.workIds).size!==binding.workIds.length||binding.workIds.some(id=>!ids.has(id)))context.addIssue({code:'custom',path:['bindings'],message:'里程碑关联必须引用唯一的真实工作'});
 for(const id of Object.keys(value.notBefore))if(!ids.has(id))context.addIssue({code:'custom',path:['notBefore',id],message:'预计条件不属于本范围工作'});
});
export type TimeFrameworkInput=z.infer<typeof TimeFrameworkInputSchema>;
export type FrameworkTarget=z.infer<typeof FrameworkTargetSchema>;

export const FrameworkMilestoneResultSchema=z.object({key:SeriesMilestoneKeySchema,date:SeriesDateSchema,
 target:FrameworkTimeSchema,planned:FrameworkTimeSchema,workIds:z.array(reference),
 status:z.enum(['sufficient','insufficient','unknown']),lateMinutes:z.number().nonnegative().nullable(),
 marginMinutes:z.number().nullable(),blockingWorkIds:z.array(reference),
}).strict();

/** New persisted format, supplied before any writer is enabled. It preserves
 * both layers explicitly; an old v1 duration plan is never silently upgraded.
 * Actual events and entered responsibility windows remain their native records.
 */
export const FrozenTimeFrameworkSchema=z.object({
 version:z.literal('order-time-framework-v1'),reference,revision:z.number().int().positive(),
 previousReference:reference.nullable(),effectiveAt:instant,eventRef:reference,
 input:TimeFrameworkInputSchema,arranged:z.array(FrameworkTargetSchema),
 retained:z.record(z.string(),FrameworkRetainedWorkSchema),
 milestones:z.array(FrameworkMilestoneResultSchema),
}).strict().superRefine((value,context)=>{
 const ids=value.arranged.map(row=>row.id),expected=value.input.work.map(row=>row.id);
 if(new Set(ids).size!==ids.length||ids.length!==expected.length||expected.some(id=>!ids.includes(id)))context.addIssue({code:'custom',path:['arranged'],message:'保存的计划必须覆盖完整工作集合'});
 const keys=value.milestones.map(row=>row.key);
 if(new Set(keys).size!==keys.length||keys.length!==value.input.bindings.length||value.input.bindings.some(row=>!keys.includes(row.key)))context.addIssue({code:'custom',path:['milestones'],message:'保存的里程碑必须覆盖本单关联'});
 if(value.revision===1?value.previousReference!==null:value.previousReference===null)context.addIssue({code:'custom',path:['previousReference'],message:'版本必须保留前版来源'});
 if(value.previousReference===value.reference)context.addIssue({code:'custom',path:['previousReference'],message:'版本不能引用自身为前版'});
 for(const [id,row]of Object.entries(value.retained))if(row.target.id!==id||!expected.includes(id))context.addIssue({code:'custom',path:['retained',id],message:'保留依据不属于本范围工作'});
 for(const milestone of value.milestones){
  const binding=value.input.bindings.find(row=>row.key===milestone.key);
  if(!binding||milestone.workIds.length!==binding.workIds.length||milestone.workIds.some(id=>!binding.workIds.includes(id)))context.addIssue({code:'custom',path:['milestones'],message:'里程碑结果与本版工作关联不符'});
 }
});
export type FrozenTimeFramework=z.infer<typeof FrozenTimeFrameworkSchema>;

/** Explicit decoder for future rollback readers. Unsupported formats fail
 * closed; neither a missing v2 layer nor malformed data is replaced with today.
 */
export function readTimeFrameworkPlan(value:unknown){
 const version=z.object({version:z.string()}).parse(value).version;
 if(version==='order-time-plan-v1')return {kind:'legacy' as const,plan:FrozenOrderTimePlanSchema.parse(value)};
 if(version==='order-time-framework-v1')return {kind:'framework' as const,plan:FrozenTimeFrameworkSchema.parse(value)};
 throw Error('当前程序不支持此时间方案版本');
}

/** Captured once by the native start event, not rebuilt from current settings. */
export const FrameworkResponsibilityWindowSchema=z.object({scopeRef:reference,workId:reference,eventRef:reference,
 standardRef:reference,standardRevision:z.number().int().positive(),startedAt:instant,
 minutes:z.number().positive().max(525600),calendar:OrderTimeCalendarSchema,attributionKnown:z.boolean(),
}).strict();
export type FrameworkResponsibilityWindow=z.infer<typeof FrameworkResponsibilityWindowSchema>;
