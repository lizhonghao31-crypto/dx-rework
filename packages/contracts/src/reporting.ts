import { z } from "zod";

import { BUSINESS_TIME_ZONE } from "./business-display.js";

const IdSchema = z.string().uuid();
const MoneySchema = z.string().regex(/^-?\d+\.\d{2}$/);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DateTimeSchema = z.string().datetime();

export const ReportTypeSchema = z.enum([
  "rework_overview",
  "wages",
  "responsibilities",
  "own_factory",
  "external_deductions",
  "exceptions",
]);

export const ReportTypeParamsSchema = z.object({ reportType: ReportTypeSchema }).strict();

export const ReportingReworkStatusSchema = z.enum([
  "draft",
  "pending_process_configuration",
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_quantity_adjustment_ie_review",
  "pending_responsibility_determination",
  "pending_owner_signature",
  "pending_responsibility_action",
  "completed",
  "cancelled",
]);

export const DashboardQuerySchema = z.object({
  from: DateSchema.optional(),
  to: DateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: "custom", path: ["to"], message: "to must not be earlier than from" });
  }
});

export const ManagementReworkQuerySchema = DashboardQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: ReportingReworkStatusSchema.optional(),
  responsibilityType: z.enum([
    "own_factory",
    "processing_factory",
    "embroidery_factory",
    "washing_factory",
    "fabric_supplier",
  ]).optional(),
  currentHandlerUserId: IdSchema.optional(),
  supplierId: IdSchema.optional(),
  overdue: z.enum(["true", "false"]).optional(),
  exception: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,500}$/).optional(),
}).strict();

export const ReportQuerySchema = DashboardQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

export const DashboardNodeSchema = z.object({
  node: z.string().min(1),
  label: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict();

export const DashboardFinancialSummarySchema = z.object({
  wageTotal: MoneySchema,
  responsibilityTotal: MoneySchema,
  ownFactoryTotal: MoneySchema,
  externalProposed: MoneySchema,
  externalDeducted: MoneySchema,
  externalRemaining: MoneySchema,
}).strict();

export const DashboardExceptionSchema = z.object({
  exceptionType: z.enum([
    "overdue_todo",
    "blocked_recipient",
    "todo_delivery_failed",
    "deduction_follow_up_overdue",
  ]),
  entityId: z.string().min(1),
  reworkOrderId: IdSchema.nullable(),
  label: z.string().min(1),
  occurredAt: DateTimeSchema,
  deepLink: z.string().startsWith("/"),
}).strict();

export const ManagementReworkRowSchema = z.object({
  reworkOrderId: IdSchema,
  reworkNo: z.string().nullable(),
  styleNo: z.string().nullable(),
  orderNo: z.string().nullable(),
  status: ReportingReworkStatusSchema,
  node: z.string().min(1),
  nodeLabel: z.string().min(1),
  nodeEnteredAt: DateTimeSchema,
  agingSeconds: z.number().int().nonnegative(),
  currentHandlerUserId: IdSchema.nullable(),
  plannedQuantity: z.string().nullable(),
  reportedQuantity: z.string(),
  wageAmount: MoneySchema,
  responsibilityAmount: MoneySchema,
  ownFactoryAmount: MoneySchema,
  externalProposedAmount: MoneySchema,
  externalDeductedAmount: MoneySchema,
  externalRemainingAmount: MoneySchema,
  overdue: z.boolean(),
  exceptionCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  deepLink: z.string().startsWith("/"),
  updatedAt: DateTimeSchema,
}).strict();

export const ManagementDashboardResponseSchema = z.object({
  mode: z.literal("management"),
  asOf: DateTimeSchema,
  range: z.object({ from: DateSchema, to: DateSchema, timezone: z.literal(BUSINESS_TIME_ZONE) }).strict(),
  kpis: z.object({
    openOrders: z.number().int().nonnegative(),
    completedOrders: z.number().int().nonnegative(),
    overdueTodos: z.number().int().nonnegative(),
    exceptionCount: z.number().int().nonnegative(),
  }).strict(),
  nodeCounts: z.array(DashboardNodeSchema),
  financial: DashboardFinancialSummarySchema,
  exceptions: z.array(DashboardExceptionSchema),
  recentOrders: z.array(ManagementReworkRowSchema),
  availableActions: z.array(z.enum([
    "view_rework",
    "determine_responsibility",
    "approve_own_factory",
    "manage_external_responsibility",
    "review_wages",
    "export_reports",
  ])),
}).strict();

export const SiteDashboardResponseSchema = z.object({
  mode: z.literal("site"),
  asOf: DateTimeSchema,
  range: z.object({ from: DateSchema, to: DateSchema, timezone: z.literal(BUSINESS_TIME_ZONE) }).strict(),
  kpis: z.object({
    pendingConfiguration: z.number().int().nonnegative(),
    pendingAssignment: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    pendingOrderReview: z.number().int().nonnegative(),
    pendingWageReview: z.number().int().nonnegative(),
    siteExceptions: z.number().int().nonnegative(),
  }).strict(),
  nodeCounts: z.array(DashboardNodeSchema),
  recentOrders: z.array(ManagementReworkRowSchema),
  availableActions: z.array(z.enum([
    "configure_process",
    "assign_work",
    "review_order",
    "review_wages",
    "export_reports",
  ])),
}).strict();

export const ManagementReworkPageSchema = z.object({
  asOf: DateTimeSchema,
  items: z.array(ManagementReworkRowSchema),
  nextCursor: z.string().nullable(),
  canViewReports: z.boolean(),
}).strict();

const ReportCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ReportPreviewResponseSchema = z.object({
  reportType: ReportTypeSchema,
  asOf: DateTimeSchema,
  range: z.object({ from: DateSchema, to: DateSchema, timezone: z.literal(BUSINESS_TIME_ZONE) }).strict(),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  canExport: z.boolean(),
  totals: z.record(z.string(), z.string()),
  columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) }).strict()),
  rows: z.array(z.record(z.string(), ReportCellSchema)),
}).strict();

export type ReportType = z.infer<typeof ReportTypeSchema>;
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;
export type ManagementReworkQuery = z.infer<typeof ManagementReworkQuerySchema>;
export type ReportQuery = z.infer<typeof ReportQuerySchema>;
export type ManagementReworkRow = z.infer<typeof ManagementReworkRowSchema>;
export type ManagementDashboardResponse = z.infer<typeof ManagementDashboardResponseSchema>;
export type SiteDashboardResponse = z.infer<typeof SiteDashboardResponseSchema>;
export type ManagementReworkPage = z.infer<typeof ManagementReworkPageSchema>;
export type ReportPreviewResponse = z.infer<typeof ReportPreviewResponseSchema>;
