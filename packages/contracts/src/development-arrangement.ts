import {z} from "zod";
import {TransferPatternOrderSchema,PatternWorkAmountSchema} from './pattern-orders.js';

/** Personnel planning uses existing route kinds; it is not a production node. */
export const DEVELOPMENT_ARRANGEABLE_KINDS = [
  "development_pattern", "development_cutting", "development_sewing",
  "development_printing", "development_embroidery", "development_print_embroidery",
  "development_tail_check", "development_washing_dispatch", "development_washing",
  "development_sewing_transfer",
] as const;
export const DevelopmentArrangementSchema = z.object({
  roundNumber:z.number().int().positive(),
  expectedDocumentVersion:z.number().int().positive(),
  expectedVersion:z.number().int().nonnegative(),
  entries:z.array(z.object({
    kind:z.enum(DEVELOPMENT_ARRANGEABLE_KINDS),
    assigneeId:z.string().uuid().nullable(),
    expectedTask:z.object({
      taskId:z.string().uuid(),state:z.string(),assigneeId:z.string().uuid().nullable(),
    }).strict().nullable(),
    reason:z.string().trim().max(1000),
  }).strict()).max(10),
  management:z.enum(["keep","takeover","release"]),
  managementReason:z.string().trim().max(1000),
}).strict().superRefine((value,ctx)=>{
  if(new Set(value.entries.map(row=>row.kind)).size!==value.entries.length)
    ctx.addIssue({code:"custom",path:["entries"],message:"同一工序不能重复安排"});
  if(value.management!=="keep"&&!value.managementReason)
    ctx.addIssue({code:"custom",path:["managementReason"],message:"请说明接管或交回原因"});
});
export type DevelopmentArrangementInput=z.infer<typeof DevelopmentArrangementSchema>;
export const DevelopmentExecutionTransferSchema=TransferPatternOrderSchema.omit({hours:true}).extend({
  orderId:z.string().uuid(),amount:PatternWorkAmountSchema,
  roundNumber:z.number().int().positive(),expectedDocumentVersion:z.number().int().positive(),expectedArrangementVersion:z.number().int().nonnegative(),
  expectedTask:z.object({taskId:z.string().uuid(),state:z.string(),assigneeId:z.string().uuid().nullable()}).strict().nullable(),
}).strict();
export type DevelopmentExecutionTransfer=z.infer<typeof DevelopmentExecutionTransferSchema>;
export type DevelopmentArrangementRow={
  kind:string;label:string;requiredRole:string;assigneeId:string|null;assigneeName:string|null;
  valid:boolean;taskId:string|null;state:string|null;editable:boolean;
};
export type DevelopmentArrangement={
  roundNumber:number;documentVersion:number;version:number;managerId:string|null;managerName:string|null;
  canEdit:boolean;canTakeOver:boolean;readyToArrange:boolean;unavailableReason?:string|null;rows:DevelopmentArrangementRow[];
};
