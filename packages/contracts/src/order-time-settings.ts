import {z} from 'zod';
import type {FrameworkMilestoneResultSchema} from './order-time-framework.js';
import {SERIES_MILESTONE_OFFSETS} from './digital-series-plan.js';
import {DIGITAL_SLA_PARAMETERS,type DigitalSlaValue} from './digital-sla.js';
import {OrderTimeRuleSchema,OrderTimeStandardSchema,type OrderTimeRule,type OrderTimeStandard} from './order-time-plan.js';
import type {SettingsSetValues} from './sla-settings-sets.js';
import {SettingsCalculationSchema} from './sla-settings-sets.js';
import {JOURNEY_NODES,JOURNEY_STAGES} from './digital-production-journey.js';

export type OrderTimeNode={key:string;label:string;stage:number;kind:OrderTimeRule['kind'];includedIn?:readonly string[]};
const hidden=new Set(['development_print_embroidery','bulk_print_embroidery','receiving_span','warning_ratio','stage_buffer']);
const event=new Set(['order_creation','customer_confirmation','budget','ship_sample']);
/** The same seven business stages as the actual cockpit, not the older
 * parameter catalogue's budget/customer-confirmation grouping. */
export function orderTimeNodeStage(key:string,fallback:number){
 const aliases:Record<string,string>={order_creation:'order_information',customer_confirmation:'customer_sample',production_sheet:'production_instruction',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',source_confirmation:'development_confirmation',external_pattern:'development_external_pattern',development_craft_return:'development_craft_confirmation',bulk_printing:'process_logistics',bulk_embroidery:'process_logistics',factory_production_work:'production_reporting',factory_work:'production_reporting',factory_production:'factory_production_qc',return_logistics:'receipts',garment_inspection:'receiving_inspection',garment_packing:'packing',ship_sample:'bulk_ship_sample'};
 const native=JOURNEY_NODES.find(node=>node.key===(aliases[key]??key));
 return native?JOURNEY_STAGES.findIndex(stage=>stage.key===native.stage)+1:fallback;
}
export const ORDER_TIME_NODES:readonly OrderTimeNode[]=[
 ...DIGITAL_SLA_PARAMETERS.filter(p=>!hidden.has(p.key)).map(p=>({key:p.key,label:p.key==='ship_sample_advance'?'船样需提前几天完成':p.key==='order_shipping_reminder'?'交货前提醒':p.label,stage:orderTimeNodeStage(p.key,p.stage),
  kind:(p.defaultValue.kind==='duration'?'work':p.defaultValue.kind==='included'?'included':p.defaultValue.kind==='estimate'?'forecast':p.defaultValue.kind==='offset'?'offset':p.defaultValue.kind==='order_date'?'date':event.has(p.key)?'event':'forecast') as OrderTimeRule['kind'],...(p.includedIn?{includedIn:p.includedIn.filter(key=>!hidden.has(key))}:{})})),
 {key:'development_confirmation',label:'设计确认',stage:2,kind:'event'},
 {key:'development_positioning',label:'开发定位资料',stage:2,kind:'event'},
 {key:'factory_production_work',label:'工厂生产',stage:6,kind:'forecast'},
 {key:'development_cycle_normal',label:'普通开发周期',stage:2,kind:'supervision'},
 {key:'development_cycle_urgent',label:'加急开发周期',stage:2,kind:'supervision'},
 {key:'development_size_review',label:'尺寸复核',stage:2,kind:'work'},
];
export const FRAMEWORK_TIME_NODES:readonly OrderTimeNode[]=[
 {key:'bulk_factory_washing',label:'工厂大货洗水',stage:6,kind:'work'},
 {key:'bulk_factory_washing_inspection',label:'工厂洗后检查',stage:6,kind:'work'},
 {key:'bulk_return_washing',label:'回货后大货洗水',stage:7,kind:'work'},
 {key:'bulk_return_washing_inspection',label:'回货洗后检查',stage:7,kind:'work'},
 {key:'design_handover',label:'设计资料交接',stage:1,kind:'event'},
 {key:'material_investment',label:'投面辅料',stage:3,kind:'event'},
 {key:'fabric_receipt_a',label:'需对色面料到仓周期',stage:3,kind:'forecast'},
 {key:'fabric_receipt_b',label:'不对色面料到仓周期',stage:3,kind:'forecast'},
 {key:'color_confirmation',label:'对色完成',stage:3,kind:'forecast'},
 {key:'client_sample_approval',label:'客户最终批复',stage:2,kind:'date'},
 {key:'style_label_ready',label:'款号唛实物备齐',stage:3,kind:'date'},
];
export const OrderTimeConfigurationSchema=z.object({nodes:OrderTimeStandardSchema.shape.nodes,stageBufferMinutes:OrderTimeStandardSchema.shape.stageBufferMinutes,framework:OrderTimeStandardSchema.shape.framework}).strict().superRefine((value,ctx)=>{
 const catalog=value.framework?[...ORDER_TIME_NODES,...FRAMEWORK_TIME_NODES]:ORDER_TIME_NODES;
 const keys=new Set(catalog.map(n=>n.key));
 for(const [key,rule] of Object.entries(value.nodes)){
  if(!keys.has(key))ctx.addIssue({code:'custom',path:['nodes',key],message:'不是本系统可设置的节点'});
  if(key!=='material_investment'&&rule.kind==='event'&&rule.accessoriesLeadTime)
   ctx.addIssue({code:'custom',path:['nodes',key,'accessoriesLeadTime'],message:'辅料采购周期只用于投面辅料'});
 }
 for(const node of catalog){const rule=value.nodes[node.key];if(!rule||rule.kind!==(value.framework&&['development_confirmation','development_positioning'].includes(node.key)?'work':value.framework&&node.key==='warehouse_accessories'?'date':node.kind))ctx.addIssue({code:'custom',path:['nodes',node.key],message:node.label+'的设置不完整'});}
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
 bulkWashing:z.object({mode:z.enum(['none','factory','after_receipt']),accounting:z.enum(['additional','included_in_factory'])}).strict().optional(),
 values:OrderTimeConfigurationSchema,frameworkRoute:z.enum(['A','B']).optional(),materialInvestmentScope:z.enum(['fabric','accessories','both']).nullable().optional(),startAt:z.iso.datetime({offset:true}),
 lines:z.array(z.object({id:z.string().trim().min(1).max(80),customerDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()}).strict()).min(1).max(20),
}).strict();
export type OrderTimeCalculation=z.infer<typeof OrderTimeCalculationSchema>;
export type OrderTimeCalculationResult={lines:Array<{milestones?:Array<z.infer<typeof FrameworkMilestoneResultSchema>>;inputWarnings?:string[];id:string;customerDate:string|null;totalSpanMinutes:number|null;expectedEnd:string|null;marginMinutes:number|null;
 deliveryStatus?:'sufficient'|'insufficient'|'unknown';
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

/** Explicit new-standard preparation only; never applied to an adopted order.
 * Preserve any recorded positive positioning value instead of replacing it. */
export function prepareTimeFrameworkConfiguration(values:OrderTimeConfiguration):OrderTimeConfiguration{
 const next=structuredClone(values);
 if(next.framework)return OrderTimeConfigurationSchema.parse(next);
 next.framework={version:'time-framework-company-v1',milestoneOffsets:structuredClone(SERIES_MILESTONE_OFFSETS)};
 for(const [key,minutes]of [['development_positioning',240],['development_confirmation',120]] as const){
  const prior=next.nodes[key];
  next.nodes[key]={kind:'work',minutes:prior?.minutes&&prior.minutes>0?prior.minutes:minutes,calendar:prior?.calendar??'continuous',reminder:prior?.reminder??{enabled:true,percent:70}};
 }
 for(const node of FRAMEWORK_TIME_NODES)next.nodes[node.key]=OrderTimeRuleSchema.parse({kind:node.kind,minutes:node.key.startsWith('bulk_')?null:node.key==='fabric_receipt_a'?41*1440:node.key==='fabric_receipt_b'?31*1440:node.key==='color_confirmation'?12*1440:0,calendar:'continuous',reminder:{enabled:node.key==='material_investment',percent:70}});
 next.nodes.warehouse_accessories={kind:'date',minutes:0,calendar:'continuous',reminder:next.nodes.warehouse_accessories?.reminder??{enabled:false,percent:70}};
 return OrderTimeConfigurationSchema.parse(next);
}
