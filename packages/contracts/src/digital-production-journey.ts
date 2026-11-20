import type {FixedScheduleProgress,ScheduleNodeProgress,ScheduleGoalDelta,ScheduleScopeProgress} from './fixed-schedule-progress.js';
import { z } from "zod";
import type {QcProgressClock} from './qc-production-progress.js';
import type { PoDeliveryDate,PoDeliveryRisk } from "./po-delivery-dates.js";
import type {FactoryReturnLogisticsWindow} from './factory-flow.js';

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
export const JOURNEY_NODES: ReadonlyArray<{key:string;label:string;stage:JourneyStageKey;count:boolean;planningOnly?:boolean}> = [
  ...Object.entries({design_handover:'设计资料交接',material_investment:'跟单投面料',fabric_receipt:'面料到仓',color_confirmation:'对色完成',client_sample_approval:'客户最终批复',accessories_ready:'辅料实物备齐',style_label_ready:'款号唛实物备齐',processing_dispatch:'发加工计划',planned_shipment:'系统计划出货'}).map(([key,label])=>({key:`series_${key}`,label,stage:key==='processing_dispatch'?'post_cutting' as const:key==='planned_shipment'?'receiving' as const:'preparation' as const,count:false,planningOnly:true})),
  {key:"product_development",label:"创建产品开发",stage:"creation",count:false},
  {key:"development_publish",label:"开发资料保存/发布",stage:"creation",count:false},
  {key:"order_information",label:"订购信息",stage:"creation",count:false},
  ...Object.entries({development_materials:"核配",development_material_supply:"物料补齐",development_material_recheck:"物料复核",development_pattern:"纸样",development_external_pattern:"外部纸样",development_size_review:"大货尺寸复核",development_positioning:"设计定位图",development_patch:"局部补做",development_patch_tail_check:"补做尾查",development_patch_confirmation:"补做设计确认",development_cutting:"裁板",development_craft_dispatch:"发工艺",development_printing:"印花",development_embroidery:"绣花",development_print_embroidery:"印绣花",development_craft_confirmation:"工艺确认",development_sewing_transfer:"派工/转交车板",development_sewing:"车板",development_washing_dispatch:"送洗",development_washing:"洗水",development_pre_wash_check:"洗前尺寸检查",development_tail_check:"尾查",development_confirmation:"设计确认",development_shipping:"寄样"}).map(([key,label])=>({key,label,stage:"development" as const,count:!["development_material_supply","development_craft_dispatch","development_sewing_transfer","development_washing_dispatch"].includes(key)})),
  ...Object.entries({customer_sample:"客户样板确认",budget:"预算",sourcing_preparation:"跟单发起外发",sourcing_ie:"IE报价",sourcing_director:"供应链总监确认",sourcing_owner:"老板批准",production_instruction:"大货制单",bulk_pattern:"大货纸样",bulk_marker:"唛架",warehouse_preshrink:"预缩/无需预缩",cutting_gate:"开裁条件汇合"}).map(([key,label])=>({key,label,stage:"preparation" as const,count:["bulk_pattern","warehouse_preshrink"].includes(key)})),
  {key:"bulk_cutting",label:"本厂/外厂整款开裁",stage:"cutting",count:true},
  ...Object.entries({process_logistics:"二次工艺收发",bulk_qc:"工艺QC/问题处理/复查",warehouse_dispatch:"仓库实际发加工厂"}).map(([key,label])=>({key,label,stage:"post_cutting" as const,count:true})),
  ...Object.entries({production_reporting:"QC生产进度与现场照片",factory_production_qc:"工厂成衣QC检查",bulk_ship_sample:"船样"}).map(([key,label])=>({key,label,stage:"production" as const,count:["bulk_ship_sample","factory_production_qc"].includes(key)})),
  ...Object.entries({receipts:"回货/实收",receiving_inspection:"回货质检",rework:"本厂做尾/QC返工",rework_review:"复核",responsibility:"责任相关",packing:"装箱",quantity_difference:"数量差异",special_closure:"特殊结案"}).map(([key,label])=>({key,label,stage:"receiving" as const,count:["receipts","packing"].includes(key)})),
];

export const JourneyStateSchema = z.enum(["uncreated", "pending", "active", "blocked", "completed", "cancelled", "not_applicable", "unavailable", "inherited"]);
/** Plan rows can display deadlines/actual references without becoming execution shares or lifecycle gates. */
export const isJourneyPlanningNode=(node:{key:string;planningOnly?:boolean})=>Boolean(node.planningOnly||JOURNEY_NODES.find(d=>d.key===node.key)?.planningOnly);
export type JourneyState = z.infer<typeof JourneyStateSchema>;
export const JOURNEY_COVERAGE_KEYS = ['customer_date','factory_date','fabric_date','cutting_time','plan','scope','fact_time'] as const;
// Legacy plan absence and restricted visibility are coverage notices, not current gaps.
export const JOURNEY_PENDING_COVERAGE_KEYS = JOURNEY_COVERAGE_KEYS.filter(key=>key!=='plan'&&key!=='scope');
export const JourneyFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  scope: z.enum(["production", "development"]).optional(),
  search: z.string().trim().max(100).default(""),
  customer: z.string().trim().max(100).optional(),
  merchandiserId: z.string().uuid().optional(),
  category: z.string().trim().max(100).optional(),
  stage: z.enum(JOURNEY_STAGES.map(stage => stage.key)).optional(),
  node: z.string().trim().max(100).refine(value=>JOURNEY_NODES.some(node=>node.key===value),"未知流程节点").optional(),
  state: JourneyStateSchema.optional(),
  risk: z.enum(["overdue", "due_soon", "blocked", "unknown"]).optional(),
  missing: z.enum(JOURNEY_COVERAGE_KEYS).optional(),
  progress:z.enum(['schedule_lag','customer_due_passed','unknown']).optional(),
  kpi: z.enum(["all", "active", "not_started", "due_soon", "overdue", "blocked", "completed", "todo"]).default("all"),
  startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.endDate && value.startDate > value.endDate) context.addIssue({code:"custom", message:"开始日期不能晚于结束日期", path:["endDate"]});
});
export type JourneyFilter = z.infer<typeof JourneyFilterSchema>;
export const JourneyListFilterSchema = JourneyFilterSchema.safeExtend({view:z.literal('home').optional()});
export type JourneyRecord = { domain: string; id: string; url: string | null; mode: "read" | "handle"; version: number | null; lineId: string | null };
/** Read-only, action-specific material evidence. It never grants or blocks an operation. */
export type NodeMaterialState='missing'|'present'|'partial'|'effective'|'stale'|'unknown'|'not_applicable';
export type NodeMaterial={
 id:string;label:string;purpose:'input'|'output'|'reference';applicability:'required'|'optional'|'not_applicable';
 state:NodeMaterialState;reason:string;versionLabel:string|null;scope:string;
 role:string;owner:{id:string;name:string|null}|null;mine:boolean;
 when:'now'|'later'|'waiting_other';expectedAt:string|null;expectedPrecision:JourneyNode['expectedPrecision'];
 effect:'original_gate'|'information'|'reminder';records:JourneyRecord[];
};
export type NodeMaterials={
 ruleVersion:'node-materials-v1';journeyId:string;instanceId:string;round:number|null;asOf:string;revision:string;
 historical:boolean;coverage:'available'|'limited';notice:string;rows:NodeMaterial[];
};
export const NodeMaterialsQuerySchema=z.object({instanceId:z.string().trim().min(1).max(300),round:z.coerce.number().int().positive().max(10000).optional()}).strict();
export const NodeMaterialsSchema=z.object({
 ruleVersion:z.literal('node-materials-v1'),journeyId:z.uuid(),instanceId:z.string(),round:z.number().int().positive().nullable(),asOf:z.iso.datetime({offset:true}),revision:z.string().regex(/^[0-9a-f]{64}$/),historical:z.boolean(),coverage:z.enum(['available','limited']),notice:z.string(),
 rows:z.array(z.object({id:z.string().min(1),label:z.string(),purpose:z.enum(['input','output','reference']),applicability:z.enum(['required','optional','not_applicable']),state:z.enum(['missing','present','partial','effective','stale','unknown','not_applicable']),reason:z.string(),versionLabel:z.string().nullable(),scope:z.string(),role:z.string(),owner:z.object({id:z.uuid(),name:z.string().nullable()}).nullable(),mine:z.boolean(),when:z.enum(['now','later','waiting_other']),expectedAt:z.string().nullable(),expectedPrecision:z.enum(['instant','date','missing','unavailable']),effect:z.enum(['original_gate','information','reminder']),records:z.array(z.object({domain:z.string(),id:z.string(),url:z.string().nullable(),mode:z.enum(['read','handle']),version:z.number().int().nullable(),lineId:z.string().nullable()}))})),
});
export type JourneyDocumentMetadata={created:{at:string|null;by:string|null};edited:{at:string|null;by:string|null};published:{at:string|null;by:string|null}};
export type JourneyTiming = {
  /** Original native windows remain individually readable after their aggregate closes. */
  windows?: Array<{evidence:string;scopeLabel:string;startedAt:string|null;deadline:string|null;warningAt:string|null;completedAt:string|null;complete:boolean;snapshotId?:string|null;record?:JourneyRecord}>;
  coverageComplete?:boolean;
  /** Date ranges are estimates, never exact starts, deadlines or permission to receive. */
  logisticsWindows?:FactoryReturnLogisticsWindow[];
  id:string;label:string;stage:JourneyStageKey;kind:string;
  status:"not_applicable"|"unknown"|"not_started"|"running"|"warning"|"overdue"|"completed_on_time"|"completed_late"|"completed_unrated"|"terminated";
  /** A terminal event stops this unfinished window; it is never delivery A. */
  termination?:{kind:'cancelled'|'special_closure';at:string|null;sourceRef:string|null;elapsedSeconds:number|null;overdueSeconds:number|null};
  provenRisk?:"overdue"|"warning";
  assessmentIssue?:{code:"completion_before_start"|"actual_after_observation";reason:string};
  actualStart:string|null;actualEnd:string|null;
  target:{at:string|null;exclusive:boolean;reasons:string[]};
  forecast:{at:string|null;exclusive:boolean;reasons:string[]};
  forecastBasis:"actual"|"remaining_estimate"|"standard_window"|"plan"|"unknown";
  original:{at:string|null;exclusive:boolean;reasons:string[]};
  current:{at:string|null;exclusive:boolean;reasons:string[]};
};
export type JourneyCoverage = {key:typeof JOURNEY_COVERAGE_KEYS[number];message:string};
/** Native observations remain readable without inventing an adopted SLA plan.
 * These references do not grant applicability, a deadline, forecast or rating.
 */
/** Original SLA adapter observations. A registration boundary (e.g. cumulative
 * packing) is not automatically a physical completion or shipment timestamp. */
export type JourneyNativeFact = {id:string;sourceRef:string;timeRole:'sla_observation';startedAt:string|null;completedAt:string|null;businessCompleted:boolean|null};
export type JourneySupervision = {assessment?:"complete"|"partially_unavailable";requestId?:string;asOf:string;status:"planned"|"legacy_unenrolled"|"limited";originalRevision:number|null;currentRevision:number|null;nodes:JourneyTiming[];nativeFacts?:JourneyNativeFact[];coverage:JourneyCoverage[];customerReminderDate:string|null};
export type JourneyNode = {
  /** Packing work may finish while order-level QC/differences remain open.
   * Missing on old DTOs retains their original whole-order packing meaning. */
  completesOrder?:boolean;
  nativeTaskDeadline?:{at:string;precision:'instant'|'date';mode?:'duration'|'date_target'|'unlimited'|undefined;exclusive?:boolean|undefined};
  fixedTargets?:Array<{scopeRef:string;lineId:string|null;progress:ScheduleNodeProgress}>;
  planningOnly?:boolean;
  responsibilityRole?:string;
  timing?:JourneyTiming;
  /** Several original PO/batch targets stay distinct; never choose one as the whole node deadline. */
  timings?:JourneyTiming[];
  /** Native factory batch D/C remain readable even when the generic task has no D. */
  nativeWindows?:JourneyTiming['windows'];
  /** Read-only applicability evidence; unknown never supplies a progress denominator. */
  progressApplicability?: "applicable" | "not_applicable" | "unknown";
  key: string; instanceId: string; label: string; stage: JourneyStageKey; state: JourneyState;
  round: number | null; occurrence: number | null; current: boolean;
  owner: { id: string; name: string | null } | null;
  ownerStatus?:'assigned'|'unassigned'|'unknown'|'unavailable';
  operator: { id: string; name: string | null } | null;
  completionOperators?:Array<{id:string;name:string|null}>;
  productionSupervision?:{state:'ended'|'active'|'partial'|'unknown';windows:Array<{scopeLabel:string;state:QcProgressClock['state'];reason:string|null;anchor:string|null;remindAt:string|null;escalateAt:string|null}>};
  assignmentHistory: Array<{ at: string; actorId: string; from: string | null; to: string | null; actorName?: string | null; fromName?: string | null; toName?: string | null }>;
  expectedAt: string | null; expectedKind: "sla" | "plan" | "unset" | "unavailable";
  deadlineMode?:'duration'|'date_target'|'unlimited';deadlineExclusive?:boolean;
  /** Plan dates retain their original date-only precision; no midnight is invented. */
  expectedPrecision: "instant" | "date" | "missing" | "unavailable";
  subject?: string;
  /** Known actual day without a reliable instant. Never synthesize midnight in actualAt. */
  actualDate?:string|null;
  actualAt: string | null; actualQuality: "verified" | "unverified" | "missing" | "unavailable";
  enteredAt: string | null; sla: "running" | "finished" | "not_started" | "not_set" | "unavailable";
  completionResult: "early" | "on_time" | "late" | "unknown" | null; overdueSeconds: number | null;
  risks: Array<"overdue" | "due_soon" | "blocked" | "unknown">;
  blockers: Array<{ key: string; label: string; ownerId: string | null; record: JourneyRecord | null }>;
  records: JourneyRecord[]; inheritedFrom: { taskId: string; round: number } | null;
  inheritedResult?:{actualAt:string|null;quality:JourneyNode['actualQuality'];adoptedAt:string|null;adoptedRound?:number;adoptionSourceRef?:string;reason:string};
  countsInProgress: boolean; unavailableReason: "permission" | "fact_not_recorded" | null;
};
export type OrderJourney = {
  cockpitCreation?: CockpitCreationFacts;
  cockpitFacts?: CockpitHomeFacts;
  actionableTodo?: CockpitActionableTodo;
  observationMode?:'live'|'fixed';
  fixedSchedule?:FixedScheduleProgress;
  /** Shared UI ratios. Business-requirement counts and legacy workspace ratios remain separate. */
  visualProgress?: JourneyVisualProgress;
  /** Versioned business requirements; legacy display/progress remain compatible. */
  businessProgress?: JourneyBusinessProgress;
  identity?: { kind: 'development' | 'production'; businessNumber: string | null; reason: string | null };
  seriesPlanVisible?:boolean;
  display?: JourneyDisplay;
  supervision?:JourneySupervision;
  operationLog?: JourneyLogPage;
  currentRiskNodes?: JourneyNode[];
  /** Current effective flow overview stays independent of the selected historical round. */
  flowStages?: OrderJourney["stages"];
  currentDeliveryRisks?: PoDeliveryRisk[];
  riskHistory?: JourneyRiskHistory[];
  asOf?: string; styleImageUrl?: string | null;
  developmentType?: string | null; requiredCompletionDate?: string | null;
  id: string; sourceId: string | null; orderId: string | null; designStyleNo: string;
  temporaryStyleNo: string | null; customer: string | null; category: string | null;
  designer: string | null; styleName: string | null; merchandisers: Array<{id:string;name:string|null}>;
  orderNumbers: string[]; createdAt: string; deliveryDate: string | null; selectedRound: number | null; adoptedRound: number | null;
  sourceVersion: number | null; instructionVersion: number | null;
  lines: Array<{ id: string; po: string | null; color: string; formalStyleNo: string | null; temporaryStyleNo: string | null; orderedQuantity: number }>;
  poDeliveryDates?:PoDeliveryDate[];
  deliveryRisks?:PoDeliveryRisk[];
  links: JourneyRecord[];
  stages: Array<{key:JourneyStageKey;label:string;state:JourneyState;nodes:JourneyNode[]}>;
  progress: { development: {applicable:number;completed:number} | null; bulk: {applicable:number;completed:number} | null };
  hitReasons: Array<{nodeId:string;nodeKey:string;stage:JourneyStageKey;risks:JourneyNode["risks"]}>;
};
export type JourneyRequirementTarget = {
  source: 'series_plan'; planId: string; revision: number; scopeRef: string;
  at: string; precision: 'instant' | 'date'; retainedFromRevision: number | null;
};
export type JourneyBusinessRequirement = {
  id: string; key: string; label: string; stage: JourneyStageKey; scopeRef: string;
  applicability: 'applicable' | 'not_applicable' | 'unknown';
  completed: boolean; instanceIds: string[]; reasons: string[];
  targets: JourneyRequirementTarget[];
};
export type JourneyBusinessQuantities = {
  revision: string;
  lines: Array<{lineId: string; demand: number; received: number; inspected: number | null;
    qualified: number | null; packed: number | null; effectivePacked?: number | null; remainingReceipt: number; remainingShipment: number | null;
    qualityGap: number | null; qualityConflict: boolean; factoryAttribution: 'known' | 'unknown'; reasons: string[]}>;
  /** Native receipt links do not establish precise factory attribution. */
  factoryAttribution: 'known' | 'unknown';
};
export type JourneyBusinessProgress = {
  ruleVersion: 'journey-business-v1'; asOf: string;
  requirements: JourneyBusinessRequirement[];
  applicable: number; completed: number; unknown: number; ratio: number | null;
  stages: Array<{key: JourneyStageKey; applicable: number; completed: number; unknown: number; ratio: number | null}>;
  plan: {status: 'not_adopted' | 'complete' | 'partial' | 'unavailable';
    planId: string | null; revision: number | null; covered: number; missing: number;
    due: number; outstandingDue: string[]; reasons: string[]};
  quantities?: JourneyBusinessQuantities;
  dates?: {asOf:string;overall:JourneyBusinessDateGroup;stages:Array<{key:JourneyStageKey}&JourneyBusinessDateGroup>};
};
export type JourneyBusinessDate = {
  at:string|null;precision:'instant'|'date'|'unknown';quality:'verified'|'recorded'|'unknown';
  status:'complete'|'partial'|'unknown'|'incomplete'|'not_applicable';covered:number;total:number;reasons:string[];
  coveredAt?:{at:string;precision:'instant'|'date'};
};
export type JourneyBusinessDateGroup = {
  actual:JourneyBusinessDate;
  adoptedPlan:JourneyBusinessDate&{planId:string|null;revision:number|null;sourcePlans:Array<{planId:string;revision:number}>};
  forecast:JourneyBusinessDate&{bases:Array<'actual'|'remaining_estimate'|'standard_window'|'sla_plan'>};
};

export type JourneyVisualStage = {
  goalDelta?: ScheduleGoalDelta;
  key: JourneyStageKey;
  applicability: 'applicable' | 'not_applicable' | 'unknown';
  applicable: number; completed: number; unknown: number;
  actualRatio: number | null; timeRatio: number | null; startedAt: string | null;
  expected: JourneyBusinessDate; actual: JourneyBusinessDate;
  risk: 'overdue' | 'due_soon' | 'normal' | 'unknown';
};
export type JourneyVisualProgress = {
  /** Customer commitment, separate from a legacy completion forecast. */
  delivery?: JourneyBusinessDate;
  ruleVersion: 'journey-visual-v1' | 'journey-visual-v2'; asOf: string;
  actualRatio: number | null; timeRatio: number | null; startedAt: string | null;
  applicableStages: number; completedStages: number; unknownStages: number;
  expected: JourneyBusinessDate; actual: JourneyBusinessDate;
  stages: JourneyVisualStage[];
};
/** Original, observable creation facts. The two clocks survive a conversion. */
export type CockpitCreationFacts = {
  developmentCreatedAt: string | null;
  orderCreatedAt: string | null;
  /** Presentation only. The first publication and order were one formal approval. */
  developmentPublishedWithOrder?: true;
};
export type CockpitActionableItem = {
  orderId: string;
  category: 'preparation_material'|'instruction_publish'|'sourcing_owner_approval'|'receiving_difference';
  evidenceId: string;
  missingObject: string;
  handlerRole: string;
  handlerId: string;
  originalRoute: string;
  reason: string;
  asOf: string;
};
export type CockpitActionableTodo = {status:'complete'|'unavailable';items:CockpitActionableItem[]};
export type CockpitFactStatus = 'not_started'|'partial'|'complete'|'no_record'|'not_applicable'|'unavailable';
export type CockpitFact = {
  status: CockpitFactStatus;
  tone: 'gray'|'blue'|'green'|'neutral';
  label: string;
  scope: 'whole'|'visible'|'unknown';
};
export type CockpitHomeFacts = {
  production: CockpitFact & {dashboardRecord?:JourneyRecord; dashboardLinks?: Array<{factoryName: string; record: JourneyRecord}>};
  receiving: CockpitFact & {received: number | null; demand: number | null};
  shipSample: CockpitFact;
};

export type JourneyCompleteResult = { ruleVersion: "journey-v2.0"; asOf: string; page: number; pageSize: 15; total: number; canManagePolicies?: boolean;
  facets?: { customers: string[]; categories: string[]; merchandisers: Array<{id:string;name:string|null}> };
  summary: {all:number;active:number;dueSoon:number;overdue:number;blocked:number;completed:number;notStarted?:number;timingMissing?:number;todo?:number|null;scheduleLag?:number;customerDuePassed?:number;scheduleUnknown?:number};
  supervision?:{overdue:number;dueSoon:number;coverage:Array<{key:JourneyCoverage["key"];orders:number;message:string}>};
  scopeCounts?: {production:number;development:number;cancelled:number}; items: OrderJourney[] };
/** An incomplete read cannot present zero or an old total as the latest value.
 * Its items are the currently available matching objects, not a claimed page
 * in a complete ordering; normal reads keep the existing complete contract. */
export type JourneyResult=Omit<JourneyCompleteResult,'total'|'summary'>&{
 observationMode?:'live'|'fixed';
 total:number|null;summary:JourneyCompleteResult['summary']|null;
 freshness?:{pending:number;failed:number;retryIds?:string[];detailsOnly?:true};
};

/** Page-only projection. Detail, export and other Journey consumers retain the full contract. */
export type CockpitHomeSchedule = Pick<FixedScheduleProgress,'asOf'|'observationMode'|'state'> & {
  clockCanAdvance: boolean;
  scopes: Array<Pick<ScheduleScopeProgress,'lineId'|'state'|'customerDuePassed'|'completionEstimate'>>;
  framework?: {scopes: Array<Pick<NonNullable<FixedScheduleProgress['framework']>['scopes'][number],'customerDate'>>};
};
export type CockpitHomeOrder = Pick<OrderJourney,
  'id'|'orderId'|'designStyleNo'|'styleImageUrl'|'styleName'|'identity'|'customer'|'merchandisers'|'lines'|
  'poDeliveryDates'|'deliveryRisks'|'stages'|'cockpitFacts'
> & {
  display?: Pick<JourneyDisplay,'mainState'>;
  fixedSchedule?: FixedScheduleProgress | CockpitHomeSchedule;
  visualProgress?: Pick<JourneyVisualProgress,'delivery'|'startedAt'|'timeRatio'|'actualRatio'|'actual'|'expected'>;
  businessProgress?: Pick<JourneyBusinessProgress,'quantities'>;
};
export type CockpitHomeResult = Omit<JourneyResult,'items'> & {items:CockpitHomeOrder[]};
export const scheduleCanAdvance = (schedule:FixedScheduleProgress) =>
  schedule.scopes.some(scope=>scope.nodes.some(node=>!node.businessCompleted&&!['unknown','terminated'].includes(node.goalDelta.kind)));

export type JourneyDisplay = {
  ruleVersion: "cockpit-display-v1";
  mainState: "closed" | "completed" | "overdue" | "due_soon" | "active" | "not_started" | "cancelled";
  earliestShipmentDate: string | null; missingShipmentDates: number; closedAt: string | null;
  actualRatio: number | null; actualLabel: string; awaitingClosure: boolean;
  stages: Array<{key:JourneyStageKey;ratio:number|null;applicable:number|null;completed:number|null;notApplicable:boolean;risk:"overdue"|"due_soon"|"normal"|"unknown"}>;
  timeRatio: null; timeLabel: string;
};
export type JourneyLogEntry = {id:string;at:string;actor:{id:string;name:string|null}|null;action:string;object:string;nodeKey:string|null;source:"task_event"|"task_assignment"};
export type JourneyLogPage = {items:JourneyLogEntry[];nextCursor:string|null;asOf:string;coverage:readonly string[]};
export type JourneyRiskHistory={eventId:string;nodeId:string;label:string;round:number|null;at:string|null;deadline:string|null;assessment:"late"|"not_late"|"insufficient";overdueSeconds:number|null;record:JourneyRecord|null};
export const JourneyLogFilterSchema=z.object({cursor:z.string().min(1).max(2048).optional()}).strict();

/** Complete generated node anchors include scope and work UUIDs (washing currently reaches121 characters). */
export const JOURNEY_NODE_ANCHOR_MAX_LENGTH = 200;

/** Stable, local-only return context. Consumers restore these values after domain handling. */
export const JourneyReturnContextSchema = JourneyFilterSchema.safeExtend({ milestone:z.string().max(500).optional(), materialNode:z.string().max(500).optional(),materialView:z.literal('expanded').optional(),materialFilter:z.enum(['all','pending','effective','mine']).optional(),materialScroll:z.coerce.number().int().min(0).max(1000000).optional(),materialFocus:z.string().max(500).optional(),nodeView:z.enum(['all','completed','active','not_started','overdue']).optional(), selected: z.string().uuid().optional(), flow: z.enum(["collapsed", "expanded"]).optional(), documentOpen:z.string().max(3000).optional(), documentView:z.literal('all').optional(), documentStage:z.enum(JOURNEY_STAGES.map(s=>s.key)).optional(), documentSearch:z.string().max(100).optional(), documentScroll:z.coerce.number().int().min(0).max(1000000).optional(), documentFocus:z.string().max(300).optional(), expanded: z.string().max(100).optional(), focus: z.string().max(JOURNEY_NODE_ANCHOR_MAX_LENGTH).optional(), row: z.string().max(JOURNEY_NODE_ANCHOR_MAX_LENGTH).optional(), round: z.coerce.number().int().positive().max(10000).optional() });
export function journeyReturnUrl(context: z.input<typeof JourneyReturnContextSchema>): string {
  const value = JourneyReturnContextSchema.parse(context);
  const params = new URLSearchParams();
  // Preserve an explicit all-phases selection separately from an absent
  // preference. The flow field independently retains collapsed time details.
  for (const [key, item] of Object.entries(value)) if (item !== undefined && (item !== "" || key === "milestone" || key === "expanded" || key === "row")) params.set(key, String(item));
  return `/ui/digital-cockpit?${params}`;
}
