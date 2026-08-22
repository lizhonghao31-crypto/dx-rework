import { z } from "zod";

import { BusinessPersonIdSchema } from "./business-person-id.js";
import {
  WholeOrderReviewResponseSchema as BaseWholeOrderReviewResponseSchema,
  type WholeOrderReviewResponse as BaseWholeOrderReviewResponse,
} from "./compat-index.js";

const IdSchema = z.string().uuid();
const QuantitySchema = z.number().positive().multipleOf(0.01);
const CompletionStatusSchema = z.enum([
  "draft",
  "pending_process_configuration",
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_quantity_adjustment_ie_review",
  "pending_completion_ie_review",
  "pending_responsibility_determination",
  "pending_owner_signature",
  "pending_responsibility_action",
  "completed",
  "cancelled",
  "deleted",
]);

export const FinalCompletionQuantitySchema = z.object({
  configurationItemId: IdSchema,
  finalConfirmedQuantity: QuantitySchema,
}).strict();

export const CompletionTemporaryCoefficientSchema = z.object({
  configurationItemId: IdSchema,
  personId: BusinessPersonIdSchema,
  multiplier: z.number().positive().max(10).multipleOf(0.001),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.multiplier !== 1 && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "倍率不是 1.0 时必须填写原因" });
  }
});

export const CreateCompletionConfirmationSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  finalQuantities: z.array(FinalCompletionQuantitySchema).min(1).max(100),
  temporaryCoefficients: z.array(CompletionTemporaryCoefficientSchema).max(400).default([]),
}).strict().superRefine((value, context) => {
  const processIds = value.finalQuantities.map((item) => item.configurationItemId);
  if (new Set(processIds).size !== processIds.length) {
    context.addIssue({ code: "custom", path: ["finalQuantities"], message: "每道工序只能确认一次最终数量" });
  }
  const coefficientKeys = value.temporaryCoefficients.map((item) => `${item.configurationItemId}:${item.personId}`);
  if (new Set(coefficientKeys).size !== coefficientKeys.length) {
    context.addIssue({ code: "custom", path: ["temporaryCoefficients"], message: "临时工倍率不能重复" });
  }
});

export const ReviewCompletionIeSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const CompletionConfirmationMutationResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: z.literal("pending_completion_ie_review"),
  orderVersion: z.number().int().positive(),
  confirmationId: IdSchema,
  confirmationVersion: z.number().int().positive(),
}).strict();

export const CompletionIeReviewMutationResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: z.enum(["pending_order_review", "pending_responsibility_determination"]),
  orderVersion: z.number().int().positive(),
  confirmationId: IdSchema,
  ieReviewId: IdSchema,
  decision: z.enum(["approved", "rejected"]),
}).strict();

export const CompletionConfirmationProcessSchema = z.object({
  configurationItemId: IdSchema,
  processName: z.string().min(1),
  workerReportedQuantity: z.number().nonnegative(),
  tailCheckedQuantity: z.number().nonnegative(),
  originalQuantity: z.number().positive(),
  finalConfirmedQuantity: z.number().positive(),
  modified: z.boolean(),
  modifiedBy: IdSchema.nullable(),
  modifiedAt: z.string().datetime().nullable(),
}).strict();

export const CompletionConfirmationSummarySchema = z.object({
  confirmationId: IdSchema,
  confirmationVersion: z.number().int().positive(),
  confirmedBy: IdSchema,
  confirmedAt: z.string().datetime(),
  processes: z.array(CompletionConfirmationProcessSchema),
  ieReview: z.object({
    ieReviewId: IdSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().nullable(),
    reviewedBy: IdSchema,
    reviewedAt: z.string().datetime(),
  }).strict().nullable(),
}).strict();

export type CompletionReviewResponse = Omit<BaseWholeOrderReviewResponse, "reworkStatus"> & Readonly<{
  reworkStatus: z.infer<typeof CompletionStatusSchema>;
  canCompletionIeReview: boolean;
  completionConfirmation: z.infer<typeof CompletionConfirmationSummarySchema> | null;
}>;

const parseFailure = (
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): never => {
  context.addIssue({ code: "custom", path: [...path], message });
  return z.NEVER as never;
};

export const CompletionReviewResponseSchema = z.unknown().transform((value, context): CompletionReviewResponse => {
  if (!value || typeof value !== "object") {
    return parseFailure(context, [], "Expected completion review response object");
  }
  const input = value as Record<string, unknown>;
  const status = CompletionStatusSchema.safeParse(input.reworkStatus);
  if (!status.success) {
    return parseFailure(context, ["reworkStatus"], "Invalid completion review status");
  }
  const masked = status.data === "pending_completion_ie_review"
    ? { ...input, reworkStatus: "pending_order_review" }
    : input;
  const base = BaseWholeOrderReviewResponseSchema.safeParse(masked);
  if (!base.success) {
    return parseFailure(context, [], "Invalid whole-order review response");
  }
  const canCompletionIeReview = z.boolean().safeParse(input.canCompletionIeReview ?? false);
  if (!canCompletionIeReview.success) {
    return parseFailure(context, ["canCompletionIeReview"], "Invalid IE completion review permission");
  }
  const confirmation = z.union([CompletionConfirmationSummarySchema, z.null()]).safeParse(input.completionConfirmation ?? null);
  if (!confirmation.success) {
    return parseFailure(context, ["completionConfirmation"], "Invalid completion confirmation summary");
  }
  return {
    ...base.data,
    reworkStatus: status.data,
    canCompletionIeReview: canCompletionIeReview.data,
    completionConfirmation: confirmation.data,
  } as CompletionReviewResponse;
});

export type CreateCompletionConfirmation = z.infer<typeof CreateCompletionConfirmationSchema>;
export type ReviewCompletionIe = z.infer<typeof ReviewCompletionIeSchema>;
export type CompletionConfirmationMutationResponse = z.infer<typeof CompletionConfirmationMutationResponseSchema>;
export type CompletionIeReviewMutationResponse = z.infer<typeof CompletionIeReviewMutationResponseSchema>;
