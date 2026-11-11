import {z} from 'zod';
import {DIGITAL_SLA_PARAMETERS,type DigitalSlaValue} from './digital-sla.js';
import {OrderTimeRuleSchema,OrderTimeStandardSchema,type OrderTimeRule,type OrderTimeStandard} from './order-time-plan.js';
import type {SettingsSetValues} from './sla-settings-sets.js';
import {SettingsCalculationSchema} from './sla-settings-sets.js';

export type OrderTimeNode={key:string;label:string;stage:number;kind:OrderTimeRule['kind'];includedIn?:readonly string[]};
const hidden=new Set(['development_print_embroidery','bulk_print_embroidery','receiving_span','warning_ratio','stage_buffer']);
const event=new Set(['order_creation','customer_confirmation','budget','ship_sample']);
export const ORDER_TIME_NODES:readonly OrderTimeNode[]=[
 ...DIGITAL_SLA_PARAMETERS.filter(p=>!hidden.has(p.key)).map(p=>({key:p.key,label:p.key==='ship_sample_advance'?'船样需提前几天完成':p.key==='order_shipping_reminder'?'交货前提醒':p.label,stage:p.stage,
  kind:(p.defaultValue.kind==='duration'?'work':p.defaultValue.kind==='included'?'included':p.defaultValue.kind==='estimate'?'forecast':p.defaultValue.kind==='offset'?'offset':p.defaultValue.kind==='order_date'?'date':event.has(p.key)?'event':'forecast') as OrderTimeRule['kind'],...(p.includedIn?{includedIn:p.includedIn.filter(key=>!hidden.has(key))}:{})})),
 {key:'development_confirmation',label:'设计确认',stage:2,kind:'event'},
 {key:'development_positioning',label:'开发定位资料',stage:2,kind:'event'},
 {key:'factory_production_work',label:'工厂生产',stage:6,kind:'forecast'},
 {key:'development_cycle_normal',label:'普通开发周期',stage:2,kind:'supervision'},
 {key:'development_cycle_urgent',label:'加急开发周期',stage:2,kind:'supervision'},
 {key:'development_size_review',label:'尺寸复核',stage:2,kind:'work'},
];
export const OrderTimeConfigurationSchema=z.object({nodes:OrderTimeStandardSchema.shape.nodes,stageBufferMinutes:OrderTimeStandardSchema.shape.stageBufferMinutes}).strict().superRefine((value,ctx)=>{
 const keys=new Set(ORDER_TIME_NODES.map(n=>n.key));
 for(const key of Object.keys(value.nodes))if(!keys.has(key))ctx.addIssue({code:'custom',path:['nodes',key],message:'不是本系统可设置的节点'});
 for(const node of ORDER_TIME_NODES){const rule=value.nodes[node.key];if(!rule||rule.kind!==node.kind)ctx.addIssue({code:'custom',path:['nodes',node.key],message:node.label+'的设置不完整'});}
 for(const parent of ORDER_TIME_NODES){const rule=value.nodes[parent.key];if(!rule||!('minutes'in rule)||rule.minutes===null)continue;
  const children=ORDER_TIME_NODES.filter(n=>n.includedIn?.includes(parent.key));
  const used=children.reduce((sum,n)=>sum+(value.nodes[n.key]?.minutes??0),0);
  if(used>rule.minutes)ctx.addIssue({code:'custom',path:['nodes',parent.key],message:parent.label+'内已包含的用时不能超过它的总用时'});
 }
 const normal=value.nodes.development_cycle_normal?.minutes,urgent=value.nodes.development_cycle_urgent?.minutes;
 if(normal!=null&&urgent!=null&&urgent>normal)ctx.addIssue({code:'custom',path:['nodes','development_cycle_urgent'],message:'加急开发周期不能长于普通开发周期'});
});
export type OrderTimeConfiguration=z.infer<typeof OrderTimeConfigurationSchema>;
export type OrderTimeStandardRecord={id:string;version:number;standard:OrderTimeStandard;recordedAt:string;sourceId:string|null};
export type OrderTimeSettingsRead={enabled:boolean;version:number;referenceTime:string;current:OrderTimeConfiguration;record:OrderTimeStandardRecord|null};
export const OrderTimeHistoryKindSchema=z.enum(['order_time','legacy_set','legacy_unified','legacy_development']);
export type OrderTimeHistoryKind=z.infer<typeof OrderTimeHistoryKindSchema>;
export type OrderTimeHistoryRecord=OrderTimeStandardRecord&{kind:OrderTimeHistoryKind;partial:boolean;missing:string[]};
export type OrderTimeSettingsHistory={items:OrderTimeHistoryRecord[];page:number;pageSize:15;totalCount:number};
export const OrderTimeSettingsSaveSchema=z.object({expectedVersion:z.number().int().nonnegative(),values:OrderTimeConfigurationSchema,sourceId:z.uuid().nullable().default(null)}).strict();
export const OrderTimeSettingsUseSchema=z.object({expectedVersion:z.number().int().nonnegative(),id:z.string().trim().min(1).max(200),kind:OrderTimeHistoryKindSchema.default('order_time')}).strict().superRefine((value,ctx)=>{
 if(value.kind==='legacy_development'?!/^[1-9]\d{0,8}$/.test(value.id):!z.uuid().safeParse(value.id).success)ctx.addIssue({code:'custom',path:['id'],message:'请选择有效历史设置'});
});
export const OrderTimeCalculationSchema=SettingsCalculationSchema.omit({values:true}).extend({
 values:OrderTimeConfigurationSchema,startAt:z.iso.datetime({offset:true}),
 lines:z.array(z.object({id:z.string().trim().min(1).max(80),customerDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()}).strict()).min(1).max(20),
}).strict();
export type OrderTimeCalculation=z.infer<typeof OrderTimeCalculationSchema>;
export type OrderTimeCalculationResult={lines:Array<{id:string;customerDate:string|null;totalSpanMinutes:number|null;expectedEnd:string|null;marginMinutes:number|null;
 stages:Array<{stage:number;spanMinutes:number|null}>;rows:Array<{id:string;parameterKey:string;label:string;stage:number;minutes:number|null;calendar:string|null;startAt:string|null;startExclusive:boolean;endAt:string|null;endExclusive:boolean;includedIn:string|null;missing:string[]}>}>};

/** An explicit import for the new standard, never a reinterpretation of any
 * already adopted order. Unknown old planning remains unknown. Ordinary work
 * keeps its actual responsibility value; the new UI shows that one value.
 */
export function orderTimeConfigurationFromLegacy(values:Partial<SettingsSetValues>):OrderTimeConfiguration{
 const warning=values.unified?.warning_ratio,reminder={enabled:warning?.kind==='ratio'&&warning.notificationEnabled!==false,percent:warning?.kind==='ratio'?warning.percent:70};
 const nodes:Record<string,OrderTimeRule>={};
 for(const node of ORDER_TIME_NODES){
  const old:DigitalSlaValue|undefined=values.unified?.[node.key],planned=values.planning?.[node.key as keyof NonNullable<typeof values.planning>];
  const base={calendar:planned?.calendar??'continuous' as const,reminder:{...reminder}};
  if(node.kind==='event'||node.kind==='date')nodes[node.key]={kind:node.kind,minutes:0,...base};
  else if(node.kind==='offset')nodes[node.key]={kind:'offset',minutes:0,days:old?.kind==='offset'?old.days:null,...base,reminder:{...reminder,enabled:old?.kind==='offset'&&old.notificationEnabled!==false}};
  else{
   const cycle=values.development?(node.key==='development_cycle_normal'?values.development.normalDays*1440:node.key==='development_cycle_urgent'?values.development.urgentDays*1440:node.key==='development_size_review'?values.development.sizeReviewHours*60:null):null;
   const minutes=cycle??((node.kind==='work'||node.kind==='included')&&old&&'minutes'in old?old.minutes:planned?.minutes??(old&&'minutes'in old?old.minutes:null));
   nodes[node.key]=OrderTimeRuleSchema.parse({kind:node.kind,minutes:minutes===0?null:minutes,...base});
  }
 }
 const buffer=values.unified?.stage_buffer;
 return OrderTimeConfigurationSchema.parse({nodes,stageBufferMinutes:buffer?.kind==='buffer'?buffer.minutes:0});
}
