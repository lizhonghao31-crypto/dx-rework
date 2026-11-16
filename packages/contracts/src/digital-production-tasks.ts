import { z } from "zod";
export const DigitalTaskStateSchema = z.enum(["pending", "ready", "blocked", "completed", "cancelled"]);
export const DigitalTimeQualitySchema = z.enum(["现场登记", "补报未核实", "已核实", "缺失"]);
export const DigitalTaskCompleteSchema = z.object({ occurredAt: z.iso.datetime({ offset: true }).nullable().optional(), note: z.string().trim().max(1000).default("") }).strict();
export const DigitalTaskBlockSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export const DigitalTaskAssignmentSchema = z.object({ assigneeId: z.string().uuid() }).strict();
export const DigitalDeadlinePolicySchema = z.object({ expectedVersion: z.number().int().positive(), slaHours: z.number().positive().max(8760).nullable(), warningRatio: z.number().gt(0).lt(1), note: z.string().trim().max(1000).default("") }).strict();
export const DigitalTimeCorrectionSchema = z.object({ eventId: z.string().uuid(), occurredAt: z.iso.datetime({ offset: true }).nullable(), reason: z.string().trim().min(1).max(1000) }).strict();
export type DigitalTaskState = z.infer<typeof DigitalTaskStateSchema>;
export type DigitalTimeQuality = z.infer<typeof DigitalTimeQualitySchema>;
export type DigitalTaskBlocker = {condition:string;name:string;missing:string;responsibleRole:string;action:string|null;evidenceId:string|null;verified:boolean};
export type DigitalTask = {
  /** Fixed B for this authorized work only. dueAt remains its own R-based D. */
  plannedTargets?: {state:'ready'|'pending';targets:Array<{scopeRef:string;lineId:string|null;targetRevision:string;startAt:string|null;endAt:string|null;precision:'instant'|'date';date:string|null}>};
  retiredRule?:string;
  /** Present only for a server-verified isolated Acceptance resource. */
  acceptanceBusinessNow?:string;
  deadlineExclusive?:boolean;
  deadlineMode?:"duration"|"date_target"|"unlimited";
  unmetConditions?:DigitalTaskBlocker[];
  identity?: { designStyleNo: string; customerCode: string | null } | null;
  craftSequence?:number;stepRef?:string;craftKind?:"embroidery"|"printing"|"special";priority?: "normal" | "urgent"; taskId: string; orderId: string | null; sourceId: string | null; taskKind: string; label: string;
  assigneeId: string | null; state: DigitalTaskState; routeVersion: number; occurrence: number;
  enteredAt: string | null; recordedAt: string; completedAt: string | null; paused: boolean;
  dueAt: string | null; warningAt: string | null; slaHours: number | null; policyVersion: number;
  routeProgress: {applicable:number;completed:number;cancelled:number};
  assigneeName: string | null; requiredRole: string; hasHandover: boolean; canManage: boolean; canCorrect: boolean; canControl: boolean;
  timeQuality: DigitalTimeQuality; blockedReason: string | null; canExecute: boolean;
};
export type DigitalDeadlinePolicy = { nodeKey: string; label: string; version: number; slaHours: number | null; warningRatio: number; changedAt: string; changedBy: string | null; note: string; applicationScope?: "new_orders"; warningRatioEditable?: boolean; durationRequired?: boolean; durationEditable?: boolean };

export type DigitalTaskDocumentReference = {state:"unavailable"|"not_applicable"|"missing"|"draft"} | {state:"published";id:string;version:number;label:"本次采用"|"当前有效"};
export type DigitalTaskDocuments = {development:DigitalTaskDocumentReference;instruction:DigitalTaskDocumentReference;budget:DigitalTaskDocumentReference};

/** Explanations of existing gates, never additional prerequisites or approvals. */
export function digitalConditionGuidance(condition:string,requiredRole:string):Pick<DigitalTaskBlocker,'name'|'missing'|'responsibleRole'|'action'> {
 const known:Record<string,[string,string,string,string]>={
  business_recorded:['办理结果','本次业务结果尚未提交',requiredRole,'在本任务「当前办理」填写实际结果并提交'],
  handover_received:['实际交接','尚无本任务的实际接收记录',requiredRole,'实际收到实物或资料后，在本任务「确认实际接收」登记；提前安排不能代替接收'],
  materials_ready:['材料核验','本轮材料可用条件尚未满足','development_clerk','在本单核料／复核任务查看逐项缺料或质量原因，完成实际核验'],
  pattern_assignment_ready:['车板执行衔接','本轮车板执行记录尚未就绪','development_clerk','在本单总委派核对人员与执行资料；正常首轮前置齐备后自动衔接，返工金额由技术主管在原执行单核定'],
  washing_finished:['洗水完成','尚无本轮洗水完成记录','development_clerk','在本轮洗水任务登记实际完成结果'],
  owner_approved:['原外发批准','当前选厂方案尚无有效老板批准','owner_group','在本单原外发选厂审批核对当前方案并办理；旧版批准不能替代当前方案'],
  pattern_ready:['纸样／唛架','本轮纸样或唛架尚未完成','pattern_room_worker','在本单大货纸样任务完成实际纸样和唛架记录'],
  preshrink_ready:['预缩','本轮预缩条件尚未满足','warehouse_receiver','在本单预缩任务按有效制单登记实际预缩结果'],
  craft_returned:['工艺回仓','尚无本轮工艺回仓事实','embroidery_washing_merchandiser','在本单工艺物流登记实际回仓'],
  qc_approved:['工艺QC','本轮整款工艺QC尚未通过','quality_control','在本单工艺QC处理待检项目并记录实际结果'],
  customer_confirmed:['客户样板','当前开发轮次尚无客户确认记录','sample_designer','取得客户实际确认后，在本单开发办理页登记客户样板确认'],
  all_po_complete:['PO／颜色汇合','仍有PO或颜色未完成','order_merchandiser','在本单生产进度逐项核对未完成PO／颜色，并由对应工序岗位办理'],
  factory_arrived:['工厂到料','尚无所需的工厂到料事实','order_merchandiser','在本单工厂材料记录核对实际到料并登记'],
 };
 const row=known[condition];
 return row?{name:row[0],missing:row[1],responsibleRole:row[2],action:row[3]}:{name:'条件待核实',missing:'系统尚未提供这项条件的具体业务原因，不能据此判断为缺料或未安排',responsibleRole:'系统管理员',action:'请重新读取本任务；仍存在时提供任务链接给管理员核查'};
}
