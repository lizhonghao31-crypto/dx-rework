import { z } from "zod";
import type { DigitalTask } from "./digital-production-tasks.js";
export const BulkDispatchSchema=z.object({expectedVersion:z.number().int().nonnegative(),patternWorkerId:z.string().uuid().nullable(),warehouseWorkerId:z.string().uuid().nullable().optional(),cuttingWorkerId:z.string().uuid().nullable().optional(),deliverPattern:z.boolean().default(false)}).strict();
export type BulkDispatch=z.infer<typeof BulkDispatchSchema>;
export const BulkCompletionSchema=z.object({preparationId:z.string().uuid(),kind:z.enum(["纸样完成","唛架完成","预缩完成"])}).strict();
export type BulkCompletion=z.infer<typeof BulkCompletionSchema>;
export type BulkCuttingProgress={mode:"in_house"|"outsourced"|null;completed:boolean;lines:Array<{lineId:string;poNumber:string|null;formalStyleNo:string|null;temporaryStyleNo:string|null;color:string;cuttingOrderId:string|null;orderQuantity:number;actualCutCount:number|null;pieceCount:number|null;corrected:boolean}>};
export type BulkPreparationReference={designStyleNo:string;customerCode:string|null;styleImageUrl:string|null;instructionVersion:number|null;sourceRound:number|null};
export type BulkPreparationSheet={reference:BulkPreparationReference;cutting:BulkCuttingProgress;orderId:string;instructionVersion:number|null;sourceRound:number|null;adoptedRound?:number|null;customerConfirmed:boolean;ownerApproved:boolean;instructionValid:boolean;reasons:string[];preparationId:string|null;preshrink:string|null;dispatch:{version:number;patternWorkerId:string|null;warehouseWorkerId:string|null;cuttingWorkerId:string|null};canDispatchPattern:boolean;canDispatchWarehouse:boolean;facts:Array<{kind:string;recordedAt:string}>;tasks:DigitalTask[]};

export const BulkWorkroomFilterSchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(""),scope:z.enum(["mine","all"]).default("mine")}).strict();
export type BulkWorkroomFilter=z.infer<typeof BulkWorkroomFilterSchema>;
export type BulkWorkroomResult={page:number;pageSize:15;total:number;items:Array<{orderId:string;designStyleNo:string;customer:string|null;sheet:BulkPreparationSheet}>};
