import {z} from 'zod';
import {isSlaDurationMinutes} from './digital-sla.js';

export const OrderTimeCalendarSchema=z.enum(['continuous','natural_days','beijing_sunday_excluded']);
const minutes=z.number().refine(isSlaDurationMinutes,'请填写有效用时，最长365天');
const reminder=z.object({enabled:z.boolean(),percent:z.number().int().min(1).max(99)}).strict();
const common={calendar:OrderTimeCalendarSchema.nullable(),reminder};
/** Kind and dependency are business definitions, not editable scheduling tricks. */
export const OrderTimeRuleSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('work'),minutes:minutes.nullable(),...common}).strict(),
 z.object({kind:z.literal('included'),minutes:minutes.nullable(),...common}).strict(),
 z.object({kind:z.literal('forecast'),minutes:minutes.nullable(),...common}).strict(),
 z.object({kind:z.literal('event'),minutes:z.literal(0),...common}).strict(),
 z.object({kind:z.literal('date'),minutes:z.literal(0),...common}).strict(),
 z.object({kind:z.literal('offset'),minutes:z.literal(0),days:z.number().int().min(0).max(365).nullable(),...common}).strict(),
 z.object({kind:z.literal('supervision'),minutes:minutes.nullable(),...common}).strict(),
]);
export type OrderTimeRule=z.infer<typeof OrderTimeRuleSchema>;
const rules=z.record(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),OrderTimeRuleSchema);
export const OrderTimeStandardSchema=z.object({
 version:z.literal('order-time-standard-v1'),reference:z.string().trim().min(1).max(300),
 revision:z.number().int().positive(),nodes:rules,
 stageBufferMinutes:z.number().int().min(0).max(525600),
}).strict();
export type OrderTimeStandard=z.infer<typeof OrderTimeStandardSchema>;
/** Complete company counterpart stays frozen even when a node is not applicable. */
export const FrozenOrderTimePlanSchema=z.object({
 version:z.literal('order-time-plan-v1'),company:OrderTimeStandardSchema,
 overrides:rules,revision:z.number().int().positive(),
 stageBufferMinutes:z.number().int().min(0).max(525600).optional(),
}).strict().superRefine((plan,context)=>{
 for(const [key,value]of Object.entries(plan.overrides)){
  const standard=plan.company.nodes[key];
  if(standard&&standard.kind!==value.kind)context.addIssue({code:'custom',path:['overrides',key,'kind'],message:'本单调整不能改变节点性质'});
 }
 const normal=plan.overrides.development_cycle_normal??plan.company.nodes.development_cycle_normal,urgent=plan.overrides.development_cycle_urgent??plan.company.nodes.development_cycle_urgent;
 if(normal?.kind==='supervision'&&urgent?.kind==='supervision'&&normal.minutes!==null&&urgent.minutes!==null&&urgent.minutes>normal.minutes)context.addIssue({code:'custom',path:['overrides','development_cycle_urgent'],message:'加急开发周期不能长于普通开发周期'});
});
export type FrozenOrderTimePlan=z.infer<typeof FrozenOrderTimePlanSchema>;
export type OrderTimeRuleSource={rule:OrderTimeRule;source:'company'|'order';reference:string;revision:number};

export function orderTimeRule(plan:FrozenOrderTimePlan,key:string):OrderTimeRuleSource|null{
 const override=plan.overrides[key],rule=override??plan.company.nodes[key];
 return rule?{rule:structuredClone(rule),source:override?'order':'company',reference:plan.company.reference,revision:override?plan.revision:plan.company.revision}:null;
}

/** New company publications are deliberately not an input to this operation. */
export function reviseOrderTimePlan(previous:FrozenOrderTimePlan,changes:Record<string,OrderTimeRule>,stageBufferMinutes?:number):FrozenOrderTimePlan{
 const saved=FrozenOrderTimePlanSchema.parse(previous);
 return FrozenOrderTimePlanSchema.parse({...saved,revision:saved.revision+1,overrides:{...saved.overrides,...structuredClone(changes)},...(stageBufferMinutes===undefined?{}:{stageBufferMinutes})});
}
