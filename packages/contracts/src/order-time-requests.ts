import {z} from 'zod';
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
export const OrderTimeApplySchema=z.object({expectedVersion:z.number().int().positive(),fingerprint:z.string().length(64),overrides:z.record(z.string(),OrderTimeRuleSchema),acceptLate:z.boolean().default(false)}).strict();
export const OrderTimeArrangementSchema=OrderTimeApplySchema.omit({expectedVersion:true}).extend({resource:z.object({kind:z.enum(['source','order']),id:z.string().uuid()}).strict()}).strict();
export const OrderTimeReturnSchema=z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(2000)}).strict();
export const OrderTimeWithdrawSchema=z.object({expectedVersion:z.number().int().positive()}).strict();
export const OrderTimeRowsSchema=z.array(z.object({id:z.string(),parameterKey:z.string(),label:z.string(),stage:z.number().int().min(1).max(7),rule:OrderTimeRuleSchema.nullable(),originalRule:OrderTimeRuleSchema.nullable(),begun:z.boolean(),preserveBegun:z.boolean().optional(),includedIn:z.string().nullable()}).strict());
export const OrderTimeCheckResultSchema=z.object({
 enabled:z.boolean(),fingerprint:z.string().length(64),resource:z.object({kind:z.enum(['source','order','proposal']),id:z.string().uuid().nullable()}).strict(),
 styleNo:z.string(),customerDates:z.array(z.object({po:z.string(),date:z.iso.date().nullable()}).strict()),
 plan:FrozenOrderTimePlanSchema,rows:OrderTimeRowsSchema,coverage:z.array(z.string()),
 feasibility:z.enum(['sufficient','insufficient','unknown']),availableMinutes:z.number().nullable(),requiredMinutes:z.number().nullable(),lateMinutes:z.number().nullable(),expectedEnd:z.string().nullable(),forecastQuality:z.enum(['conditional','lower_bound','unknown']),
 canRequest:z.boolean(),canApply:z.boolean(),sourceVersion:z.record(z.string(),z.unknown()),
}).strict();
export type OrderTimeCheckResult=z.infer<typeof OrderTimeCheckResultSchema>;
export const OrderTimeRequestReadSchema=z.object({requestId:z.string().uuid(),version:z.number().int().positive(),state:OrderTimeRequestStateSchema,operation:OrderTimeOperationSchema,requestedBy:z.object({id:z.string().uuid(),name:z.string().nullable()}).strict(),designerId:z.string().uuid(),reason:z.string(),returnReason:z.string().nullable(),appliedBy:z.object({id:z.string().uuid(),name:z.string().nullable()}).strict().nullable(),result:z.object({orderId:z.string().uuid().nullable(),lateMinutes:z.number().nullable()}).strict().nullable(),check:OrderTimeCheckResultSchema,canWithdraw:z.boolean()}).strict();
export type OrderTimeRequestRead=z.infer<typeof OrderTimeRequestReadSchema>;
