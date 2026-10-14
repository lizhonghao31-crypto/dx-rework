import { z } from "zod";
import type { JourneyNode, OrderJourney } from "./digital-production-journey.js";

export const DEVELOPMENT_VIEWS = [
  { key: "all", label: "全部档案" }, { key: "draft", label: "草稿" },
  { key: "developing", label: "开发中" }, { key: "awaiting_order", label: "待确认订单" },
  { key: "ordered", label: "已下单" },
] as const;
export type DevelopmentView = Exclude<typeof DEVELOPMENT_VIEWS[number]["key"], "all">;
export const DevelopmentWorkspaceFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""), customer: z.string().trim().max(100).optional(),
  view: z.enum(DEVELOPMENT_VIEWS.map(item => item.key)).default("all"),
  designer: z.string().trim().max(100).optional(),
  startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.endDate && value.startDate > value.endDate) context.addIssue({code:"custom", message:"开始日期不能晚于结束日期", path:["endDate"]});
});
export type DevelopmentWorkspaceFilter = z.infer<typeof DevelopmentWorkspaceFilterSchema>;
export type DevelopmentWorkspaceItem = { journey: OrderJourney; view: DevelopmentView; canConfirm: boolean };
export type DevelopmentWorkspaceResult = {
  asOf: string; page: number; pageSize: 20; total: number;
  counts: Record<DevelopmentWorkspaceFilter["view"], number>;
  customers: string[]; designers?: string[]; items: DevelopmentWorkspaceItem[];
};

export const PATTERN_GROUPS = [
  { key: "materials", label: "核配与补料", nodes: ["development_materials", "development_material_supply", "development_material_recheck"] },
  { key: "dispatch", label: "派工与转交", nodes: ["development_sewing_transfer"] },
  { key: "pattern", label: "纸样", nodes: ["development_pattern", "bulk_pattern"] },
  { key: "cutting", label: "裁板", nodes: ["development_cutting"] },
  { key: "craft", label: "工艺", nodes: ["development_craft_dispatch", "development_printing", "development_embroidery", "development_print_embroidery", "development_craft_confirmation"] },
  { key: "sewing", label: "车板", nodes: ["development_sewing"] },
  { key: "washing", label: "送洗与洗水", nodes: ["development_washing_dispatch", "development_washing"] },
  { key: "check", label: "尾查与确认", nodes: ["development_tail_check", "development_confirmation"] },
  { key: "shipping", label: "寄样", nodes: ["development_shipping"] },
] as const;
/** Visual lanes group original task kinds without changing workflow or counting rules. */
export const PATTERN_LANES = [
  {key:"materials", label:"核配与补料", groups:["materials"]},
  {key:"pattern", label:"纸样", groups:["pattern"]},
  {key:"cutting", label:"裁板", groups:["cutting"]},
  {key:"craft", label:"工艺与洗水", groups:["craft", "washing"]},
  {key:"sewing", label:"派工与车板", groups:["dispatch", "sewing"]},
  {key:"check", label:"尾查与确认", groups:["check"]},
  {key:"shipping", label:"寄样", groups:["shipping"]},
] as const;
export const PatternWorkspaceFilterSchema = z.object({
  business: z.enum(["development", "bulk", "all"]).default("development"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
  group: z.enum(PATTERN_GROUPS.map(item => item.key)).optional(),
  lane: z.enum(PATTERN_LANES.map(item => item.key)).optional(),
  owner: z.string().uuid().optional(),
  state: z.enum(["ongoing", "all", "pending", "active", "blocked", "completed"]).default("ongoing"),
  risk: z.enum(["overdue", "due_soon", "blocked", "unknown"]).optional(),
  scope: z.enum(["mine", "personnel", "all", "unassigned", "dispatch"]).default("mine"),
}).strict();
export type PatternWorkspaceFilter = z.infer<typeof PatternWorkspaceFilterSchema>;
export type PatternWorkspaceTask = {
  journeyId: string; sourceId: string | null; orderId: string | null; designStyleNo: string;
  customer: string | null; designer: string | null; node: JourneyNode;
  group: typeof PATTERN_GROUPS[number]["key"];
  nativeAssignment?: {orderId:string};
};
export type PatternWorkspaceResult = {
  asOf: string; page: number; pageSize: 15; total: number; archiveTotal: number;
  counts: Record<typeof PATTERN_GROUPS[number]["key"], number>;
  owners: Array<{id: string; name: string | null}>; items: PatternWorkspaceTask[];
  risks?: PatternWorkspaceTask[];
  riskCounts: Record<typeof PATTERN_GROUPS[number]["key"], {dueSoon: number; overdue: number}>;
};
