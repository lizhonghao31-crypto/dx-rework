import { z } from "zod";

const TodoIdSchema = z.string().uuid();

export const TodoRouteDescriptorSchema = z.object({
  routeName: z.enum([
    "rework_detail",
    "process_configuration",
    "whole_order_review",
    "responsibility_detail",
    "own_factory_approval",
    "external_responsibility_detail",
    "wage_period_detail",
  ]),
  entityId: TodoIdSchema,
  /** External-responsibility routes name a case but open in its rework order. */
  reworkOrderId: TodoIdSchema.optional(),
  todoId: TodoIdSchema,
  tab: z.enum([
    "process_configuration",
    "whole_order_review",
    "responsibility",
    "own_factory_approval",
    "external_responsibility",
    "wages",
  ]).optional(),
}).strict();

export const TodoPolicyKeySchema = z.enum([
  "general",
  "finance_return_or_wage_review",
  "deduction_follow_up",
]);
export const TodoStatusSchema = z.enum([
  "pending",
  "blocked_recipient",
  "completed",
  "cancelled",
]);
export const TodoTypeSchema = z.enum([
  "business_action",
  "information",
  "recipient_routing_exception",
]);

export const TodoPolicySchema = z.object({
  policyKey: TodoPolicyKeySchema,
  dueAfterSeconds: z.number().int().positive().nullable(),
  firstReminderAfterDueSeconds: z.number().int().nonnegative().nullable(),
  secondReminderAfterDueSeconds: z.number().int().positive().nullable(),
  escalateAfterDueSeconds: z.number().int().positive().nullable(),
  maxReminders: z.number().int().min(0).max(2),
  enabled: z.boolean(),
}).strict();

export const TodoOrderContextSchema = z.object({
  reworkNo: z.string().nullable(),
  orderNo: z.string().nullable(),
  styleNo: z.string().nullable(),
  status: z.string().min(1),
  updatedAt: z.string().datetime(),
}).strict();

export const TodoResponseSchema = z.object({
  todoId: TodoIdSchema,
  todoType: TodoTypeSchema,
  category: z.string().min(1).max(120),
  sourceEventId: TodoIdSchema,
  sourceAction: z.string().min(1).max(128),
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  recipientUserId: TodoIdSchema,
  requiredRole: z.string().nullable(),
  requiredCapability: z.string().nullable(),
  route: TodoRouteDescriptorSchema,
  policyKey: TodoPolicyKeySchema.nullable(),
  dueAt: z.string().datetime().nullable(),
  reminderCount: z.number().int().min(0).max(2),
  status: TodoStatusSchema,
  blockedReason: z.string().nullable(),
  /** Present when the action is attached to a single rework order. */
  orderContext: TodoOrderContextSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const TodoDeliveryAttemptSchema = z.object({
  deliveryAttemptId: TodoIdSchema,
  todoId: TodoIdSchema,
  messageOutboxEventId: TodoIdSchema,
  // Zero is the durable enqueue intent; provider calls begin at attempt one.
  attemptNo: z.number().int().min(0),
  deliveryKind: z.enum(["create", "reminder", "escalation", "information"]),
  provider: z.literal("dingtalk"),
  outcome: z.enum(["queued", "sent", "failed", "unknown_response"]),
  providerMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  attemptedAt: z.string().datetime(),
}).strict();

export const TodoRoutingExceptionSchema = z.object({
  routingExceptionId: TodoIdSchema,
  todoId: TodoIdSchema,
  routingTodoId: TodoIdSchema,
  originalRecipientUserId: TodoIdSchema,
  assignedToUserId: TodoIdSchema,
  status: z.enum(["pending", "resolved", "cancelled"]),
  reason: z.string().min(1).max(500),
  resolutionReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const TodoListResponseSchema = z.object({
  todos: z.array(TodoResponseSchema),
}).strict();

export const TodoRoutingExceptionListResponseSchema = z.object({
  routingExceptions: z.array(TodoRoutingExceptionSchema),
}).strict();

export const TodoRoutingExceptionParamsSchema = z.object({
  routingExceptionId: TodoIdSchema,
}).strict();

export const TransferTodoRoutingExceptionSchema = z.object({
  recipientUserId: TodoIdSchema,
  delegationId: TodoIdSchema.optional(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export type TodoRouteDescriptor = z.infer<typeof TodoRouteDescriptorSchema>;
export type TodoPolicy = z.infer<typeof TodoPolicySchema>;
export type TodoOrderContext = z.infer<typeof TodoOrderContextSchema>;
export type TodoResponse = z.infer<typeof TodoResponseSchema>;
export type TodoDeliveryAttempt = z.infer<typeof TodoDeliveryAttemptSchema>;
export type TodoRoutingException = z.infer<typeof TodoRoutingExceptionSchema>;
export type TodoListResponse = z.infer<typeof TodoListResponseSchema>;
export type TodoRoutingExceptionListResponse = z.infer<typeof TodoRoutingExceptionListResponseSchema>;
export type TransferTodoRoutingException = z.infer<typeof TransferTodoRoutingExceptionSchema>;
