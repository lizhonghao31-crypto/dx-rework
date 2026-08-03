import { z } from "zod";

const Id = z.string().uuid();
const Version = z.number().int().positive();
const Money = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const Decimal3 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{3}$/);
const Decimal8 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{8}$/);
const Quantity = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const Reason = z.string().trim().min(1).max(500);

export const WagePeriodStatusSchema = z.enum([
  "pending_tail_review",
  "pending_admin_review",
  "ready_to_lock",
  "locked",
]);
export type WagePeriodStatus = z.infer<typeof WagePeriodStatusSchema>;

export const WageAdjustmentStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);

export const WagePeriodParamsSchema = z.object({ periodId: Id }).strict();
export const WageItemParamsSchema = z.object({ wageItemId: Id }).strict();
export const WageAdjustmentParamsSchema = z
  .object({ adjustmentId: Id })
  .strict();

export const ExpectedWagePeriodVersionSchema = z
  .object({ expectedVersion: Version })
  .strict();
export const AdministrativeReturnSchema = z
  .object({ expectedVersion: Version, reason: Reason })
  .strict();
export const LockWagePeriodSchema = z
  .object({
    expectedVersion: Version,
    lockNote: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();
export const CreateWageAdjustmentSchema = z
  .object({
    originalWageItemId: Id,
    targetPeriodId: Id,
    adjustmentAmount: Money.refine(
      (value) => value !== "0.00" && value !== "-0.00",
    ),
    reason: Reason,
    attachmentIds: z.array(Id).max(20).default([]),
    expectedVersion: Version,
  })
  .strict();
export const DecideWageAdjustmentSchema = z
  .object({
    expectedVersion: Version,
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();
export const RejectWageAdjustmentSchema = z
  .object({ expectedVersion: Version, reason: Reason })
  .strict();

export type CreateWageAdjustment = z.infer<
  typeof CreateWageAdjustmentSchema
>;

export const WagePeriodSchema = z.object({
  periodId: Id,
  periodMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  timezone: z.literal("Asia/Singapore"),
  status: WagePeriodStatusSchema,
  periodVersion: Version,
  sourceItemCount: z.number().int().nonnegative(),
  personCount: z.number().int().nonnegative(),
  originalTotal: Money,
  adjustmentTotal: Money,
  finalTotal: Money,
  lockedBy: Id.nullable(),
  lockedAt: z.string().datetime().nullable(),
  lockNote: z.string().nullable(),
  canTailReview: z.boolean(),
  canAdministrativeReview: z.boolean(),
  canLock: z.boolean(),
  canRequestAdjustment: z.boolean(),
  canApproveAdjustment: z.boolean(),
  canExport: z.boolean(),
});
export type WagePeriod = z.infer<typeof WagePeriodSchema>;

export const WageItemSchema = z.object({
  wageItemId: Id,
  periodId: Id,
  orderReviewId: Id,
  reworkOrderId: Id,
  configurationItemId: Id,
  workTaskId: Id,
  workReportId: Id,
  personId: Id,
  personNameSnapshot: z.string(),
  personTypeSnapshot: z.enum(["internal", "temporary"]),
  reworkNoSnapshot: z.string(),
  styleNoSnapshot: z.string(),
  processNameSnapshot: z.string(),
  pricingUnitSnapshot: z.enum(["piece", "hour"]),
  unitPriceSnapshot: Decimal3,
  actualQuantitySnapshot: Quantity,
  assignmentMode: z.enum(["individual", "collective"]),
  groupAmount: Decimal8,
  exactPersonShare: Decimal8,
  payableAmount: Money,
  fractionalRemainder: Decimal8,
  remainderRank: z.number().int().positive(),
  memberCount: z.number().int().positive(),
  memberSnapshot: z.array(
    z.object({
      personId: Id,
      displayName: z.string(),
      personType: z.enum(["internal", "temporary"]),
    }),
  ),
});
export type WageItem = z.infer<typeof WageItemSchema>;

export const WageReviewActionSchema = z.object({
  reviewActionId: Id,
  periodId: Id,
  periodVersionSnapshot: Version,
  stage: z.enum(["tail", "administrative"]),
  decision: z.enum(["approved", "returned"]),
  reason: z.string().nullable(),
  actedBy: Id,
  actorRoleSnapshot: z.enum(["tail_supervisor", "administrative_clerk"]),
  actedAt: z.string().datetime(),
});

export const WageAdjustmentSchema = z.object({
  adjustmentId: Id,
  originalWageItemId: Id,
  targetPeriodId: Id,
  personId: Id,
  adjustmentAmount: Money,
  reason: z.string(),
  attachmentIds: z.array(Id),
  status: WageAdjustmentStatusSchema,
  requestedBy: Id,
  requestedAt: z.string().datetime(),
  decidedBy: Id.nullable(),
  decidedAt: z.string().datetime().nullable(),
  decisionReason: z.string().nullable(),
  version: Version,
});
export type WageAdjustment = z.infer<typeof WageAdjustmentSchema>;

export const WagePeriodDetailSchema = z.object({
  period: WagePeriodSchema,
  items: z.array(WageItemSchema),
  adjustments: z.array(WageAdjustmentSchema),
  reviewActions: z.array(WageReviewActionSchema),
});
export type WagePeriodDetail = z.infer<typeof WagePeriodDetailSchema>;

export const WageAdjustmentDecisionResponseSchema = z.object({
  adjustmentId: Id,
  status: WageAdjustmentStatusSchema,
  version: Version,
});

export const WageMonthCloseResponseSchema = z.object({
  closureId: Id,
  periodId: Id,
  status: z.literal("locked"),
  periodVersion: Version,
});

export type LargestRemainderMember = Readonly<{
  personId: string;
  exactAmount: string;
}>;
export type LargestRemainderAllocation = LargestRemainderMember &
  Readonly<{
    payableAmount: string;
    fractionalRemainder: string;
    remainderRank: number;
  }>;
