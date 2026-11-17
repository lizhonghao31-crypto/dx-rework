import {z} from 'zod';
import {OrderTimeCalendarSchema} from './order-time-plan.js';
import {isSlaDurationMinutes} from './digital-sla.js';

/** Normal garment washing is not development washing or fabric preshrinking. */
export const BulkWashingModeSchema=z.enum(['none','factory','after_receipt']);
export type BulkWashingMode=z.infer<typeof BulkWashingModeSchema>;
export const bulkWashingLabels:Record<BulkWashingMode,string>={none:'不需要洗水',factory:'工厂洗好交付',after_receipt:'回货后另送洗'};
const duration=z.object({minutes:z.number().refine(isSlaDurationMinutes),calendar:OrderTimeCalendarSchema,
 reminder:z.object({enabled:z.boolean(),percent:z.number().int().min(1).max(99)}).strict()}).strict();
/** No guessed 1/3-day defaults. An adopted arrangement carries its own source. */
export const BulkWashingArrangementSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('none')}).strict(),
 z.object({mode:z.literal('factory'),reference:z.string().trim().min(1).max(300),revision:z.number().int().positive(),
  accounting:z.enum(['included_in_factory','additional']),washing:duration,inspection:duration}).strict(),
 z.object({mode:z.literal('after_receipt'),reference:z.string().trim().min(1).max(300),revision:z.number().int().positive(),
  accounting:z.literal('additional'),washing:duration,inspection:duration}).strict(),
]);
export type BulkWashingArrangement=z.infer<typeof BulkWashingArrangementSchema>;

/** A ledger is for one PO, factory and allocation/receipt quantity version.
 * It never turns washed quantities into new receipts or additional garments. */
export type BulkWashingScope={scopeId:string;lineId:string;factoryDecisionId:string|null;quantityVersion:string;quantity:number};
export type BulkWashingFact={id:string;scopeId:string;quantityVersion:string;occurredAt:string|null} & (
 |{kind:'send';quantity:number;reworkOfInspectionId?:string|undefined;rewashWorkId?:string|undefined}
 |{kind:'return';sendId:string;quantity:number}
 |{kind:'factory_start';quantity:number;reworkOfInspectionId?:string|undefined;rewashWorkId?:string|undefined}
 |{kind:'factory_complete';startId:string;quantity:number}
 |{kind:'receipt_link';completionId:string;receiptId:string;receiptQuantityVersion:string;quantity:number}
 |{kind:'inspection';completionId:string;quantity:number;qualifiedQuantity:number}
);

export const BulkWashingStaffSchema=z.object({logisticsId:z.uuid(),inspectorId:z.uuid()}).strict();
export const BulkWashingFeeSourceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('pending')}).strict(),
 z.object({kind:z.literal('budget_row'),version:z.number().int().positive(),rowId:z.uuid()}).strict(),
]);
export const BulkWashingAdoptionSchema=z.object({arrangement:BulkWashingArrangementSchema,staff:BulkWashingStaffSchema.optional(),
 fee:BulkWashingFeeSourceSchema,sourceRef:z.string().trim().min(1).max(300)}).strict().superRefine((value,ctx)=>{if(value.arrangement.mode!=='none'&&!value.staff)ctx.addIssue({code:'custom',path:['staff'],message:'适用洗水须指定办理和检查岗位'});});
export type BulkWashingAdoption=z.infer<typeof BulkWashingAdoptionSchema>;
const commandBase={planId:z.uuid(),scopeId:z.string().min(1).max(300),quantityVersion:z.string().min(1).max(300),
 expectedRevision:z.number().int().nonnegative(),occurredAt:z.iso.datetime({offset:true}).nullable(),note:z.string().trim().max(2000)};
const positive=z.number().int().positive().max(2147483647);
export const BulkWashingCommandSchema=z.discriminatedUnion('kind',[
 z.object({...commandBase,kind:z.literal('send'),quantity:positive,reworkOfInspectionId:z.uuid().optional(),rewashWorkId:z.uuid().optional()}).strict(),
 z.object({...commandBase,kind:z.literal('return'),sendId:z.uuid(),quantity:positive}).strict(),
 z.object({...commandBase,kind:z.literal('factory_start'),quantity:positive,reworkOfInspectionId:z.uuid().optional(),rewashWorkId:z.uuid().optional()}).strict(),
 z.object({...commandBase,kind:z.literal('factory_complete'),quantity:positive,startId:z.uuid()}).strict(),
 z.object({...commandBase,kind:z.literal('inspection'),completionId:z.uuid(),quantity:positive,qualifiedQuantity:z.number().int().nonnegative()}).strict(),
 z.object({...commandBase,kind:z.literal('receipt_link'),completionId:z.uuid(),receiptId:z.uuid(),receiptQuantityVersion:z.string().min(1).max(300),quantity:positive}).strict(),
 z.object({...commandBase,kind:z.literal('void'),factId:z.uuid(),reason:z.string().trim().min(1).max(2000)}).strict(),
]);
export type BulkWashingCommand=z.infer<typeof BulkWashingCommandSchema>;
export type BulkWashingScopeView=BulkWashingScope&{planId:string;mode:Exclude<BulkWashingMode,'none'>;label:string;revision:number;
 requireRewashPlan?:boolean;
 rewashPlans?:Array<{intentId:string;inspectionId:string;round:number;quantity:number;remaining:number;washingPlannedAt:string|null;inspectionPlannedAt:string|null}>;
 receivedAt:string|null;availableAt:string|null;canLogistics:boolean;canInspect:boolean;canCorrect:boolean;
 windows:Array<{id:string;kind:'washing'|'inspection';state:'active'|'completed'|'voided';startedAt:string|null;dueAt:string|null;completedAt:string|null;minutes:number;overdueMinutes:number|null}>;
 receipts?:Array<{receiptId:string;quantity:number;quantityVersion:string}>;
 factorySource?:{productionId:string;sourcingDecisionId:string;position:number;quantity:number};
 ledger:{applicable:boolean;conflict:boolean;reasons:string[];sent:number;washed:number;qualified:number|null;remaining:number|null;complete:boolean;completedAt:string|null;sendable:number;
  rework?:{sent:number;washed:number;qualified:number;available:Array<{inspectionId:string;quantity:number;round:number}>;rounds:Record<string,number>}};
 facts:Array<BulkWashingFact&{recordedAt:string;operator:string;note:string;voided:boolean}>;
 fee?:{state:'pending'|'referenced';version?:number;rowId?:string;name?:string;unitPrice?:string;consumption?:string};};
export type BulkWashingSheet={orderId:string;scopes:BulkWashingScopeView[]};
