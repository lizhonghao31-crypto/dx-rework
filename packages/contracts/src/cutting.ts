import { z } from "zod";

export const CUTTING_VIEW_ROLES = [
  "cutting_supervisor",
  "cutting_worker",
  "owner_group",
  "production_management",
  "order_merchandiser",
] as const;

export const CUTTING_RECORD_ROLES = [
  "cutting_supervisor",
  "cutting_worker",
] as const;

export const CuttingProcessSchema = z.enum(["in_house", "outsourced", "other"]);

export const CuttingSourceOrderSchema = z.object({
  cuttingOrderId: z.string().uuid(),
  sourcingCaseId: z.string().uuid(),
  sourcePosition: z.number().int().min(1).max(20),
  formalStyleNo: z.string().min(1).max(100).nullable(),
  alternateStyleNo: z.string().min(1).max(100).nullable(),
  displayStyleNo: z.string().min(1).max(100),
  styleName: z.string().min(1).max(100).nullable(),
  gender: z.enum(["男装", "女装"]).nullable(),
  color: z.string().min(1).max(100).nullable(),
  contractQuantity: z.number().int().positive().max(10_000_000),
  supplierId: z.string().uuid(),
  supplierName: z.string().min(1),
  merchandiserId: z.string().uuid(),
  merchandiserName: z.string().min(1),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  cuttingProcess: CuttingProcessSchema.nullable(),
  cuttingProcessOther: z.string().min(1).max(100).nullable(),
  approvedAt: z.string().datetime(),
}).strict();

export const CuttingSourceListResponseSchema = z.object({
  items: z.array(CuttingSourceOrderSchema),
}).strict();

export type CuttingSourceOrder = z.infer<typeof CuttingSourceOrderSchema>;
export type CuttingSourceListResponse = z.infer<typeof CuttingSourceListResponseSchema>;
