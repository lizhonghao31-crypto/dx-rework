import { z } from "zod";

export * from "./index.js";

import {
  CreateWorkTaskSchema as StrictCreateWorkTaskSchema,
  OwnFactoryApprovalResponseSchema as StrictOwnFactoryApprovalResponseSchema,
  PersonParamsSchema as StrictPersonParamsSchema,
  RejectWorkReportSchema as StrictRejectWorkReportSchema,
  ReviewWholeOrderSchema as StrictReviewWholeOrderSchema,
  ReworkOrderResponseSchema as StrictReworkOrderResponseSchema,
  ReworkWorkTasksResponseSchema as StrictReworkWorkTasksResponseSchema,
  TailInspectionOptionsResponseSchema as StrictTailInspectionOptionsResponseSchema,
  WholeOrderReviewResponseSchema as StrictWholeOrderReviewResponseSchema,
  WorkReportResponseSchema as StrictWorkReportResponseSchema,
  WorkTaskAssignablePeopleResponseSchema as StrictWorkTaskAssignablePeopleResponseSchema,
  WorkTaskMemberSchema as StrictWorkTaskMemberSchema,
  WorkTaskResponseSchema as StrictWorkTaskResponseSchema,
} from "./index.js";
import { businessPersonCompatibleSchema } from "./business-person-id.js";

export const ReworkOrderStatusSchema = z.enum([
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
export type ReworkOrderStatus = z.infer<typeof ReworkOrderStatusSchema>;

export const ReworkOrdersQuerySchema = z.object({
  status: ReworkOrderStatusSchema.optional(),
}).strict();

export const ReworkOrderResponseSchema = z.unknown().transform((value, context) => {
  if (!value || typeof value !== "object") {
    context.addIssue({ code: "custom", message: "Expected rework order response object" });
    return z.NEVER;
  }
  const source = value as Record<string, unknown>;
  const status = ReworkOrderStatusSchema.safeParse(source.status);
  if (!status.success) {
    context.addIssue({ code: "custom", path: ["status"], message: "Invalid rework order status" });
    return z.NEVER;
  }
  const masked = status.data === "pending_completion_ie_review"
    ? { ...source, status: "pending_order_review" }
    : source;
  const parsed = StrictReworkOrderResponseSchema.safeParse(masked);
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "Invalid rework order response" });
    return z.NEVER;
  }
  return { ...parsed.data, status: status.data };
});
export type ReworkOrderResponse = z.infer<typeof ReworkOrderResponseSchema>;

export const PersonParamsSchema = businessPersonCompatibleSchema(StrictPersonParamsSchema);
export const TailInspectionOptionsResponseSchema = businessPersonCompatibleSchema(StrictTailInspectionOptionsResponseSchema);
export const WorkTaskMemberSchema = businessPersonCompatibleSchema(StrictWorkTaskMemberSchema);
export const CreateWorkTaskSchema = businessPersonCompatibleSchema(StrictCreateWorkTaskSchema);
export const WorkTaskAssignablePeopleResponseSchema = businessPersonCompatibleSchema(StrictWorkTaskAssignablePeopleResponseSchema);
export const WorkTaskResponseSchema = businessPersonCompatibleSchema(StrictWorkTaskResponseSchema);
export const WorkReportResponseSchema = businessPersonCompatibleSchema(StrictWorkReportResponseSchema);
export const ReworkWorkTasksResponseSchema = businessPersonCompatibleSchema(StrictReworkWorkTasksResponseSchema);
export const RejectWorkReportSchema = businessPersonCompatibleSchema(StrictRejectWorkReportSchema);
export const ReviewWholeOrderSchema = businessPersonCompatibleSchema(StrictReviewWholeOrderSchema);
export const WholeOrderReviewResponseSchema = businessPersonCompatibleSchema(StrictWholeOrderReviewResponseSchema);
export const OwnFactoryApprovalResponseSchema = businessPersonCompatibleSchema(StrictOwnFactoryApprovalResponseSchema);
