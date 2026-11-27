import type {ProductionReadinessState} from "./production-readiness.js";
import { z } from "zod";
import type { DigitalTask } from "./digital-production-tasks.js";
export const BulkDispatchSchema=z.object({expectedVersion:z.number().int().nonnegative(),patternWorkerId:z.string().uuid().nullable(),warehouseWorkerId:z.string().uuid().nullable().optional(),cuttingWorkerId:z.string().uuid().nullable().optional(),deliverPattern:z.boolean().default(false)}).strict();
export type BulkDispatch=z.infer<typeof BulkDispatchSchema>;
export const BulkCompletionSchema=z.object({preparationId:z.string().uuid(),kind:z.enum(["纸样完成","唛架完成","预缩完成"]),expectedReadinessRevision:z.string().min(1).optional(),range:z.object({expectedVersion:z.number().int().nonnegative(),lineIds:z.array(z.uuid()).min(1).max(400),complete:z.boolean(),pendingMaterialIds:z.array(z.uuid()).max(400),note:z.string().trim().min(1).max(1000),evidenceIds:z.array(z.uuid()).max(40)}).strict().optional()}).strict();
export type BulkCompletion=z.infer<typeof BulkCompletionSchema>;
export type BulkCuttingProgress={mode:"in_house"|"outsourced"|null;completed:boolean;lines:Array<{lineId:string;poNumber:string|null;formalStyleNo:string|null;temporaryStyleNo:string|null;color:string;cuttingOrderId:string|null;orderQuantity:number;actualCutCount:number|null;pieceCount:number|null;corrected:boolean}>};
export type BulkPreparationReference={designStyleNo:string;customerCode:string|null;styleImageUrl:string|null;instructionVersion:number|null;sourceRound:number|null};
/** Frozen published instruction basis; separate from current task eligibility. */
export type PublishedProductionBasis={instructionVersion:number;sourceId:string|null;sourceRound:number|null;publishedAt:string|null;technicalArtifact:{id:string;version:number;sourceId:string;roundNumber:number;scopeRef:string}|null;technicalBasisState:'recorded'|'missing'|'restricted'};
export type BulkPreparationSheet={publishedBasis?:PublishedProductionBasis|null;physicalCuttingReasons?:string[];readiness?:ProductionReadinessState;materials?:BulkMaterialsView;fabric?:{report:({reportId:string;material:string;arrivedAt:string|null;inspectedAt:string|null;result:'合格'|'不合格'|null;note:string;operatorId:string;receiptBatches?:BulkFabricBatchRef[]})|null;decision:({decisionId:string;reportId:string;allowUse:boolean;note:string;operatorId:string})|null;usable:boolean;usableAt:string|null;warehouseCoverageCurrent?:boolean;warehouseInspection?:{eligible:boolean;reasons:string[];firstReceiptAt:string|null;firstReceiptRef?:BulkFabricBatchRef['receipt']|null;basisRevision?:string;cutover?:{generation:number;mode:'active'|'safe_read'};writePaused?:string;lots?:Array<BulkFabricBatchRef&{name:string;quantity:{quantity:string;unit:string};occurredAt:string}>}};canReportFabric?:boolean;canDecideFabric?:boolean;reference:BulkPreparationReference;cutting:BulkCuttingProgress;orderId:string;instructionVersion:number|null;sourceRound:number|null;adoptedRound?:number|null;customerConfirmed:boolean;ownerApproved:boolean;instructionValid:boolean;reasons:string[];preparationId:string|null;preshrink:string|null;dispatch:{version:number;patternWorkerId:string|null;warehouseWorkerId:string|null;cuttingWorkerId:string|null};canDispatchPattern:boolean;canDispatchWarehouse:boolean;facts:Array<{kind:string;recordedAt:string}>;tasks:DigitalTask[]};

export const BulkWorkroomFilterSchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(""),scope:z.enum(["mine","all"]).default("mine")}).strict();
export type BulkWorkroomFilter=z.infer<typeof BulkWorkroomFilterSchema>;
export type BulkWorkroomResult={page:number;pageSize:15;total:number;items:Array<{orderId:string;designStyleNo:string;customer:string|null;sheet:BulkPreparationSheet}>};
export type BulkPatternCardTask=Pick<DigitalTask,'taskId'|'sourceId'|'orderId'|'assigneeName'|'state'|'blockedReason'|'slaHours'|'enteredAt'|'completedAt'|'dueAt'|'warningAt'|'deadlineExclusive'|'acceptanceBusinessNow'>;
export type BulkPatternCardSummary={
 preparationId:string|null;
 reasons:string[];
 facts:Array<{kind:string}>;
 task:BulkPatternCardTask|null;
 lines:Array<Pick<BulkCuttingProgress['lines'][number],'lineId'|'poNumber'|'formalStyleNo'|'temporaryStyleNo'|'color'>>;
};
export type BulkPatternCardPage={page:number;pageSize:15;total:number;items:Array<{
 orderId:string;designStyleNo:string;customer:string|null;orderRush?:true;card:BulkPatternCardSummary;
}>};

const FabricReceiptRef=z.object({recordId:z.uuid(),version:z.number().int().positive()}).strict();
const quantityRowKey=z.string().min(1).max(750);
const MaterialIssueReceiptRef=FabricReceiptRef.extend({quantityRowKey:quantityRowKey.optional()});
export const BulkFabricBatchRefSchema=z.object({materialId:z.uuid(),lineId:z.uuid().nullable().optional(),quantityRowKey:quantityRowKey.optional(),receipt:FabricReceiptRef}).strict();
export type BulkFabricBatchRef=z.infer<typeof BulkFabricBatchRefSchema>;
export const BulkFabricReportSchema=z.object({expectedReportId:z.string().uuid().nullable(),expectedReceiptVersion:z.number().int().nonnegative().optional(),expectedWarehouseBasisRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),material:z.string().trim().min(1).max(200),
 receiptBatches:z.array(BulkFabricBatchRefSchema).min(1).max(100).optional(),
 arrivedAt:z.iso.datetime({offset:true}).nullable(),inspectedAt:z.iso.datetime({offset:true}).nullable(),result:z.enum(['合格','不合格']).nullable(),note:z.string().trim().min(1).max(1000)
}).strict().refine(v=>(v.result===null)===(v.inspectedAt===null),'检验结论和完成时间需同时填写')
 .refine(v=>!v.arrivedAt||!v.inspectedAt||Date.parse(v.inspectedAt)>=Date.parse(v.arrivedAt),'检验完成不能早于到仓');
export type BulkFabricReport=z.infer<typeof BulkFabricReportSchema>;
export const BulkFabricDecisionSchema=z.object({reportId:z.string().uuid(),expectedDecisionId:z.string().uuid().nullable(),allowUse:z.boolean(),note:z.string().trim().min(1).max(1000)}).strict();
export type BulkFabricDecision=z.infer<typeof BulkFabricDecisionSchema>;

export const BulkMaterialIssueAllocationSchema=z.object({receipt:MaterialIssueReceiptRef,quantity:z.string().regex(/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/)
 .refine(value=>Number(value)>0&&Number(value)<=10000000,'发料数量须大于零且不超出允许范围')}).strict();
const MaterialIssueScopeSchema=z.object({scopeRef:z.string().trim().min(1).max(150),lineId:z.uuid().nullable(),
 allocations:z.array(BulkMaterialIssueAllocationSchema).min(1).max(100)}).strict();
export const BulkMaterialsDispatchSchema=z.object({instructionVersion:z.number().int().positive(),supplierId:z.string().uuid(),occurredAt:z.iso.datetime({offset:true}),note:z.string().trim().max(1000).default(''),items:z.array(z.object({materialId:z.string().uuid(),quantity:z.number().positive().max(10000000),unit:z.string().trim().min(1).max(20),scope:MaterialIssueScopeSchema.optional()}).strict()).min(1).max(400)}).strict();
export type BulkMaterialsDispatch=z.infer<typeof BulkMaterialsDispatchSchema>;
type BulkMaterialIssueOption={scopeRef:string;lineId:string|null;poLabel:string;unit:string;required:string;remaining:string;
 lots:{receipt:z.infer<typeof MaterialIssueReceiptRef>;remaining:{unit:string;quantity:string};occurredAt:string}[]};
export type BulkMaterialsView={canDispatch:boolean;supplierId:string|null;supplierName:string|null;instructionVersion:number|null;items:Array<{id:string;name:string;specification:string;materialColor:string;group:string;kind?:'fabric';issueOptions?:BulkMaterialIssueOption[]}>;history:Array<{eventId:string;occurredAt:string;operatorName:string;note:string;items:Array<{materialId:string;name:string;quantity:number;unit:string}>}>};
