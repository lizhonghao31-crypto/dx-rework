import { z } from "zod";

import { businessPersonCompatibleSchema } from "./business-person-id.js";

const Id = z.string().uuid();
const Version = z.number().int().positive();
const Money = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const Decimal3 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{3}$/);
const Decimal8 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{8}$/);
const Quantity = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);

export const WagePeriodStatusSchema = z.enum(["ready_to_lock", "locked"]);
export type WagePeriodStatus = z.infer<typeof WagePeriodStatusSchema>;

export const WagePeriodParamsSchema = z.object({ periodId: Id }).strict();
export const WageItemParamsSchema = z.object({ wageItemId: Id }).strict();

export const LockWagePeriodSchema = z
  .object({
    expectedVersion: Version,
    lockNote: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();

export const WagePeriodSchema = z.object({
  periodId: Id,
  periodMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  timezone: z.literal("Asia/Singapore"),
  status: WagePeriodStatusSchema,
  periodVersion: Version,
  sourceItemCount: z.number().int().nonnegative(),
  personCount: z.number().int().nonnegative(),
  totalAmount: Money,
  lockedBy: Id.nullable(),
  lockedAt: z.string().datetime().nullable(),
  lockNote: z.string().nullable(),
  canLock: z.boolean(),
  canExport: z.boolean(),
});
export type WagePeriod = z.infer<typeof WagePeriodSchema>;

export const WageItemSchema = businessPersonCompatibleSchema(z.object({
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
  supplierNameSnapshot: z.string(),
  temporaryWageMultiplier: Decimal3,
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
}));
export type WageItem = z.infer<typeof WageItemSchema>;

export const WagePeriodDetailSchema = z.object({
  period: WagePeriodSchema,
  items: z.array(WageItemSchema),
});
export type WagePeriodDetail = z.infer<typeof WagePeriodDetailSchema>;

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
