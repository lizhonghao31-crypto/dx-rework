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
    "sourcing_detail",
    "production_detail",
    "digital_production_task",
    "digital_production_closure",
    "digital_development",
    "digital_development_arrangement",
    "digital_short_lead",
    "digital_order_time",
    "digital_order_quotation",
    "digital_production_instruction",
    "digital_bulk_preparation",
    "digital_factory_progress",
    "sample_detail",
    "pattern_room_order",
    "supplier_onboarding",
  ]),
  entityId: TodoIdSchema,
  /** External-responsibility routes name a case but open in its rework order. */
  reworkOrderId: TodoIdSchema.optional(),
  todoId: TodoIdSchema,
  roundId: TodoIdSchema.optional(),
  developmentRound: z.number().int().positive().optional(),
  factoryDecisionId: TodoIdSchema.optional(),
  contractReturn: z.object({
    documentId: TodoIdSchema,version:z.number().int().positive(),supplierName:z.string().min(1),source:z.literal("price_reapplication"),
  }).strict().optional(),
  transferContract: z.object({
    documentId: TodoIdSchema, version: z.number().int().positive(), supplierName: z.string().min(1),
  }).strict().optional(),
  tab: z.enum([
    "contract_return",
    "process_configuration",
    "work_reporting",
    "tail_inspection",
    "whole_order_review",
    "final_quantity_ie_review",
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
  "sourcing_contract_return",
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
  supplierName: z.string().nullable(),
  merchandiserName: z.string().nullable().optional(),
  poNumbers: z.array(z.string().min(1)).optional(),
  status: z.string().min(1),
  updatedAt: z.string().datetime(),
}).strict();

export const TodoResponseSchema = z.object({
  todoId: TodoIdSchema,
  todoType: TodoTypeSchema,
  category: z.string().min(1).max(120),
  /** Digital node title, separate from its associated style identity. */
  taskTitle: z.string().min(1).max(200).optional(),
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
  timing:z.object({elapsedSeconds:z.number().int().nonnegative().nullable(),status:z.enum(["normal","warning","overdue","unknown","unlimited"]),asOf:z.iso.datetime(),warningAt:z.iso.datetime().nullable(),exclusive:z.boolean(),reason:z.string().nullable()}).strict().optional(),
  reminderCount: z.number().int().min(0).max(2),
  status: TodoStatusSchema,
  blockedReason: z.string().nullable(),
  /** Minimal identity of the action's associated business resource. */
  orderContext: TodoOrderContextSchema.nullable(),
  unread: z.boolean().optional(),
  /** Stable persisted content identity, independent of list query time. */
  contentToken:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  readAt:z.string().datetime().nullable().optional(),
  productionProgress: z.number().nonnegative().optional(),
  daysWithoutUpdate: z.number().int().nonnegative().nullable().optional(),
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

export const TodoModuleSchema = z.enum(["rework", "sourcing", "production", "samples", "pattern_room", "suppliers", "digital_production"]);

export const TodoModuleCountsSchema = z.object({
  rework: z.number().int().nonnegative(),
  sourcing: z.number().int().nonnegative(),
  production: z.number().int().nonnegative().optional(),
  samples: z.number().int().nonnegative().optional(),
  pattern_room: z.number().int().nonnegative().optional(),
  digital_production: z.number().int().nonnegative().optional(),
  suppliers: z.number().int().nonnegative().optional(),
}).strict();

export const TodoListResponseSchema = z.object({
  searchScope: z.literal("all").optional(),
  todos: z.array(TodoResponseSchema).max(15),
  activeModule: TodoModuleSchema,
  moduleCounts: TodoModuleCountsSchema,
  page: z.number().int().positive(),
  pageSize: z.literal(15),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).strict();

export const TodoMineParamsSchema = z.object({
  todoId: TodoIdSchema,
}).strict();

export const TodoCountIndicatorSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  unreadCount:z.number().int().nonnegative().optional(),
}).strict();

export const MarkTodoReadSchema=z.object({contentToken:z.string().regex(/^[a-f0-9]{64}$/),route:TodoRouteDescriptorSchema}).strict();
export const TodoReadReceiptSchema=z.object({read:z.literal(true),contentToken:z.string().regex(/^[a-f0-9]{64}$/),readAt:z.string().datetime()}).strict();

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
export type MarkTodoRead=z.infer<typeof MarkTodoReadSchema>;
export type TodoModule = z.infer<typeof TodoModuleSchema>;
export type TodoModuleCounts = z.infer<typeof TodoModuleCountsSchema>;
export type TodoDeliveryAttempt = z.infer<typeof TodoDeliveryAttemptSchema>;
export type TodoRoutingException = z.infer<typeof TodoRoutingExceptionSchema>;
export type TodoListResponse = z.infer<typeof TodoListResponseSchema>;
export type TodoCountIndicator = z.infer<typeof TodoCountIndicatorSchema>;
export type TodoRoutingExceptionListResponse = z.infer<typeof TodoRoutingExceptionListResponseSchema>;
export type TransferTodoRoutingException = z.infer<typeof TransferTodoRoutingExceptionSchema>;
