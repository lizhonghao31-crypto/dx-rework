import { z } from "zod";

/** UI/route hint only. Services must recheck the current direct role in PostgreSQL. */
export function hasFactoryPayablesReworkRead(roles: readonly string[] | undefined, capabilities: readonly string[]): boolean {
  return roles?.includes("factory_payables") === true && capabilities.includes("rework:finance_orders:read");
}
import { InspectionReportDraftSchema, TailInspectionResponseSchema, ReworkWorkTasksResponseSchema, ProcessConfigurationResponseSchema, WholeOrderReviewResponseSchema, ResponsibilityDeterminationResponseSchema } from "./compat-index.js";
import { ProcessWorkerPlanResponseSchema } from "./process-worker-plan.js";

import { BUSINESS_TIME_ZONE } from "./business-display.js";

export const LIST_PAGE_SIZE = 15;

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
  "pending_final_quantity_ie_review",
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
  reworkKind: z.enum(["qc_rework", "inhouse_finishing"]).optional(),
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
  page: z.coerce.number().int().min(1).max(100_000).default(1),
}).strict();

export const ReportQuerySchema = DashboardQuerySchema.extend({
  personType: z.enum(["internal", "temporary"]).optional(),
  wageSource: z.enum(["order_rework", "pattern_room"]).optional(),
  patternKind: z.enum(["first_pattern", "pattern_rework", "misc"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict().superRefine((value, context) => {
  if (value.patternKind && value.wageSource !== "pattern_room") context.addIssue({code:"custom",path:["patternKind"],message:"板房类型需要选择订单打板来源"});
});

export const WageReportPageQuerySchema = ReportQuerySchema.safeExtend({
  page:z.coerce.number().int().min(1).max(100_000),
});

export const DashboardNodeSchema = z.object({
  node: z.string().min(1),
  label: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict();

export const DashboardFinancialSummarySchema = z.object({
  wageTotal: MoneySchema.optional(),
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

export const FinanceNodeKeySchema = z.enum(["initiation","process_configuration","ie_review","task_assignment","work_reporting","whole_order_review","final_quantity_ie_review","quantity_adjustment","responsibility","owner_signature","settlement_ledger","settlement_followup"]);
export const FinanceNodeParamsSchema = z.object({reworkOrderId:IdSchema,node:FinanceNodeKeySchema}).strict();
export const FinanceNodeReadSchema = z.object({
  node:FinanceNodeKeySchema,
  sections:z.array(z.object({title:z.string(),columns:z.array(z.string()),rows:z.array(z.array(z.string().nullable()))}).strict()),
}).strict();
export type FinanceNodeKey = z.infer<typeof FinanceNodeKeySchema>;
export type FinanceNodeRead = z.infer<typeof FinanceNodeReadSchema>;

export const BasicReworkQuerySchema = z.object({
  q: z.string().trim().max(100).optional(), status: ReportingReworkStatusSchema.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict();
export const BasicReworkRowSchema = z.object({
  reworkOrderId: IdSchema, reworkNo: z.string().nullable(), styleNo: z.string().nullable(),
  orderNo: z.string().nullable(), processingFactory: z.string().nullable(), merchandiser: z.string().nullable(),
  quantity: z.string().nullable(), reason: z.string().nullable(), problemPart: z.string().nullable(),
  problemDescription: z.string().nullable(), status: ReportingReworkStatusSchema, nodeLabel: z.string(),
  photos: z.array(z.object({attachmentId: IdSchema, filename: z.string()}).strict()),
}).strict();
export const BasicReworkPageSchema = z.object({
  canOpenOrder: z.boolean().optional(),
  items: z.array(BasicReworkRowSchema), page: z.number().int().positive(),
  totalPages: z.number().int().positive(), totalCount: z.number().int().nonnegative(),
}).strict();
export type BasicReworkQuery = z.infer<typeof BasicReworkQuerySchema>;
export type BasicReworkPage = z.infer<typeof BasicReworkPageSchema>;

export const ManagementReworkRowSchema = z.object({
  reworkOrderId: IdSchema,
  reworkKind: z.enum(["qc_rework", "inhouse_finishing"]).default("qc_rework"),
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
  wageAmount: MoneySchema.optional(),
  responsibilityAmount: MoneySchema,
  ownFactoryAmount: MoneySchema,
  externalProposedAmount: MoneySchema,
  externalDeductedAmount: MoneySchema,
  externalRemainingAmount: MoneySchema,
  deductionStatus: z.enum(["not_started", "not_deducted", "completed"]),
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
    pendingWageReview: z.number().int().nonnegative().optional(),
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
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
  canViewReports: z.boolean(),
}).strict();

export const WageSettlementPreviewSchema = z.object({
  lineIds: z.array(IdSchema),
  personCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
}).strict();
export const WageSettlementRequestSchema = z.object({
  filters: ReportQuerySchema,
  lineIds: z.array(IdSchema).min(1).max(100_000),
}).strict();
export const WageSettlementResultSchema = z.object({ markedCount: z.number().int().nonnegative() }).strict();
export const WageReportSummarySchema = z.object({
  rowCount: z.number().int().nonnegative(),
  pendingLineCount: z.number().int().nonnegative(),
  pendingPersonCount: z.number().int().nonnegative(),
  personCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  roundCount: z.number().int().nonnegative(),
  people: z.array(z.object({
    personId: IdSchema, name: z.string(), orderCount: z.number().int().nonnegative(), amount: MoneySchema,
    lineCount: z.number().int().nonnegative(), roundCount: z.number().int().nonnegative(),
    sources: z.array(z.object({source:z.string(),kind:z.string(),amount:MoneySchema,lineCount:z.number().int().nonnegative()}).strict()),
  }).strict()),
}).strict();

const ReportCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ReportPreviewResponseSchema = z.object({
  reportType: ReportTypeSchema,
  asOf: DateTimeSchema,
  range: z.object({ from: DateSchema, to: DateSchema, timezone: z.literal(BUSINESS_TIME_ZONE) }).strict(),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  canExport: z.boolean(),
  canSettleWages: z.boolean().optional(),
  wageSummary: WageReportSummarySchema.optional(),
  pagination: z.object({page:z.number().int().positive(),pageSize:z.number().int().positive(),totalCount:z.number().int().nonnegative(),totalPages:z.number().int().positive()}).strict().optional(),
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

const ReworkHistoryEntrySchema = z.object({ id: z.string().uuid(), label: z.string(), at: z.string(), actor: z.string() }).strict();
export const ReworkNodeHistorySchema = z.object({
  navigation: z.array(z.object({node: FinanceNodeKeySchema, available:z.boolean(), completed:z.boolean()}).strict()).optional(),
  orderId: z.string().uuid().optional(),
  page: z.object({
    iePrecounts: z.object({entries:z.array(z.object({configurationItemId:IdSchema,quantity:z.number(),note:z.string().nullable(),recordedBy:z.string(),recordedAt:z.string().datetime()}).strict())}).strict(),
    tailInspection: TailInspectionResponseSchema.nullable(),
    workTasks: ReworkWorkTasksResponseSchema.nullable(),
    configuration: ProcessConfigurationResponseSchema.nullable(),
    workerPlan: ProcessWorkerPlanResponseSchema.nullable(),
    wholeOrderReview: WholeOrderReviewResponseSchema.nullable(),
    responsibility: ResponsibilityDeterminationResponseSchema.nullable(),
  }).strict().optional(),
  inspectionReport: InspectionReportDraftSchema.nullable(),
  node: FinanceNodeKeySchema,
  entry: ReworkHistoryEntrySchema,
  versions: z.array(ReworkHistoryEntrySchema),
  fields: z.array(z.object({ label: z.string(), value: z.string().nullable() }).strict()),
  sections: z.array(z.object({ title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string().nullable())) }).strict()),
  attachments: z.array(z.object({ attachmentId: z.string().uuid(), filename: z.string(), mimeType: z.string() }).strict()),
  notices: z.array(z.string()),
}).strict();
export type ReworkNodeHistory = z.infer<typeof ReworkNodeHistorySchema>;
