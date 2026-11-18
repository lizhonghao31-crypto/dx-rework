import {z} from 'zod';
import {OrderTimeWashingReworkChangesSchema,OrderTimeWashingReworkChoiceSchema} from './order-time-washing-rework.js';
import {SERIES_MILESTONES} from './digital-series-plan.js';
import {BulkWashingAdoptionSchema} from './bulk-washing.js';
import {FrameworkMilestoneResultSchema} from './order-time-framework.js';
import {DigitalOrderCreateSchema} from './digital-production.js';
import {PublishDevelopmentSchema} from './digital-development.js';
import {PublishDevelopmentRevisionSchema} from './digital-development-rounds.js';
import {PublishInstructionSchema} from './production-instruction.js';
import {ProductionRoutePlanSchema} from './digital-craft.js';
import {FrozenOrderTimePlanSchema,OrderTimeRuleSchema} from './order-time-plan.js';

/** A declared future route, not an invented completed fact or inferred no-craft.
 * Null explicitly means it still needs the original business entry to decide.
 */
export const OrderTimeProductionRouteSchema=ProductionRoutePlanSchema;
export type OrderTimeProductionRoute=z.infer<typeof OrderTimeProductionRouteSchema>;
export const OrderTimeOperationSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('development_publish'),sourceId:z.string().uuid(),input:PublishDevelopmentSchema}).strict(),
 z.object({kind:z.literal('confirm_order'),sourceId:z.string().uuid(),input:DigitalOrderCreateSchema}).strict(),
 z.object({kind:z.literal('direct_order'),input:DigitalOrderCreateSchema,route:OrderTimeProductionRouteSchema}).strict(),
 z.object({kind:z.literal('instruction_publish'),orderId:z.string().uuid(),input:PublishInstructionSchema}).strict(),
 z.object({kind:z.literal('development_revision'),sourceId:z.string().uuid(),input:PublishDevelopmentRevisionSchema}).strict(),
 z.object({kind:z.literal('arrangement'),resource:z.object({kind:z.enum(['source','order']),id:z.string().uuid()}).strict()}).strict(),
]);
export type OrderTimeOperation=z.infer<typeof OrderTimeOperationSchema>;
export const OrderTimeRequestStateSchema=z.enum(['needs_designer','pending','returned','withdrawn','applied']);
export type OrderTimeRequestState=z.infer<typeof OrderTimeRequestStateSchema>;
export const OrderTimeCheckSchema=z.object({operation:OrderTimeOperationSchema}).strict();
export const OrderTimeRequestSchema=z.object({operation:OrderTimeOperationSchema,fingerprint:z.string().length(64),reason:z.string().trim().min(1).max(2000)}).strict();
export const OrderTimeWashingChangesSchema=z.array(z.object({lineId:z.uuid(),expectedVersion:z.number().int().nonnegative(),document:BulkWashingAdoptionSchema}).strict()).max(50).refine(rows=>new Set(rows.map(row=>row.lineId)).size===rows.length,'请选择不重复的洗水PO');
export type OrderTimeWashingChanges=z.infer<typeof OrderTimeWashingChangesSchema>;
export const OrderTimeApplySchema=z.object({expectedVersion:z.number().int().positive(),fingerprint:z.string().length(64),overrides:z.record(z.string(),OrderTimeRuleSchema),acceptLate:z.boolean().default(false),washing:OrderTimeWashingChangesSchema.optional(),rewashing:OrderTimeWashingReworkChangesSchema.optional()}).strict();
export const OrderTimeArrangementSchema=OrderTimeApplySchema.omit({expectedVersion:true}).extend({resource:z.object({kind:z.enum(['source','order']),id:z.string().uuid()}).strict()}).strict();
export const OrderTimeReturnSchema=z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(2000)}).strict();
export const OrderTimeWithdrawSchema=z.object({expectedVersion:z.number().int().positive()}).strict();
export const OrderTimeRowsSchema=z.array(z.object({id:z.string(),parameterKey:z.string(),label:z.string(),stage:z.number().int().min(1).max(7),rule:OrderTimeRuleSchema.nullable(),originalRule:OrderTimeRuleSchema.nullable(),begun:z.boolean(),preserveBegun:z.boolean().optional(),includedIn:z.string().nullable()}).strict());
export const OrderTimeCheckResultSchema=z.object({
 enabled:z.boolean(),fingerprint:z.string().length(64),resource:z.object({kind:z.enum(['source','order','proposal']),id:z.string().uuid().nullable()}).strict(),
 styleNo:z.string(),customerDates:z.array(z.object({po:z.string(),date:z.iso.date().nullable()}).strict()),
 plan:FrozenOrderTimePlanSchema,rows:OrderTimeRowsSchema,coverage:z.array(z.string()),
 feasibility:z.enum(['sufficient','insufficient','unknown','not_applicable']),availableMinutes:z.number().nullable(),requiredMinutes:z.number().nullable(),lateMinutes:z.number().nullable(),expectedEnd:z.string().nullable(),forecastQuality:z.enum(['conditional','lower_bound','unknown']),
 factoryCommitments:z.array(z.object({lineId:z.string(),label:z.string(),date:z.string(),version:z.number().int().nonnegative(),source:z.string(),plannedReceipt:z.string().nullable(),lateMinutes:z.number().nonnegative().nullable(),status:z.enum(['sufficient','insufficient','unknown'])}).strict()).optional(),
 washing:z.array(z.object({lineId:z.uuid(),label:z.string(),version:z.number().int().nonnegative(),document:BulkWashingAdoptionSchema.nullable()}).strict()).optional(),
 rewashing:z.array(OrderTimeWashingReworkChoiceSchema).optional(),
 framework:z.object({milestones:z.array(FrameworkMilestoneResultSchema.extend({scopeRef:z.string()})),riskAccepted:z.boolean()}).strict().optional(),
 canRequest:z.boolean(),canApply:z.boolean(),sourceVersion:z.record(z.string(),z.unknown()),
}).strict();
export type OrderTimeCheckResult=z.infer<typeof OrderTimeCheckResultSchema>;
export const OrderTimeRequestReadSchema=z.object({requestId:z.string().uuid(),version:z.number().int().positive(),state:OrderTimeRequestStateSchema,operation:OrderTimeOperationSchema,requestedBy:z.object({id:z.string().uuid(),name:z.string().nullable()}).strict(),designerId:z.string().uuid(),reason:z.string(),returnReason:z.string().nullable(),appliedBy:z.object({id:z.string().uuid(),name:z.string().nullable()}).strict().nullable(),result:z.object({orderId:z.string().uuid().nullable(),lateMinutes:z.number().nullable()}).strict().nullable(),check:OrderTimeCheckResultSchema,canWithdraw:z.boolean()}).strict();
export type OrderTimeRequestRead=z.infer<typeof OrderTimeRequestReadSchema>;

/** The preview and final confirmation describe the same intermediate gaps. */
export function orderTimeGapText(check:Pick<OrderTimeCheckResult,'framework'|'lateMinutes'|'factoryCommitments'>){
 const days=(minutes:number)=>(Math.ceil(minutes/1440*100)/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
 const gaps=check.framework?.milestones.filter(row=>row.status==='insufficient')??[];
 const factoryGaps=(check.factoryCommitments??[]).filter(row=>row.status==='insufficient');
 const gap=(label:string,minutes:number|null)=>minutes===null?`${label}缺口尚待核实`:minutes===0?`${label}时间不足`:`${label}晚${days(minutes)}天`;
 if(!gaps.length&&!factoryGaps.length)return check.lateMinutes===null?'完成时间尚待核实':check.lateMinutes===0?'本单时间不足，是否继续？':`按目前安排预计晚交${days(check.lateMinutes)}天，是否继续？`;
 const detail=[...factoryGaps.map(row=>gap(`${row.label}工厂交货`,row.lateMinutes)),...gaps.map(row=>gap(SERIES_MILESTONES.find(item=>item.key===row.key)!.label,row.lateMinutes))].join('、');
 const shipmentGap=gaps.some(row=>row.key==='planned_shipment');
 const final=check.lateMinutes!==null&&check.lateMinutes>0?gap('最终交期',check.lateMinutes):shipmentGap?'最终交期时间不足':check.lateMinutes===null?'最终交期尚待核实':'最终交期仍可满足';
 return `${detail}；${final}，是否继续？`;
}
