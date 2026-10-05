import { z } from "zod";

export const JOURNEY_STAGES = [
  { key: "creation", label: "订单创建" },
  { key: "development", label: "产品开发打板" },
  { key: "preparation", label: "大货产前准备" },
  { key: "cutting", label: "订单开裁" },
  { key: "post_cutting", label: "裁后工艺与发厂" },
  { key: "production", label: "工厂生产" },
  { key: "receiving", label: "回货与装箱" },
] as const;
export type JourneyStageKey = typeof JOURNEY_STAGES[number]["key"];
/** Public names and stable keys only. Applicability is evaluated against original route facts. */
export const JOURNEY_NODES: ReadonlyArray<{key:string;label:string;stage:JourneyStageKey;count:boolean}> = [
  {key:"product_development",label:"创建产品开发",stage:"creation",count:false},
  {key:"development_publish",label:"开发资料保存/发布",stage:"creation",count:false},
  {key:"order_information",label:"订购信息",stage:"creation",count:false},
  ...Object.entries({development_materials:"核配",development_material_supply:"物料补齐",development_material_recheck:"物料复核",development_pattern:"纸样",development_cutting:"裁板",development_craft_dispatch:"发工艺",development_printing:"印花",development_embroidery:"绣花",development_print_embroidery:"印绣花",development_craft_confirmation:"工艺确认",development_sewing_transfer:"派工/转交车板",development_sewing:"车板",development_washing_dispatch:"送洗",development_washing:"洗水",development_tail_check:"尾查",development_confirmation:"设计确认",development_shipping:"寄样"}).map(([key,label])=>({key,label,stage:"development" as const,count:!["development_material_supply","development_craft_dispatch","development_sewing_transfer","development_washing_dispatch"].includes(key)})),
  ...Object.entries({customer_sample:"客户样板确认",budget:"预算",sourcing_preparation:"跟单发起外发",sourcing_ie:"IE报价",sourcing_director:"供应链总监确认",sourcing_owner:"老板批准",production_instruction:"大货制单",bulk_pattern:"大货纸样",bulk_marker:"唛架",warehouse_preshrink:"预缩/无需预缩",cutting_gate:"开裁条件汇合"}).map(([key,label])=>({key,label,stage:"preparation" as const,count:["bulk_pattern","warehouse_preshrink"].includes(key)})),
  {key:"bulk_cutting",label:"本厂/外厂整款开裁",stage:"cutting",count:true},
  ...Object.entries({process_logistics:"二次工艺收发",bulk_qc:"工艺QC/问题处理/复查",warehouse_dispatch:"仓库实际发加工厂"}).map(([key,label])=>({key,label,stage:"post_cutting" as const,count:true})),
  ...Object.entries({factory_arrival:"到厂/到料确认",factory_material_count:"到料清点",production_reporting:"实际生产填报/生产完成",bulk_ship_sample:"船样"}).map(([key,label])=>({key,label,stage:"production" as const,count:["factory_material_count","bulk_ship_sample"].includes(key)})),
  ...Object.entries({receipts:"回货/实收",receiving_inspection:"回货质检",rework:"本厂做尾/QC返工",rework_review:"复核",responsibility:"责任相关",packing:"装箱",quantity_difference:"数量差异",special_closure:"特殊结案"}).map(([key,label])=>({key,label,stage:"receiving" as const,count:["receipts","packing"].includes(key)})),
];

export const JourneyStateSchema = z.enum(["uncreated", "pending", "active", "blocked", "completed", "cancelled", "not_applicable", "unavailable", "inherited"]);
export type JourneyState = z.infer<typeof JourneyStateSchema>;
export const JourneyFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
  customer: z.string().trim().max(100).optional(),
  merchandiserId: z.string().uuid().optional(),
  category: z.string().trim().max(100).optional(),
  stage: z.enum(JOURNEY_STAGES.map(stage => stage.key)).optional(),
  node: z.string().trim().max(100).refine(value=>JOURNEY_NODES.some(node=>node.key===value),"未知流程节点").optional(),
  state: JourneyStateSchema.optional(),
  risk: z.enum(["overdue", "due_soon", "blocked", "unknown"]).optional(),
  kpi: z.enum(["all", "active", "due_soon", "overdue", "blocked", "completed"]).default("all"),
  startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.endDate && value.startDate > value.endDate) context.addIssue({code:"custom", message:"开始日期不能晚于结束日期", path:["endDate"]});
});
export type JourneyFilter = z.infer<typeof JourneyFilterSchema>;
export type JourneyRecord = { domain: string; id: string; url: string | null; mode: "read" | "handle"; version: number | null; lineId: string | null };
export type JourneyNode = {
  key: string; instanceId: string; label: string; stage: JourneyStageKey; state: JourneyState;
  round: number | null; occurrence: number | null; current: boolean;
  owner: { id: string; name: string | null } | null;
  operator: { id: string; name: string | null } | null;
  assignmentHistory: Array<{ at: string; actorId: string; from: string | null; to: string | null }>;
  expectedAt: string | null; expectedKind: "sla" | "plan" | "unset" | "unavailable";
  actualAt: string | null; actualQuality: "verified" | "unverified" | "missing" | "unavailable";
  enteredAt: string | null; sla: "running" | "finished" | "not_started" | "not_set" | "unavailable";
  completionResult: "early" | "on_time" | "late" | "unknown" | null; overdueSeconds: number | null;
  risks: Array<"overdue" | "due_soon" | "blocked" | "unknown">;
  blockers: Array<{ key: string; label: string; ownerId: string | null; record: JourneyRecord | null }>;
  records: JourneyRecord[]; inheritedFrom: { taskId: string; round: number } | null;
  countsInProgress: boolean; unavailableReason: "permission" | "fact_not_recorded" | null;
};
export type OrderJourney = {
  id: string; sourceId: string | null; orderId: string | null; designStyleNo: string;
  temporaryStyleNo: string | null; customer: string | null; category: string | null;
  designer: string | null; styleName: string | null; merchandisers: Array<{id:string;name:string|null}>;
  orderNumbers: string[]; createdAt: string; deliveryDate: string | null; selectedRound: number | null; adoptedRound: number | null;
  sourceVersion: number | null; instructionVersion: number | null;
  lines: Array<{ id: string; po: string | null; color: string; formalStyleNo: string | null; temporaryStyleNo: string | null; orderedQuantity: number }>;
  links: JourneyRecord[];
  stages: Array<{key:JourneyStageKey;label:string;state:JourneyState;nodes:JourneyNode[]}>;
  progress: { development: {applicable:number;completed:number} | null; bulk: {applicable:number;completed:number} | null };
  hitReasons: Array<{nodeId:string;nodeKey:string;stage:JourneyStageKey;risks:JourneyNode["risks"]}>;
};
export type JourneyResult = { ruleVersion: "journey-v2.0"; asOf: string; page: number; pageSize: 20; total: number;
  summary: {all:number;active:number;dueSoon:number;overdue:number;blocked:number;completed:number}; items: OrderJourney[] };

/** Stable, local-only return context. Consumers restore these values after domain handling. */
export const JourneyReturnContextSchema = JourneyFilterSchema.safeExtend({ selected: z.string().uuid().optional(), expanded: z.string().max(100).optional() });
export function journeyReturnUrl(context: z.input<typeof JourneyReturnContextSchema>): string {
  const value = JourneyReturnContextSchema.parse(context);
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) if (item !== undefined && item !== "") params.set(key, String(item));
  return `/ui/digital-cockpit?${params}`;
}
