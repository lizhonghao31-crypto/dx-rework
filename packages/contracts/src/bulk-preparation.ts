import { z } from "zod";
import type { DigitalTask } from "./digital-production-tasks.js";
export const BulkDispatchSchema=z.object({expectedVersion:z.number().int().nonnegative(),patternWorkerId:z.string().uuid().nullable(),warehouseWorkerId:z.string().uuid().nullable().optional(),cuttingWorkerId:z.string().uuid().nullable().optional(),deliverPattern:z.boolean().default(false)}).strict();
export type BulkDispatch=z.infer<typeof BulkDispatchSchema>;
export const BulkCompletionSchema=z.object({preparationId:z.string().uuid(),kind:z.enum(["纸样完成","唛架完成","预缩完成"])}).strict();
export type BulkCompletion=z.infer<typeof BulkCompletionSchema>;
export type BulkPreparationSheet={orderId:string;instructionVersion:number|null;sourceRound:number|null;customerConfirmed:boolean;ownerApproved:boolean;instructionValid:boolean;reasons:string[];preparationId:string|null;preshrink:string|null;dispatch:{version:number;patternWorkerId:string|null;warehouseWorkerId:string|null;cuttingWorkerId:string|null};canDispatchPattern:boolean;canDispatchWarehouse:boolean;facts:Array<{kind:string;recordedAt:string}>;tasks:DigitalTask[]};
