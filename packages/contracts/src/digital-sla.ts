import { z } from "zod";

/** Rule semantics are code-owned. Settings change values, never business gates. */
export const DIGITAL_SLA_RULE_VERSION = "20261023.1" as const;
/** Preserve the existing numeric-hour policies without rounding their deadlines. */
export const isSlaDurationMinutes = (value: unknown): value is number => typeof value === "number"
  && Number.isFinite(value) && value > 0 && value <= 525600
  && Math.round(value * 60000) >= 1
  && Math.abs(value * 60000 - Math.round(value * 60000)) < 0.00001;
const durationMinutes = z.number().positive().max(525600).refine(isSlaDurationMinutes, "SLA duration must have millisecond precision");
export const DigitalSlaValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("duration"), minutes: durationMinutes }).strict(),
  z.object({ kind: z.literal("included"), minutes: durationMinutes }).strict(),
  z.object({ kind: z.literal("estimate"), minutes: durationMinutes }).strict(),
  z.object({ kind: z.literal("offset"), days: z.number().int().nonnegative().max(365), notificationEnabled:z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("ratio"), percent: z.number().int().min(1).max(99), notificationEnabled:z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("buffer"), minutes: z.number().int().nonnegative().max(525600) }).strict(),
  z.object({ kind: z.literal("order_date") }).strict(),
  z.object({ kind: z.literal("unlimited") }).strict(),
]);
export type DigitalSlaValue = z.infer<typeof DigitalSlaValueSchema>;
export type DigitalSlaParameter = Readonly<{
  key: string; label: string; stage: number; defaultValue: DigitalSlaValue;
  startsAt: string; endsAt: string; scope: "order" | "development" | "batch" | "po" | "global";
  includedIn?: readonly string[];
}>;
const duration = (minutes: number): DigitalSlaValue => ({ kind: "duration", minutes });
const unlimited: DigitalSlaValue = { kind: "unlimited" };
function parameter(key: string, label: string, stage: number, defaultValue: DigitalSlaValue,
  startsAt: string, endsAt: string, scope: DigitalSlaParameter["scope"] = "order",
  includedIn?: readonly string[]): DigitalSlaParameter {
  return Object.freeze({ key, label, stage, defaultValue: Object.freeze(defaultValue), startsAt, endsAt, scope,
    ...(includedIn ? { includedIn: Object.freeze([...includedIn]) } : {}) });
}
export const DIGITAL_SLA_PARAMETERS: readonly DigitalSlaParameter[] = Object.freeze([
  parameter("order_creation", "订单创建", 1, unlimited, "source_published", "order_created"),
  parameter("customer_confirmation", "客户确认下单", 1, unlimited, "order_created", "customer_order_confirmed"),
  parameter("development_materials", "文员核配委派", 2, duration(240), "development_published", "materials_arranged", "development"),
  parameter("development_pattern", "开发纸样", 2, duration(2880), "pattern_ready", "pattern_completed", "development"),
  parameter("external_pattern", "外部纸样", 2, duration(2880), "external_pattern_requested", "external_pattern_received", "development"),
  parameter("development_cutting", "固定裁板", 2, duration(240), "pattern_completed", "sample_cutting_completed", "development"),
  parameter("development_printing", "开发印花", 2, duration(5760), "sample_craft_ready", "sample_craft_return_confirmed", "development"),
  parameter("development_embroidery", "开发绣花", 2, duration(5760), "sample_craft_ready", "sample_craft_return_confirmed", "development"),
  parameter("development_print_embroidery", "开发印绣", 2, duration(10080), "sample_craft_ready", "sample_craft_return_confirmed", "development"),
  parameter("development_craft_dispatch", "发工艺", 2, { kind: "included", minutes: 30 }, "sample_craft_ready", "sample_craft_dispatched", "development", ["development_printing", "development_embroidery", "development_print_embroidery"]),
  parameter("development_craft_return", "确认工艺回收", 2, { kind: "included", minutes: 30 }, "sample_craft_returned", "sample_craft_return_confirmed", "development", ["development_printing", "development_embroidery", "development_print_embroidery"]),
  parameter("development_sewing", "开发车板", 2, duration(1440), "sample_sewing_ready", "sample_sewing_completed", "development"),
  parameter("development_sewing_transfer", "转车板", 2, { kind: "included", minutes: 30 }, "sample_sewing_ready", "sample_sewing_transferred", "development", ["development_sewing"]),
  parameter("development_pre_wash_check", "洗前检查", 2, duration(30), "sample_sewing_completed", "pre_wash_check_completed", "development"),
  parameter("development_washing", "开发洗水", 2, duration(1440), "pre_wash_check_completed", "sample_washing_completed", "development"),
  parameter("development_washing_dispatch", "发洗水", 2, { kind: "included", minutes: 30 }, "pre_wash_check_completed", "sample_washing_dispatched", "development", ["development_washing"]),
  parameter("development_tail_check", "最终尾查", 2, duration(30), "final_check_ready", "final_check_passed_with_photos", "development"),
  parameter("development_accessories", "开发辅料实收", 2, unlimited, "accessories_requested", "clerk_accessories_received", "development"),
  parameter("development_shipping", "开发寄样", 2, unlimited, "sample_available", "sample_sent", "development"),
  parameter("budget", "共享预算冻结", 2, unlimited, "budget_created", "merchandiser_final_published"),
  parameter("production_sheet", "大货制单", 3, duration(4320), "customer_order_confirmed", "instruction_published"),
  parameter("bulk_pattern", "大货纸样及唛架", 3, duration(2880), "instruction_published", "bulk_pattern_marker_completed"),
  parameter("sourcing_ie", "IE报价", 3, duration(120), "sourcing_accepted", "quote_completed"),
  parameter("sourcing_selection", "生产管理选厂", 3, duration(120), "quote_completed", "factory_selected"),
  parameter("sourcing_approval", "老板审批", 3, duration(120), "factory_selected", "sourcing_decided"),
  parameter("fabric_inspection", "整单验布", 3, duration(1440), "whole_fabric_arrived", "fabric_inspection_completed"),
  parameter("warehouse_preshrink", "预缩", 3, duration(2160), "fabric_usable", "preshrink_completed"),
  parameter("bulk_cutting", "整单开裁", 4, duration(1440), "cutting_fabric_actually_received", "whole_cutting_completed"),
  parameter("bulk_printing", "大货印花", 5, duration(5760), "cut_craft_dispatched", "cut_craft_returned", "batch"),
  parameter("bulk_embroidery", "大货绣花", 5, duration(5760), "cut_craft_dispatched", "cut_craft_returned", "batch"),
  parameter("bulk_print_embroidery", "大货印绣", 5, duration(10080), "cut_craft_dispatched", "cut_craft_returned", "batch"),
  parameter("bulk_qc", "裁后回仓总查", 5, duration(2880), "cut_craft_returned", "cut_qc_completed", "batch"),
  parameter("warehouse_dispatch", "仓库发裁片", 5, duration(1440), "cut_dispatch_ready", "cut_dispatched", "batch"),
  parameter("warehouse_accessories", "仓库辅料调配", 5, unlimited, "accessories_available", "accessories_dispatched", "batch"),
  parameter("factory_production", "工厂生产目标", 6, { kind: "order_date" }, "factory_production_started", "factory_qc_completed", "po"),
  parameter("ship_sample", "船样寄出记录", 6, unlimited, "ship_sample_available_before_production", "ship_sample_sent", "po"),
  parameter("ship_sample_advance", "船样完成提前量", 6, { kind: "offset", days: 10 }, "customer_shipping_date", "ship_sample_target", "po"),
  parameter("order_shipping_reminder", "整单提前提醒", 6, { kind: "offset", days: 7 }, "customer_shipping_date", "shipping_reminder", "po"),
  parameter("return_logistics", "工厂回仓物流预计", 7, { kind: "estimate", minutes: 2880 }, "factory_return_dispatched", "garment_arrived", "batch"),
  parameter("garment_inspection", "成衣到仓质检", 7, duration(2880), "garment_arrived", "garment_qc_completed", "batch"),
  parameter("garment_rework", "异常成衣返工", 7, duration(2880), "rework_assignments_confirmed", "round_actual_work_completed", "batch"),
  parameter("garment_packing", "合格装箱", 7, duration(1440), "original_packing_conditions_ready", "effective_packing_recorded", "batch"),
  parameter("receiving_span", "收货历时", 7, unlimited, "first_effective_receipt", "effective_receipts_reach_quantity"),
  parameter("warning_ratio", "节点临期比例", 0, { kind: "ratio", percent: 70 }, "responsibility_started", "warning", "global"),
  parameter("stage_buffer", "阶段额外缓冲", 0, { kind: "buffer", minutes: 0 }, "stage_path_completed", "stage_target", "global"),
]);

export const DigitalSlaValuesSchema = z.record(z.string(), DigitalSlaValueSchema);
export type DigitalSlaValues = z.infer<typeof DigitalSlaValuesSchema>;
export const DigitalSlaResolvedValueSchema = z.object({
  value: DigitalSlaValueSchema,
  source: z.enum(["global", "customer", "order"]),
  sourceVersion: z.number().int().positive(),
}).strict();
export const DigitalSlaSnapshotSchema = z.object({
  ruleVersion: z.literal(DIGITAL_SLA_RULE_VERSION),
  parameters: z.record(z.string(), DigitalSlaResolvedValueSchema),
}).strict();
export type DigitalSlaSnapshot = z.infer<typeof DigitalSlaSnapshotSchema>;

/** Precision and evidence must be retained; recording time is never actual time. */
export const DigitalSlaFactSchema = z.object({
  eventId: z.string().uuid(), eventKind: z.string().min(1), sourceRecordId: z.string().min(1),
  sourceVersion: z.number().int().positive(), recordedAt: z.iso.datetime({ offset: true }),
  actorId: z.string().uuid(), orderId: z.string().uuid(), poId: z.string().uuid().nullable(),
  batchId: z.string().uuid().nullable(), occurrence: z.number().int().positive(),
  time: z.discriminatedUnion("precision", [
    z.object({ precision: z.literal("instant"), value: z.iso.datetime({ offset: true }) }).strict(),
    z.object({ precision: z.literal("date"), value: z.iso.date() }).strict(),
    z.object({ precision: z.literal("unknown"), reason: z.string().trim().min(1) }).strict(),
  ]),
  correctsEventId: z.string().uuid().nullable(),
}).strict();
export type DigitalSlaFact = z.infer<typeof DigitalSlaFactSchema>;

const parameterByKey = new Map(DIGITAL_SLA_PARAMETERS.map(row => [row.key, row]));
export function digitalSlaDefaults(): DigitalSlaValues {
  return Object.fromEntries(DIGITAL_SLA_PARAMETERS.map(row => [row.key, { ...row.defaultValue }]));
}

/** Validate the resolved set, not just changed fields: children may share a window. */
export function validateDigitalSlaValues(input: unknown): DigitalSlaValues {
  const values = DigitalSlaValuesSchema.parse(input);
  const expected = DIGITAL_SLA_PARAMETERS.map(row => row.key);
  if (Object.keys(values).length !== expected.length || expected.some(key => !(key in values))) {
    throw new Error("SLA parameter set must contain exactly the current catalog");
  }
  for (const [key, value] of Object.entries(values)) {
    if (parameterByKey.get(key)?.defaultValue.kind !== value.kind) throw new Error(`SLA type mismatch: ${key}`);
    if('notificationEnabled'in value&&!['warning_ratio','ship_sample_advance'].includes(key))throw new Error(`No independent notification switch: ${key}`);
  }
  for (const parent of DIGITAL_SLA_PARAMETERS.filter(row => row.defaultValue.kind === "duration")) {
    const window = values[parent.key]!;
    if (window.kind !== "duration") throw new Error("Invalid SLA window");
    const included = DIGITAL_SLA_PARAMETERS.filter(row => row.includedIn?.includes(parent.key));
    const used = included.reduce((sum, child) => {
      const value = values[child.key]!;
      return sum + (value.kind === "included" ? value.minutes : 0);
    }, 0);
    if (used > window.minutes) throw new Error(`Included targets exceed parent window: ${parent.key}`);
  }
  return values;
}
export type DigitalSlaValueLayer = Readonly<{ version: number; values: DigitalSlaValues }>;
/** Customer/order layers must come from pre-existing, authorized scopes. No customer registry is created. */
export function resolveDigitalSlaSnapshot(global: DigitalSlaValueLayer,
  customer?: DigitalSlaValueLayer, order?: DigitalSlaValueLayer): DigitalSlaSnapshot {
  validateDigitalSlaValues(global.values);
  const parameters: DigitalSlaSnapshot["parameters"] = {};
  const layers = [["global", global], ["customer", customer], ["order", order]] as const;
  for (const [source, layer] of layers) {
    if (!layer) continue;
    if (!Number.isSafeInteger(layer.version) || layer.version < 1) throw new Error("Invalid SLA source version");
    for (const [key, value] of Object.entries(DigitalSlaValuesSchema.parse(layer.values))) {
      if (!parameterByKey.has(key)) throw new Error(`Unknown SLA parameter: ${key}`);
      parameters[key] = { value, source, sourceVersion: layer.version };
    }
  }
  validateDigitalSlaValues(Object.fromEntries(Object.entries(parameters).map(([key, row]) => [key, row.value])));
  return DigitalSlaSnapshotSchema.parse({ ruleVersion: DIGITAL_SLA_RULE_VERSION, parameters });
}
export function validateDigitalSlaSnapshot(input: unknown): DigitalSlaSnapshot {
  const snapshot = DigitalSlaSnapshotSchema.parse(input);
  validateDigitalSlaValues(Object.fromEntries(Object.entries(snapshot.parameters).map(([key, row]) => [key, row.value])));
  return snapshot;
}
