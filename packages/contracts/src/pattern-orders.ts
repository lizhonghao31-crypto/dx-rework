import { z } from "zod";

// Switched on only when the six-PR wage closure is complete. Root can verify each increment.
export const PATTERN_ROOM_ORDERS_ENABLED = false;
export const PATTERN_ORDER_ROLES = {
  "pattern_room:orders:view": ["sample_designer", "order_merchandiser", "pattern_room_supervisor", "worker", "owner_group", "production_management"],
  "pattern_room:orders:create": ["sample_designer"],
  "pattern_room:orders:assign": ["pattern_room_supervisor"],
  "pattern_room:orders:complete": ["worker"],
  "pattern_room:orders:handoff": ["sample_designer"],
  "pattern_room:orders:edit": ["sample_designer"],
  "pattern_room:misc:create": ["sample_designer", "order_merchandiser"],
  "pattern_room:misc:edit": ["sample_designer", "order_merchandiser"],
  "pattern_room:misc:confirm": ["sample_designer", "order_merchandiser"],
  "pattern_room:orders:hours": ["pattern_room_supervisor"],
} as const;
export type PatternOrderCapability = keyof typeof PATTERN_ORDER_ROLES;
export function canUsePatternOrder(roles: readonly string[], capabilities: readonly string[], capability: PatternOrderCapability): boolean {
  return roles.includes("root_superuser") || (capabilities.includes(capability) && PATTERN_ORDER_ROLES[capability].some(role => roles.includes(role)));
}
export const PatternOrderStatusSchema = z.enum(["pending_assignment", "in_progress", "pending_confirmation", "completed", "cancelled"]);
export const PATTERN_ORDER_STATUS_LABELS = { pending_assignment: "待分配", in_progress: "进行中", pending_confirmation: "待确认", completed: "已完成", cancelled: "已取消" } as const;
const optionalText = (max: number) => z.string().trim().max(max).nullable().default(null);
const materials = {
  styleNo: z.string().trim().min(1, "请填写本次款号").max(100),
  attachmentIds: z.array(z.string().uuid()).min(1, "请上传制作PDF或清晰图片").max(20).refine(ids => new Set(ids).size === ids.length, "附件不能重复"),
  requiredDate: z.iso.date().nullable().default(null),
  customer: optionalText(100), sizeColor: optionalText(200), referenceStyleNo: optionalText(100),
  variant: z.enum(["初版", "复版", "齐色版"]).nullable().default(null), note: optionalText(2000),
};
export const CreatePatternOrderSchema = z.object({ ...materials,
  categoryId: z.string().uuid(), quantity: z.number().int().min(1).max(1_000_000).default(1), priceVersion: z.number().int().positive(),
}).strict();
export type CreatePatternOrder = z.infer<typeof CreatePatternOrderSchema>;
const miscMaterials = {
  taskName: z.string().trim().min(1, "请填写杂事内容或任务名称").max(200),
  styleNo: z.string().trim().max(100).default(""),
  attachmentIds: z.array(z.string().uuid()).max(20).default([]).refine(ids => new Set(ids).size === ids.length, "附件不能重复"),
  requiredDate: materials.requiredDate, note: materials.note,
};
export const CreateMiscOrderSchema = z.object({ ...miscMaterials,
  priceVersion: z.number().int().positive(),
}).strict();
export const PatternRoundActionSchema = z.object({ version: z.number().int().positive(), roundId: z.string().uuid() }).strict();
export const AssignPatternOrderSchema = PatternRoundActionSchema.extend({ personId: z.string().uuid() }).strict();
export const UpdatePatternMaterialsSchema = PatternRoundActionSchema.extend({ ...materials, reason: z.string().trim().min(1).max(500) }).strict();
export const UpdateMiscMaterialsSchema = CreateMiscOrderSchema.omit({ priceVersion: true }).extend({ version: z.number().int().positive(), roundId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict();
export const PatternHoursSchema = z.string().regex(/^(?:0|[1-9]\d{0,5})(?:\.\d)?$/, "工时须为0.1小时的整数倍").refine(value => /^\d+(?:\.\d)?$/.test(value) && BigInt(value.replace(".", "")) > 0n, "工时须大于0").transform(value => value.includes(".") ? value : `${value}.0`);
export const RecordPatternHoursSchema = PatternRoundActionSchema.extend({ hours: PatternHoursSchema }).strict();
export type PatternRoundAction = z.infer<typeof PatternRoundActionSchema>;
export const PatternOrderQuerySchema = z.object({
  q: z.string().trim().max(100).optional(), status: PatternOrderStatusSchema.optional(),
  kind: z.enum(["pattern", "misc"]).optional(),
  creatorId: z.string().uuid().optional(), workerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type PatternOrderQuery = z.infer<typeof PatternOrderQuerySchema>;

export const PatternOrderSummarySchema = z.object({
  orderId: z.string().uuid(), orderNo: z.string(), kind: z.enum(["pattern", "misc"]), taskName: z.string().nullable(), status: PatternOrderStatusSchema, version: z.number().int(),
  styleNo: z.string(), creatorId: z.string().uuid(), creatorName: z.string(), currentWorkerName: z.string().nullable(),
  requiredDate: z.string().nullable(), reworkCount: z.number().int(), submittedAt: z.string(), updatedAt: z.string(),
});
export const PatternOrderListSchema = z.object({ items: z.array(PatternOrderSummarySchema), totalCount: z.number().int(), page: z.number().int(), pageSize: z.number().int(), totalPages: z.number().int(), canCreate: z.boolean(), canCreateMisc: z.boolean(), canFilterPeople: z.boolean() });
export const PatternWorkerOptionsSchema = z.array(z.object({ personId: z.string().uuid(), userId: z.string().uuid(), name: z.string() }));
export const PatternPeopleFiltersSchema = z.object({ creators: z.array(z.object({ id: z.string().uuid(), name: z.string() })), workers: z.array(z.object({ id: z.string().uuid(), name: z.string() })) });
export const PatternAttachmentSchema = z.object({ attachmentId: z.string().uuid(), roundId: z.string().uuid(), filename: z.string(), mimeType: z.string(), sizeBytes: z.number(), active: z.boolean(), addedAt: z.string(), reason: z.string() });
export const PatternOrderDetailSchema = PatternOrderSummarySchema.extend({
  currentRoundId: z.string().uuid(), customer: z.string().nullable(), sizeColor: z.string().nullable(), referenceStyleNo: z.string().nullable(), variant: z.string().nullable(), note: z.string().nullable(),
  rounds: z.array(z.object({
    roundId: z.string().uuid(), index: z.number().int(), status: PatternOrderStatusSchema, categoryName: z.string(), unit: z.string(), quantity: z.number().int().nullable(), actualHours: z.string().nullable().optional(),
    unitPrice: z.string().optional(), agreedAmount: z.string().nullable().optional(), assignedAt: z.string().nullable(), completedAt: z.string().nullable(), handedOverAt: z.string().nullable(),
    segments: z.array(z.object({ segmentId: z.string().uuid(), personId: z.string().uuid(), workerUserId: z.string().uuid(), workerName: z.string(), amount: z.string().nullable().optional(), actualHours: z.string().nullable(),
      startedAt: z.string(), endedAt: z.string().nullable(), wageEligible: z.boolean() })),
    nodes: z.array(z.object({ stage: z.enum(["pending_assignment", "in_progress", "pending_confirmation"]), enteredAt: z.string(), exitedAt: z.string().nullable(), exitReason: z.string().nullable(), elapsedSeconds: z.number().nonnegative() })),
  })),
  attachments: z.array(PatternAttachmentSchema),
  history: z.array(z.object({ action: z.string(), actorName: z.string(), at: z.string(), reason: z.string().nullable() })),
  actions: z.object({ assign: z.boolean(), complete: z.boolean(), handoff: z.boolean(), edit: z.boolean(), hours: z.boolean() }),
});
export type PatternOrderSummary = z.infer<typeof PatternOrderSummarySchema>;
export type PatternOrderDetail = z.infer<typeof PatternOrderDetailSchema>;
