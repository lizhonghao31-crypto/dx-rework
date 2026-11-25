import {z} from 'zod';

export const PREPARATION_RULE_VERSION='production-readiness-20261101';
export const PREPARATION_MATERIAL_KINDS=['design_handover','material_investment','fabric_receipt','color_confirmation','accessories_ready','style_label_ready'] as const;
export type PreparationMaterialKind=typeof PREPARATION_MATERIAL_KINDS[number];
export const preparationMaterialLabels:Record<PreparationMaterialKind,string>={design_handover:'设计交资料',material_investment:'投面辅料',fabric_receipt:'面料实际到仓',color_confirmation:'对色完成',accessories_ready:'辅料实物备齐',style_label_ready:'款号唛实物备齐'};
// These are discrete pieces only; packages/boxes have no implicit conversion.
export const isStyleLabelPieceUnit=(unit:string)=>['枚','个','件'].includes(unit.trim());
export const normalizeStyleLabelUnit=(unit:string)=>isStyleLabelPieceUnit(unit)?'枚':null;
const quantity=z.object({lineId:z.uuid().nullable(),materialId:z.uuid().nullable(),name:z.string().trim().min(1).max(200),quantity:z.number().positive().max(10000000),unit:z.string().trim().min(1).max(20)}).strict();
export const PreparationMaterialRecordSchema=z.object({
 kind:z.enum(PREPARATION_MATERIAL_KINDS),scopeRef:z.string().trim().min(1).max(150).default('whole'),
 expectedVersion:z.number().int().nonnegative(),state:z.enum(['ready','partial','unknown','withdrawn']),
 occurredAt:z.iso.datetime({offset:true}).nullable(),note:z.string().trim().min(1).max(1000),
 quantities:z.array(quantity).max(400).default([]),evidenceIds:z.array(z.uuid()).max(40).default([]),
 sourceDocumentVersion:z.number().int().positive().nullable().default(null),
 orderInstructionVersion:z.number().int().positive().optional(),
 recipientId:z.uuid().nullable().default(null),
 investmentMaterialId:z.uuid().optional(),
 investmentQuantityCorrection:z.object({index:z.number().int().nonnegative(),previous:quantity}).strict().optional(),
}).strict().transform(x=>({...x,quantities:x.quantities.map(q=>({...q,unit:x.kind==='style_label_ready'?(normalizeStyleLabelUnit(q.unit)??q.unit):q.unit}))})).superRefine((x,c)=>{
 if(x.orderInstructionVersion!==undefined&&(x.kind!=='design_handover'||x.sourceDocumentVersion!==null))
  c.addIssue({code:'custom',path:['orderInstructionVersion'],message:'正式制单版本仅用于制单交接，不能同时引用开发资料版本'});
 if(x.investmentQuantityCorrection&&(x.kind!=='material_investment'||!['ready','partial'].includes(x.state)||x.quantities.length!==1))
  c.addIssue({code:'custom',path:['investmentQuantityCorrection'],message:'投面辅料订正必须明确原明细，且只提交一条替换明细'});
 if(x.investmentMaterialId&&(x.kind!=='material_investment'||!x.quantities.some(row=>row.materialId===x.investmentMaterialId)))
  c.addIssue({code:'custom',path:['investmentMaterialId'],message:'须选择本次实际登记的投面辅料'});
 if(['ready','partial'].includes(x.state)&&!x.occurredAt)c.addIssue({code:'custom',path:['occurredAt'],message:'实际办理须填写真实发生时间'});
 if(['unknown','withdrawn'].includes(x.state)&&x.occurredAt)c.addIssue({code:'custom',path:['occurredAt'],message:'未知或撤回不填写完成时间'});
 if(x.kind==='style_label_ready'&&x.quantities.some(q=>!isStyleLabelPieceUnit(q.unit)))c.addIssue({code:'custom',path:['quantities'],message:'款号唛须按枚、个或件计数；箱、包和长度单位不能自动折算'});
 if(x.kind==='style_label_ready'&&x.quantities.some(q=>!Number.isSafeInteger(q.quantity)))c.addIssue({code:'custom',path:['quantities'],message:'款号唛实物数量须为整数'});
 if(x.state==='ready'&&['material_investment','accessories_ready','style_label_ready'].includes(x.kind)&&!x.quantities.length)c.addIssue({code:'custom',path:['quantities'],message:'请记录本次物料及实际数量'});
 if(new Set(x.quantities.map(q=>JSON.stringify([q.lineId,q.materialId,q.name,q.unit]))).size!==x.quantities.length)c.addIssue({code:'custom',path:['quantities'],message:'同一款色物料及单位不能重复，请合并实际数量'});
 if(new Set(x.evidenceIds).size!==x.evidenceIds.length)c.addIssue({code:'custom',path:['evidenceIds'],message:'凭证不可重复'});
});
const WarehouseReceiptRefSchema=z.object({recordId:z.uuid(),version:z.number().int().positive()}).strict();
export const WarehouseReceiptBatchSchema=z.object({
 kind:z.enum(['fabric_receipt','accessories_ready']),
 scopeRef:z.string().trim().min(1).max(150).default('whole'),
 materialId:z.uuid(),lineId:z.uuid().nullable(),supplierId:z.uuid().nullable(),unit:z.string().trim().min(1).max(20),
 investment:WarehouseReceiptRefSchema,materialFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
 expectedReceiptVersion:z.number().int().nonnegative(),
 replaces:WarehouseReceiptRefSchema.optional(),
 quantity:z.string().regex(/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/).refine(value=>Number(value)<=10000000,'实收数量超出允许范围'),
 occurredAt:z.iso.datetime({offset:true}),note:z.string().trim().min(1).max(1000),
 evidenceIds:z.array(z.uuid()).max(40).refine(ids=>new Set(ids).size===ids.length,'凭证不可重复').default([]),
}).strict().refine(value=>Number(value.quantity)>0||Boolean(value.replaces),'只有订正已登记的原收料才能记录零');
export const WarehouseNativeTaskQuerySchema=z.object({
 kind:z.enum(['preshrink','dispatch']),status:z.enum(['open','completed']).default('open'),
 page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(''),
}).strict();
export const WarehouseReceiptPageQuerySchema=z.object({
 status:z.enum(['open','completed']).default('open'),
 page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(''),
}).strict();
export type WarehouseReceiptPageQuery=z.infer<typeof WarehouseReceiptPageQuerySchema>;
export type WarehouseNativeTaskQuery=z.infer<typeof WarehouseNativeTaskQuerySchema>;
export type WarehouseReceiptBatch=z.infer<typeof WarehouseReceiptBatchSchema>;
export type WarehouseReceiptBatchEvidence=Pick<WarehouseReceiptBatch,'kind'|'scopeRef'|'materialId'|'lineId'|'supplierId'|'unit'|'investment'|
 'materialFingerprint'|'replaces'|'quantity'>;
type WarehouseQuantity={quantity:string;unit:string};
type WarehouseReceiptRef=z.infer<typeof WarehouseReceiptRefSchema>;
export type WarehouseReceiptWorkItem={
 kind:WarehouseReceiptBatch['kind'];materialId:string;name:string;scopeRef:string;lineId:string|null;supplier:string|null;
 basis:{resource:PreparationResource;kind:WarehouseReceiptBatch['kind'];scopeRef:string;materialId:string;lineId:string|null;adoptedRef:string;supplierId:string|null;unit:string};
 purchase:{invested:WarehouseQuantity;investedAt:string;original:WarehouseReceiptRef;handover:WarehouseReceiptRef};
 received:WarehouseQuantity|null;
 productionRequired:WarehouseQuantity|null;
 balance:{unit:string|null;procurementRemaining:string|null;excessReceived:string|null;productionShortage:string|null;dispatchRemaining:string|null};
 receiptVersion:number;
 activeBatches:{ref:WarehouseReceiptRef;quantity:WarehouseQuantity;occurredAt:string}[];
};
export type WarehouseReceiptListItem=Pick<WarehouseReceiptWorkItem,'kind'|'materialId'|'name'|'lineId'|'scopeRef'|'supplier'|'received'|'productionRequired'|'balance'> & {
 id:string;resource:PreparationResource;orderNumber:string|null;customerCode:string|null;orderRush?:true;
 poNumber:string|null; assigneeName:string|null; invested:WarehouseQuantity; investedAt:string;
};
export type WarehouseReceiptPage={items:WarehouseReceiptListItem[];page:number;total:number};
export type PreparationMaterialRecord=z.infer<typeof PreparationMaterialRecordSchema>;
export const preparationInvestmentRowKey=(row:PreparationMaterialRecord['quantities'][number])=>
 JSON.stringify([row.materialId,row.lineId,row.unit,row.materialId?null:row.name]);
export type PreparationResource={kind:'source'|'order';id:string};
export type MaterialInvestmentScopeBasis={
  materialIds:string[];materialFingerprints:Record<string,string>;sourceDocumentVersion?:number;orderInstructionVersion?:number;fingerprint:string;
  handoverRecordId:string;handoverVersion:number;preorder?:true;
 };
 type InvestmentOccurrence={fingerprint:string;occurredAt:string};
 export type StyleLabelRecordRef={recordId:string;version:number;resource:PreparationResource;scopeRef:string;occurredAt:string|null};
 export type StyleLabelOccurrence={ruleVersion:number;orderId:string;lineId:string;requiredQuantity:number;requirementFingerprint:string;quantityFingerprint:string;
   record:StyleLabelRecordRef;completedAt:string|null;precision:'instant'|'unknown';source:StyleLabelRecordRef|null;reason:string|null};
 export type PreparationMaterialFact=Omit<PreparationMaterialRecord,'investmentQuantityCorrection'>&{warehouseReceipt?:WarehouseReceiptBatchEvidence;styleLabelOccurrences?:Record<string,StyleLabelOccurrence>;styleLabelRequirementsBasis?:{orderId:string;fingerprint:string};investmentScopeBasis?:MaterialInvestmentScopeBasis;investmentMaterialOccurrences?:Record<string,InvestmentOccurrence>;investmentQuantityOccurrences?:Record<string,InvestmentOccurrence>;handoverMaterials?:Array<{name:string;quantity:string;color:string;specification:string;materialId?:string;category?:'主布'|'配布'|'辅料';supplier?:string;supplierId?:string}>;recordId:string;version:number;resource:PreparationResource;recordedAt:string;recordedBy:string;operatorName:string;valid:boolean;invalidReasons:string[]};
export const PreparationResponsibilitySchema=z.object({expectedVersion:z.number().int().nonnegative(),warehouseWorkerId:z.uuid().nullable(),colorConfirmationWorkerId:z.uuid().nullable(),colorConfirmationRole:z.string().trim().min(1).max(100).nullable(),reason:z.string().trim().min(1).max(1000)}).strict().refine(x=>Boolean(x.colorConfirmationWorkerId)===Boolean(x.colorConfirmationRole),'对色确认人和现有岗位须同时选择');
export type PreparationResponsibility=z.infer<typeof PreparationResponsibilitySchema>;
export const PreparationAdoptionSchema=z.object({previewRevision:z.string().min(1),reason:z.string().trim().min(1).max(1000)}).strict();
export const InstructionDeliverySchema=z.object({instructionVersion:z.number().int().positive(),recipient:z.string().trim().min(1).max(200),occurredAt:z.iso.datetime({offset:true}),note:z.string().trim().min(1).max(1000),evidenceIds:z.array(z.uuid()).max(40).default([])}).strict();
export type InstructionDelivery=z.infer<typeof InstructionDeliverySchema>;
export type PreparationWindow={startedAt:string|null;dueAt:string|null;completedAt:string|null;minutes:number|null;reason:string|null;status:'waiting'|'running'|'overdue'|'completed_on_time'|'completed_late'|'unknown'};
export const CloseMaterialInvestmentReminderSchema=z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(1000)}).strict();
export type MaterialInvestmentReminder={
 fingerprint:string;handoverId:string;handoverVersion:number|null;adoptedPlanId:string;
 startedAt:string|null;dueAt:string;warningAt:string|null;exclusive:boolean;
 calendar:'continuous'|'natural_days'|'beijing_sunday_excluded';percent:number;enabled:boolean;status:'waiting'|'warning'|'overdue';
 closed:{actorId:string;at:string;reason:string}|null;termination:{at:string|null;kind:'cancelled'|'special_closure'}|null;
};
export type ProductionReadinessState={
 materialInvestmentReminder?:MaterialInvestmentReminder&{canClose:boolean};
 sourceIsPreorderDraft:boolean;sourceDocumentVersion:number|null;orderInstructionVersion?:number|null;lines:Array<{lineId:string;color:string;orderQuantity:number}>;resource:PreparationResource;orderId:string|null;sourceId:string|null;enrolled:boolean;ruleVersion:string|null;revision:string;
 facts:PreparationMaterialFact[];history:PreparationMaterialFact[];canRecord:PreparationMaterialKind[];
 responsibility:{version:number;warehouseWorkerId:string|null;colorConfirmationWorkerId:string|null;colorConfirmationRole:string|null};canAssign:boolean;
 canDeliverInstruction:boolean;canAcknowledgeAdoption:boolean;canAdopt:boolean;adoptionAcknowledged:boolean;adoptionReason:string|null;
 finalReasons:string[];technicalRevision:string|null;draftWindow:PreparationWindow;finalWindow:PreparationWindow;
 instructionDeliveries:Array<{eventId:string;instructionVersion:number;recipient:string;occurredAt:string;note:string;evidenceIds:string[]}>;
 ranges:Array<{rangeId:string;preparationId:string;kind:string;version:number;lineIds:string[];complete:boolean;pendingMaterialIds:string[];note:string;recordedAt:string;evidenceIds:string[];basis:Record<string,unknown>}>;
};
export const QualityNativeTaskQuerySchema=z.object({
  kind:z.enum(['craft','factory']),status:z.enum(['open','completed']).default('open'),
  page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(''),
}).strict();
export type QualityNativeTaskQuery=z.infer<typeof QualityNativeTaskQuerySchema>;
