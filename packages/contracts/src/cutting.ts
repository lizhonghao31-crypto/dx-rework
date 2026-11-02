import { z } from "zod";

export const CUTTING_VIEW_ROLES = [
  "cutting_supervisor",
  "cutting_worker",
  "owner_group",
  "production_management",
  "pmc",
  "order_merchandiser",
  "warehouse_supervisor",
] as const;
export const CUTTING_RECORD_ROLES = ["cutting_supervisor", "cutting_worker"] as const;
export const CUTTING_CAPABILITY_ROLES = {
  "cutting:orders:view": CUTTING_VIEW_ROLES,
  "cutting:records:create": CUTTING_RECORD_ROLES,
  "cutting:records:correct": ["root_superuser"] as const,
} as const;
export type CuttingCapability = keyof typeof CUTTING_CAPABILITY_ROLES;

export function canUseCutting(
  roles: readonly string[],
  capabilities: readonly string[],
  capability: CuttingCapability,
): boolean {
  return roles.includes("root_superuser")
    || (capabilities.includes(capability)
      && CUTTING_CAPABILITY_ROLES[capability].some((role) => roles.includes(role)));
}

export const CuttingProcessSchema = z.enum(["in_house", "outsourced", "other"]);
export const CuttingOrderStatusSchema = z.enum(["pending", "recorded"]);
export const CuttingCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MAX_CUTTING_SHEET_ATTACHMENTS = 3;

export function cuttingAllowedRange(contractQuantity: number): { min: number; max: number } {
  const quantity = BigInt(contractQuantity);
  return {
    min: Number((quantity * 95n + 99n) / 100n),
    max: Number((quantity * 105n) / 100n),
  };
}
export function cuttingOutOfRange(contractQuantity: number, actualCutCount: number): boolean {
  const contract = BigInt(contractQuantity);
  const actual = BigInt(actualCutCount);
  return actual * 100n < contract * 95n || actual * 100n > contract * 105n;
}
export function parseCuttingCountText(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export const CuttingOrderQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  status: z.enum(["all", "pending", "recorded"]).default("all"),
  outOfRange: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
}).strict();
export type CuttingOrderQuery = z.infer<typeof CuttingOrderQuerySchema>;

export const CuttingPhotoSchema = z.object({
  attachmentId: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict();

export const CuttingCorrectionSchema = z.object({
  version: z.number().int().min(2),
  pieceCount: CuttingCountSchema,
  actualCutCount: CuttingCountSchema,
  reason: z.string().min(1).max(500),
  correctedBy: z.string().uuid(),
  correctedByName: z.string().min(1),
  correctedAt: z.string().datetime(),
}).strict();

export const CuttingRecordSchema = z.object({
  cuttingRecordId: z.string().uuid(),
  version: z.number().int().positive(),
  pieceCount: CuttingCountSchema,
  actualCutCount: CuttingCountSchema,
  initialPieceCount: CuttingCountSchema,
  initialActualCutCount: CuttingCountSchema,
  recordedBy: z.string().uuid(),
  recordedByName: z.string().min(1),
  recordedAt: z.string().datetime(),
  corrected: z.boolean(),
  cuttingSheetPhotos: z.array(CuttingPhotoSchema).max(MAX_CUTTING_SHEET_ATTACHMENTS),
  corrections: z.array(CuttingCorrectionSchema),
}).strict();

export const CuttingOrderListItemSchema = z.object({
  cuttingOrderId: z.string().uuid(),
  sourcingCaseId: z.string().uuid(),
  sourcePosition: z.number().int().min(1).max(20),
  formalStyleNo: z.string().min(1).max(100).nullable(),
  alternateStyleNo: z.string().min(1).max(100).nullable(),
  displayStyleNo: z.string().min(1).max(100),
  styleName: z.string().min(1).max(100).nullable(),
  gender: z.enum(["男装", "女装"]).nullable(),
  color: z.string().min(1).max(100).nullable(),
  contractNumber: z.string().min(1).nullable(),
  contractQuantity: z.number().int().positive().max(10_000_000),
  supplierId: z.string().uuid(),
  supplierName: z.string().min(1),
  merchandiserId: z.string().uuid(),
  merchandiserName: z.string().min(1),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  cuttingProcess: CuttingProcessSchema.nullable(),
  cuttingProcessOther: z.string().min(1).max(100).nullable(),
  processes: z.array(z.string().min(1).max(100)),
  approvedAt: z.string().datetime(),
  status: CuttingOrderStatusSchema,
  pieceCount: CuttingCountSchema.nullable(),
  actualCutCount: CuttingCountSchema.nullable(),
  recordedByName: z.string().min(1).nullable(),
  recordedAt: z.string().datetime().nullable(),
  outOfRange: z.boolean().nullable(),
}).strict();

export const CuttingOrderListResponseSchema = z.object({
  items: z.array(CuttingOrderListItemSchema),
  page: z.number().int().positive(),
  totalPages: z.number().int().positive(),
  totalCount: z.number().int().min(0),
}).strict();

export const CuttingOrderDetailSchema = CuttingOrderListItemSchema.extend({
  allowedRange: z.object({
    min: z.number().int().min(0),
    max: z.number().int().min(0),
  }).strict(),
  photos: z.array(CuttingPhotoSchema),
  record: CuttingRecordSchema.nullable(),
  canRecord: z.boolean(),
  productionGate: z.object({orderId:z.string().uuid(),ready:z.boolean(),reason:z.string()}).optional(),
  canCorrect: z.boolean(),
}).strict();

export const CreateCuttingRecordSchema = z.object({
  pieceCount: CuttingCountSchema,
  actualCutCount: CuttingCountSchema,
  attachmentIds: z.array(z.string().uuid())
    .min(1, "请上传裁床单")
    .max(MAX_CUTTING_SHEET_ATTACHMENTS, "裁床单最多上传3张")
    .refine((ids) => new Set(ids).size === ids.length, "裁床单图片不能重复"),
}).strict();
export const CorrectCuttingRecordSchema = z.object({
  pieceCount: CuttingCountSchema,
  actualCutCount: CuttingCountSchema,
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
}).strict();
export const CuttingRecordMutationResponseSchema = z.object({
  outcome: z.enum(["created", "already_recorded", "corrected"]),
  item: CuttingOrderDetailSchema,
}).strict();

export type CuttingOrderListItem = z.infer<typeof CuttingOrderListItemSchema>;
export type CuttingOrderListResponse = z.infer<typeof CuttingOrderListResponseSchema>;
export type CuttingOrderDetail = z.infer<typeof CuttingOrderDetailSchema>;
export type CreateCuttingRecord = z.infer<typeof CreateCuttingRecordSchema>;
export type CorrectCuttingRecord = z.infer<typeof CorrectCuttingRecordSchema>;
export type CuttingRecordMutationResponse = z.infer<typeof CuttingRecordMutationResponseSchema>;
