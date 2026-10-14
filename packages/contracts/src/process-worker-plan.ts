import { validationFieldLabel } from "./validation-language.js";
import { z } from "zod";

import { BusinessPersonIdSchema } from "./business-person-id.js";

const IdSchema = z.string().uuid();
const ReworkStatusSchema = z.enum([
  "draft",
  "pending_process_configuration",
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_final_quantity_ie_review",
  "pending_quantity_adjustment_ie_review",
  "pending_responsibility_determination",
  "pending_owner_signature",
  "pending_responsibility_action",
  "completed",
  "cancelled",
  "deleted",
]);

const ProcessWorkerAssignmentSchema = z.object({
  configurationItemId: IdSchema,
  memberIds: z.array(BusinessPersonIdSchema).min(1).max(40),
}).strict().superRefine((value, context) => {
  if (new Set(value.memberIds).size !== value.memberIds.length) {
    context.addIssue({ code: "custom", path: ["memberIds"], message: `${validationFieldLabel(["memberIds"])}：工人不能重复选择` });
  }
});

export const SaveProcessWorkerPlanSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  configurationId: IdSchema,
  expectedConfigurationVersion: z.number().int().positive(),
  assignments: z.array(ProcessWorkerAssignmentSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const itemIds = value.assignments.map((item) => item.configurationItemId);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({ code: "custom", path: ["assignments"], message: `${validationFieldLabel(["assignments"])}：每道工序只能分派一次` });
  }
});

export const ActivateProcessWorkerPlanSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedConfigurationVersion: z.number().int().positive(),
}).strict();

export const ProcessWorkerPlanMemberSchema = z.object({
  personId: BusinessPersonIdSchema,
  displayName: z.string().min(1),
  personType: z.enum(["internal", "temporary"]),
}).strict();

export const ProcessWorkerPlanAssignmentSchema = z.object({
  configurationItemId: IdSchema,
  processName: z.string().min(1),
  executionKind: z.enum(["worker", "tail_inspection"]).optional().default("worker"),
  members: z.array(ProcessWorkerPlanMemberSchema),
}).strict();

export const ProcessWorkerPlanResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: ReworkStatusSchema,
  orderVersion: z.number().int().positive(),
  required: z.boolean(),
  configurationId: IdSchema.nullable(),
  configurationVersion: z.number().int().positive().nullable(),
  configurationStatus: z.enum(["draft", "pending_ie_review", "approved", "rejected", "superseded"]).nullable(),
  assignments: z.array(ProcessWorkerPlanAssignmentSchema),
  complete: z.boolean(),
}).strict();

export const ProcessWorkerPlanActivationResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: z.literal("in_progress"),
  orderVersion: z.number().int().positive(),
  tasksCreated: z.number().int().nonnegative(),
}).strict();

export type SaveProcessWorkerPlan = z.infer<typeof SaveProcessWorkerPlanSchema>;
export type ActivateProcessWorkerPlan = z.infer<typeof ActivateProcessWorkerPlanSchema>;
export type ProcessWorkerPlanResponse = z.infer<typeof ProcessWorkerPlanResponseSchema>;
export type ProcessWorkerPlanActivationResponse = z.infer<typeof ProcessWorkerPlanActivationResponseSchema>;
