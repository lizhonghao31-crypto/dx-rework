import type {ProductionReadinessState} from "./production-readiness.js";
import { z } from "zod";
import type { DigitalTask } from "./digital-production-tasks.js";
export const BulkDispatchSchema=z.object({expectedVersion:z.number().int().nonnegative(),patternWorkerId:z.string().uuid().nullable(),warehouseWorkerId:z.string().uuid().nullable().optional(),cuttingWorkerId:z.string().uuid().nullable().optional(),deliverPattern:z.boolean().default(false)}).strict();
export type BulkDispatch=z.infer<typeof BulkDispatchSchema>;
export const BulkCompletionSchema=z.object({preparationId:z.string().uuid(),kind:z.enum(["纸样完成","唛架完成","预缩完成"]),expectedReadinessRevision:z.string().min(1).optional(),range:z.object({expectedVersion:z.number().int().nonnegative(),lineIds:z.array(z.uuid()).min(1).max(400),complete:z.boolean(),pendingMaterialIds:z.array(z.uuid()).max(400),note:z.string().trim().min(1).max(1000),evidenceIds:z.array(z.uuid()).max(40)}).strict().optional()}).strict();
export type BulkCompletion=z.infer<typeof BulkCompletionSchema>;
export type BulkCuttingProgress={mode:"in_house"|"outsourced"|null;completed:boolean;lines:Array<{lineId:string;poNumber:string|null;formalStyleNo:string|null;temporaryStyleNo:string|null;color:string;cuttingOrderId:string|null;orderQuantity:number;actualCutCount:number|null;pieceCount:number|null;corrected:boolean}>};
export type BulkPreparationReference={designStyleNo:string;customerCode:string|null;styleImageUrl:string|null;instructionVersion:number|null;sourceRound:number|null};
export type BulkPreparationSheet={physicalCuttingReasons?:string[];readiness?:ProductionReadinessState;materials?:BulkMaterialsView;fabric?:{report:({reportId:string;material:string;arrivedAt:string|null;inspectedAt:string|null;result:'合格'|'不合格'|null;note:string;operatorId:string})|null;decision:({decisionId:string;reportId:string;allowUse:boolean;note:string;operatorId:string})|null;usable:boolean;usableAt:string|null};canReportFabric?:boolean;canDecideFabric?:boolean;reference:BulkPreparationReference;cutting:BulkCuttingProgress;orderId:string;instructionVersion:number|null;sourceRound:number|null;adoptedRound?:number|null;customerConfirmed:boolean;ownerApproved:boolean;instructionValid:boolean;reasons:string[];preparationId:string|null;preshrink:string|null;dispatch:{version:number;patternWorkerId:string|null;warehouseWorkerId:string|null;cuttingWorkerId:string|null};canDispatchPattern:boolean;canDispatchWarehouse:boolean;facts:Array<{kind:string;recordedAt:string}>;tasks:DigitalTask[]};

export const BulkWorkroomFilterSchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(""),scope:z.enum(["mine","all"]).default("mine")}).strict();
export type BulkWorkroomFilter=z.infer<typeof BulkWorkroomFilterSchema>;
export type BulkWorkroomResult={page:number;pageSize:15;total:number;items:Array<{orderId:string;designStyleNo:string;customer:string|null;sheet:BulkPreparationSheet}>};

export const BulkFabricReportSchema=z.object({expectedReportId:z.string().uuid().nullable(),expectedReceiptVersion:z.number().int().nonnegative().optional(),material:z.string().trim().min(1).max(200),
 arrivedAt:z.iso.datetime({offset:true}).nullable(),inspectedAt:z.iso.datetime({offset:true}).nullable(),result:z.enum(['合格','不合格']).nullable(),note:z.string().trim().min(1).max(1000)
}).strict().refine(v=>(v.result===null)===(v.inspectedAt===null),'检验结论和完成时间需同时填写')
 .refine(v=>!v.arrivedAt||!v.inspectedAt||Date.parse(v.inspectedAt)>=Date.parse(v.arrivedAt),'检验完成不能早于到仓');
export type BulkFabricReport=z.infer<typeof BulkFabricReportSchema>;
export const BulkFabricDecisionSchema=z.object({reportId:z.string().uuid(),expectedDecisionId:z.string().uuid().nullable(),allowUse:z.boolean(),note:z.string().trim().min(1).max(1000)}).strict();
export type BulkFabricDecision=z.infer<typeof BulkFabricDecisionSchema>;

export const BulkMaterialsDispatchSchema=z.object({instructionVersion:z.number().int().positive(),supplierId:z.string().uuid(),occurredAt:z.iso.datetime({offset:true}),note:z.string().trim().max(1000).default(''),items:z.array(z.object({materialId:z.string().uuid(),quantity:z.number().positive().max(10000000),unit:z.string().trim().min(1).max(20)}).strict()).min(1).max(400)}).strict();
export type BulkMaterialsDispatch=z.infer<typeof BulkMaterialsDispatchSchema>;
export type BulkMaterialsView={canDispatch:boolean;supplierId:string|null;supplierName:string|null;instructionVersion:number|null;items:Array<{id:string;name:string;specification:string;materialColor:string;group:string}>;history:Array<{eventId:string;occurredAt:string;operatorName:string;note:string;items:Array<{materialId:string;name:string;quantity:number;unit:string}>}>};
