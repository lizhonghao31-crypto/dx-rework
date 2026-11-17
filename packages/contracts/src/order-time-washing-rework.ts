import {z} from 'zod';
import {BulkWashingArrangementSchema} from './bulk-washing.js';

/** Explicit new work, selected before logistics begins. No client-supplied
 * timestamp, duration, approval or arrangement revision determines its identity. */
export const OrderTimeWashingReworkIntentSchema=z.object({intentId:z.uuid(),lineId:z.uuid(),scopeId:z.string().min(1).max(300),
 quantityVersion:z.string().min(1).max(300),inspectionId:z.uuid(),quantity:z.number().int().positive().max(2147483647)}).strict();
export const OrderTimeWashingReworkChangesSchema=z.array(OrderTimeWashingReworkIntentSchema).max(50)
 .refine(rows=>new Set(rows.map(row=>row.intentId)).size===rows.length,'返洗工作身份不能重复');
export type OrderTimeWashingReworkIntent=z.infer<typeof OrderTimeWashingReworkIntentSchema>;
export type OrderTimeWashingReworkChanges=z.infer<typeof OrderTimeWashingReworkChangesSchema>;

export const OrderTimeWashingReworkPlanSchema=OrderTimeWashingReworkIntentSchema.extend({orderId:z.uuid(),factoryDecisionId:z.uuid().nullable(),planId:z.uuid(),round:z.number().int().positive(),
 inspectionAt:z.iso.datetime({offset:true}).nullable(),arrangement:BulkWashingArrangementSchema,
 introducedAt:z.iso.datetime({offset:true}).nullable(),introducedEventRef:z.string().min(1).max(300).nullable(),
}).strict().superRefine((row,context)=>{
 if(row.arrangement.mode==='none')context.addIssue({code:'custom',path:['arrangement'],message:'返洗须有明确的原洗水用时和日历'});
 if((row.introducedAt===null)!==(row.introducedEventRef===null))context.addIssue({code:'custom',path:['introducedEventRef'],message:'返洗安排生效依据必须完整'});
});
export type OrderTimeWashingReworkPlan=z.infer<typeof OrderTimeWashingReworkPlanSchema>;
export const OrderTimeWashingReworkChoiceSchema=z.object({lineId:z.uuid(),scopeId:z.string(),quantityVersion:z.string(),inspectionId:z.uuid(),
 label:z.string(),round:z.number().int().positive(),availableQuantity:z.number().int().positive(),inspectionAt:z.string().nullable(),
 washingMinutes:z.number(),inspectionMinutes:z.number(),calendar:z.string(),inspectionCalendar:z.string()}).strict();
