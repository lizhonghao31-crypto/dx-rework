import { z } from "zod";

const Id = z.string().uuid();
const Money = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const Version = z.number().int().positive();
const Reason = z.string().trim().min(1).max(500);

export const WagePeriodStatusSchema = z.enum(["pending_tail_review", "pending_admin_review", "ready_to_lock", "locked"]);
export const WagePeriodParamsSchema = z.object({ periodId: Id }).strict();
export const WageItemParamsSchema = z.object({ wageItemId: Id }).strict();
export const WageAdjustmentParamsSchema = z.object({ adjustmentId: Id }).strict();
export const ExpectedWagePeriodVersionSchema = z.object({ expectedVersion: Version }).strict();
export const AdministrativeReturnSchema = z.object({ expectedVersion: Version, reason: Reason }).strict();
export const LockWagePeriodSchema = z.object({ expectedVersion: Version, lockNote: z.string().trim().min(1).max(500).nullable().default(null) }).strict();
export const CreateWageAdjustmentSchema = z.object({
  originalWageItemId: Id,
  targetPeriodId: Id,
  adjustmentAmount: Money.refine((value) => value !== "0.00" && value !== "-0.00"),
  reason: Reason,
  attachmentIds: z.array(Id).max(20).default([]),
  expectedVersion: Version,
}).strict();
export const DecideWageAdjustmentSchema = z.object({ expectedVersion: Version, reason: z.string().trim().max(500).nullable().default(null) }).strict();
export const RejectWageAdjustmentSchema = z.object({ expectedVersion: Version, reason: Reason }).strict();

export type ExpectedWagePeriodVersion = z.infer<typeof ExpectedWagePeriodVersionSchema>;
export type AdministrativeReturn = z.infer<typeof AdministrativeReturnSchema>;
export type LockWagePeriod = z.infer<typeof LockWagePeriodSchema>;
export type CreateWageAdjustment = z.infer<typeof CreateWageAdjustmentSchema>;
export type DecideWageAdjustment = z.infer<typeof DecideWageAdjustmentSchema>;
export type RejectWageAdjustment = z.infer<typeof RejectWageAdjustmentSchema>;

export type WagePeriod = Readonly<{
  periodId: string; periodMonth: string; timezone: "Asia/Singapore"; status: z.infer<typeof WagePeriodStatusSchema>;
  periodVersion: number; personCount: number; sourceItemCount: number; originalTotal: string; adjustmentTotal: string;
  finalTotal: string; lockedBy: string | null; lockedAt: string | null; lockNote: string | null;
}>;

export type WageItem = Readonly<{
  wageItemId: string; periodId: string; workReportId: string; personId: string; personNameSnapshot: string;
  personTypeSnapshot: "internal" | "temporary"; processNameSnapshot: string; pricingUnitSnapshot: "piece" | "hour";
  unitPriceSnapshot: string; actualQuantitySnapshot: string; assignmentMode: "individual" | "collective";
  groupAmount: string; exactPersonShare: string; payableAmount: string; fractionalRemainder: string;
  remainderRank: number; memberCount: number; memberSnapshot: unknown;
}>;

export type LargestRemainderMember = Readonly<{ personId: string; exactAmount: string }>;
export type LargestRemainderAllocation = LargestRemainderMember & Readonly<{ payableAmount: string; fractionalRemainder: string; remainderRank: number }>;
