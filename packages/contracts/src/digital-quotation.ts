import {z} from 'zod';
import {BudgetDocumentSchema,calculateBudget,type BudgetDocument,type BudgetRow} from './digital-budget.js';

export const QuotationDecimalSchema=z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/,'请输入最多六位小数的非负数字');
export const QuotationResourceSchema=z.object({kind:z.enum(['source','order']),id:z.string().uuid()}).strict();
export type QuotationResource=z.infer<typeof QuotationResourceSchema>;
export const QuotationAssignmentsSchema=z.array(z.object({
  rowId:z.string().uuid(),technicalAssigneeId:z.string().uuid().nullable(),
  priceAssigneeId:z.string().uuid().nullable(),priceRole:z.enum(['sample_designer','ie_reviewer','embroidery_washing_merchandiser','pattern_room_worker']),
}).strict()).max(300);
export type QuotationAssignment=z.infer<typeof QuotationAssignmentsSchema>[number];
export type QuotationMaterialPricingUnit={unit:string;sourceUnit:string;materialBasis:string;actorId:string;version:number;recordedAt:string};
/** Stable provenance for automatic rows; prices stay in the protected document. */
export type QuotationAssembly={schemaVersion:1;sourceVersion:number;roundNumber:number;fingerprint:string;materialPricingUnits?:Record<string,QuotationMaterialPricingUnit>;priorCraftRows?:Record<string,{row:BudgetRow;assignment:QuotationAssignment;priceSource?:{actorId:string;role:string;version:number;recordedAt:string;documentPriceHash?:string};ref:QuotationAssembly["rows"][string]}>;rows:Record<string,{kind:'material'|'ie'|'craft';sourceRef:string;basis:string;dependencyVersion?:2;assignmentVersion?:number;stage:'development'|'bulk';craftRef?:{libraryId:string;libraryVersion:number;stepId:string|null};artifactRevision?:string;priceBasis?:string}>};
export const SaveQuotationSchema=z.object({expectedVersion:z.number().int().nonnegative(),document:BudgetDocumentSchema,assignments:QuotationAssignmentsSchema}).strict().superRefine((v,c)=>{
  const ids=v.assignments.map(a=>a.rowId);
  if(new Set(ids).size!==ids.length||ids.length!==v.document.rows.length||v.document.rows.some(r=>!ids.includes(r.rowId)))c.addIssue({code:'custom',message:'每条报价明细须有且仅有一条责任分工'});
  if(v.document.imageAttachmentIds.length)c.addIssue({code:'custom',message:'报价沿用原单款图；确认依据请填写真实来源，不重复上传预算图片'});
});
export const QuotationRowInputSchema=z.object({expectedVersion:z.number().int().positive(),consumption:z.union([QuotationDecimalSchema,z.literal('')]).optional(),unitPrice:z.union([QuotationDecimalSchema,z.literal('')]).optional(),pricingUnit:z.string().trim().min(1,'请填写真实计价单位').max(100).optional(),artifactConsumption:z.object({id:z.string().uuid(),version:z.number().int().positive(),materialId:z.string().uuid()}).strict().optional()}).strict().refine(v=>v.consumption!==undefined||v.unitPrice!==undefined||v.artifactConsumption!==undefined||v.pricingUnit!==undefined,'请填写负责的用量、价格或计价单位').refine(v=>!(v.artifactConsumption&&v.consumption!==undefined),'采用成果时不同时提交另一份手工用量');
export const QuotationPricingInputSchema=z.object({
 field:z.enum(['multiplier','customerUnitPrice']),value:QuotationDecimalSchema,
}).strict();
export const QuotationConfirmationSchema=z.object({
  customerCode:z.string().trim().min(1).max(30),
  expectedVersion:z.number().int().positive(),customerConfirmedTotal:QuotationDecimalSchema,
  amountScope:z.enum(['per_piece','order_total']),quantity:z.number().int().positive().max(1_000_000_000).nullable(),
  quantityUnit:z.literal('件'),currency:z.literal('人民币'),taxBasis:z.enum(['excludes_tax','includes_tax']),
  sourceKind:z.literal('explicit_customer_confirmation'),sourceField:z.literal('customerConfirmedTotal'),
  templateVersion:z.literal('online-quotation-v1'),evidenceNote:z.string().trim().min(1).max(2000),
  confirmedAt:z.iso.datetime({offset:true}),
  workbenchPricing:QuotationPricingInputSchema.optional(),
}).strict().refine(v=>v.amountScope==='order_total'?v.quantity!==null:v.quantity===null,'整单金额须填确认件数；单件金额不填整单件数');
export type QuotationConfirmation=z.infer<typeof QuotationConfirmationSchema>;
export type QuotationConsumptionSource={kind:'technical_manual'|'technical_artifact';actorId:string;version:number;recordedAt:string;artifactRef?:{id:string;version:number;materialId?:string}};
export type QuotationVisibleRow=Omit<BudgetRow,'unitPrice'|'consumption'> & {secondaryCraftEntry?:boolean;craftBasis?:{stage:'development'|'bulk';libraryId:string;libraryVersion:number;stepId:string|null};unitPrice:string|null;consumption:string|null;assignment:QuotationAssignment;technicalAssigneeName?:string|null;technicalUsage?:'required'|'not_applicable'|'unknown';priceAssigneeName?:string|null;canEditConsumption:boolean;canEditPrice:boolean;canEditPricingUnit?:boolean;pricingUnitSource?:{sourceUnit:string;version:number;recordedAt:string};consumptionSource:QuotationConsumptionSource|null;technicalConsumptionIssue?:'unit_mismatch'};
export const IeProcessingStateSchema=z.enum(['needs_assignment','waiting','awaiting_price','priced']);
export const IeProcessingQuerySchema=z.object({page:z.coerce.number().int().min(1).max(100_000).default(1),
 search:z.string().trim().max(100).default(''),state:z.union([z.literal('all'),IeProcessingStateSchema]).default('all')}).strict();
export const QuotationStyleImageSchema=z.object({sourceId:z.uuid(),attachmentId:z.uuid(),documentVersion:z.number().int().positive()}).strict();
export const IeProcessingBasisSchema=z.object({
 sourceVersion:z.number().int().positive(),developmentType:z.string(),template:z.string(),instructions:z.string(),craft:z.string(),washing:z.string(),
 materials:z.array(z.object({category:z.string(),name:z.string(),specification:z.string()})),
 sizeUnit:z.string(),sizes:z.array(z.string()),measurements:z.array(z.object({name:z.string(),values:z.array(z.string())})),
 quantity:z.number().int().positive().nullable(),technicalVersion:z.number().int().positive().nullable(),
 formalPoNos:z.array(z.string()),styleImage:QuotationStyleImageSchema.nullable(),
}).strict();
export const IeProcessingEntrySchema=z.object({resource:QuotationResourceSchema,quoteId:z.string().uuid(),rowId:z.string().uuid(),
 version:z.number().int().positive(),round:z.number().int().positive(),styleNo:z.string(),customerCode:z.string().nullable(),
 assigneeId:z.string().uuid().nullable(),assigneeName:z.string().nullable(),state:IeProcessingStateSchema,canEditPrice:z.boolean(),orderRush:z.literal(true).optional(),
 basis:IeProcessingBasisSchema.nullable().optional(),
 priceReview:z.object({reviewId:z.uuid(),reason:z.string(),status:z.enum(['returned','resubmitted']),
  resubmitFieldVersion:z.number().int().positive().nullable(),canResubmit:z.boolean()}).strict().nullable().optional()}).strict();
export const IeProcessingDirectorySchema=z.object({page:z.number().int().positive(),pageSize:z.literal(15),total:z.number().int().nonnegative(),
 items:z.array(IeProcessingEntrySchema).max(15)}).strict();
export type IeProcessingEntry=z.infer<typeof IeProcessingEntrySchema>;
export type IeProcessingQuery=z.infer<typeof IeProcessingQuerySchema>;
export const UnifiedIeDirectoryKindSchema=z.enum(['processing_quote','sourcing_review','rework_review']);
export const UnifiedIeDirectoryStateSchema=z.enum(['not_started','awaiting_price','returned','priced']);
export const UnifiedIeDirectoryQuerySchema=z.object({kind:z.union([z.literal('all'),UnifiedIeDirectoryKindSchema]).default('all'),
 state:z.union([z.literal('all'),UnifiedIeDirectoryStateSchema]).optional(),
 page:z.coerce.number().int().min(1).max(100_000).default(1),search:z.string().trim().max(100).default('')}).strict();
export const UnifiedIeDirectoryEntrySchema=z.object({kind:UnifiedIeDirectoryKindSchema,objectId:z.uuid(),entryId:z.uuid(),
 resourceId:z.uuid(),orderId:z.string().nullable(),styleNo:z.string().nullable(),customerCode:z.string().nullable(),
 version:z.number().int().positive(),round:z.number().int().positive().nullable(),nativeStatus:z.string(),state:UnifiedIeDirectoryStateSchema,orderRush:z.literal(true).optional(),sortAt:z.iso.datetime({offset:true}),
 assigneeName:z.string().nullable().optional(),pricing:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('single'),amount:QuotationDecimalSchema,unit:z.string()}),z.object({kind:z.literal('multiple')}),
 ]).nullable().optional()}).strict();
export const UnifiedIeDirectoryPageSchema=z.object({page:z.number().int().positive(),pageSize:z.literal(15),total:z.number().int().nonnegative(),
 items:z.array(UnifiedIeDirectoryEntrySchema).max(15)}).strict();
export type UnifiedIeDirectoryQuery=z.infer<typeof UnifiedIeDirectoryQuerySchema>;
export type UnifiedIeDirectoryEntry=z.infer<typeof UnifiedIeDirectoryEntrySchema>;
export const QuotationReadinessSchema=z.object({
  canMeasure:z.boolean(),canConfirm:z.boolean(),reasons:z.array(z.string()),
}).strict();
export type QuotationReadiness=z.infer<typeof QuotationReadinessSchema>;
export type QuotationSheet={
  priorCraftRows?:Array<{row:BudgetRow;stage:'development'|'bulk'}>;
  automatic?:boolean;
  requiresWorkbenchPricing?:true;
  craftApprovalState?:'waiting'|'complete';
  complete?:boolean;
  workbenchReadiness?:QuotationReadiness;
  technicalConsumptionOptions?:Array<{artifactSetId:string;artifactVersion:number;materialId:string;name:string;unit:string;consumption:string}>;
  commandReceipt?:{action:string;appliedVersion:number};
  quoteId:string|null;resource:QuotationResource;productionOrderId:string|null;sourceId:string|null;
  designStyleNo:string;designerId:string;customerCode:string|null;version:number;status:'draft'|'confirmed';confirmedVersion:number|null;versions:number[];
  document:BudgetDocument|null;rows:QuotationVisibleRow[];assignments:QuotationAssignment[];
  confirmation:QuotationConfirmation|null;confirmedBy?:string;canStructure:boolean;canConfirm:boolean;fullCost:boolean;
  budget:{state:'waiting_formal_order'|'waiting_confirmation'|'created'|'review_required'|'legacy_published';version:number|null;workbench?:{canOpen:boolean;canEdit:boolean;reason:string}};
};
export type BudgetQuoteComparison={
  pendingQuotationVersion?:number|null;
  workbenchBasis?:'unconfirmed'|'customer_mismatch'|'adoption_required'|'craft_review_required'|'valid';
  policy:'legacy'|'quote_v1';quoteId:string|null;quoteVersion:number|null;currentConfirmedVersion:number|null;
  state:'legacy'|'waiting_confirmation'|'review_required'|'incomparable'|'within_limit'|'exceeds';reason:string;
  budgetComparableTotal:string|null;confirmedQuoteTotal:string|null;amountScope:'per_piece'|'order_total'|null;
  baseline:BudgetDocument|null;confirmation:QuotationConfirmation|null;
};
const SCALE=1_000_000_000_000n;
// The existing confirmation contract accepts six fractional digits. This
// storage precision is independent of the presentation's display rounding.
const QUOTATION_INPUT_SCALE=1_000_000n;
export function quotationExact(value:string):bigint{
  if(!/^\d+(?:\.\d{1,12})?$/.test(value))throw new Error('金额口径无效');
  const [whole,fraction='']=value.split('.');return BigInt(whole!)*SCALE+BigInt(fraction.padEnd(12,'0'));
}
export function quotationAmount(value:bigint):string{
  const sign=value<0n?'-':'';const n=value<0n?-value:value,f=(n%SCALE).toString().padStart(12,'0').replace(/0+$/,'');
  return `${sign}${n/SCALE}${f?'.'+f:''}`;
}

export type QuotationPricingInput = z.infer<typeof QuotationPricingInputSchema>;
export const SaveQuotationPricingDraftSchema = z.object({
  expectedVersion: z.number().int().positive(),
  input: QuotationPricingInputSchema,
}).strict();

const quotationReviewField = z.enum(['consumption', 'unitPrice']);
export type QuotationReviewField = z.infer<typeof quotationReviewField>;
const reviewFieldVersion = z.number().int().positive();
export const QuotationLineReviewCommandSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('return'), rowId:z.string().uuid(), field:quotationReviewField, expectedRound:z.number().int().positive(),
    expectedFieldVersion:reviewFieldVersion.nullable(), reason:z.string().trim().min(1).max(500)}).strict(),
  z.object({action:z.literal('resubmit'), reviewId:z.string().uuid(), expectedFieldVersion:reviewFieldVersion}).strict(),
  z.object({action:z.literal('resolve'), reviewId:z.string().uuid(), expectedFieldVersion:reviewFieldVersion}).strict(),
]);
export type QuotationLineReviewCommand = z.infer<typeof QuotationLineReviewCommandSchema>;

/** Totals adopted quotation rows. The original budget totals keep their own freight and CM rules. */
export function calculateQuotationUnitCost(document: BudgetDocument): string | null {
  if (!document.rows.length
    || document.rows.some(row => !row.name || !row.unit || row.consumption === '' || row.unitPrice === '')) return null;
  const total = calculateBudget(document).rows.reduce((amount, row) => amount + quotationExact(row.amount), 0n);
  return quotationAmount(total);
}

type QuotationPricing = {
  status: 'calculated' | 'cost_missing' | 'zero_cost' | 'price_out_of_range';
  customerUnitPrice: string | null;
  multiplierPercent: string | null;
  /** Exact percentage as a fraction of integers for a directly entered price. */
  exactMultiplierPercent: { numerator: string; denominator: string } | null;
};

/** Calculation only. The caller owns cost completeness, adopted versions and confirmation. */
export function calculateQuotationPricing(cost: string | null, rawInput: QuotationPricingInput): QuotationPricing {
  const input = QuotationPricingInputSchema.parse(rawInput);
  const multiplierInput = input.field === 'multiplier';
  const customerUnitPrice = multiplierInput ? null : input.value;
  const pending = { customerUnitPrice, multiplierPercent: null, exactMultiplierPercent: null };
  if (cost === null) return { ...pending, status: 'cost_missing' };
  const costExact = quotationExact(cost);
  if (costExact === 0n) return { ...pending, status: 'zero_cost' };

  const value = quotationExact(input.value);
  if (multiplierInput) {
    // Keep the entire fixed-point product. Round once, only when the result
    // is represented as an amount in the existing six-digit contract.
    const divisor = SCALE * SCALE * 100n / QUOTATION_INPUT_SCALE;
    const priceInMillionths = (costExact * value + divisor / 2n) / divisor;
    const price = quotationAmount(priceInMillionths * (SCALE / QUOTATION_INPUT_SCALE));
    if (!QuotationDecimalSchema.safeParse(price).success) return { ...pending, status: 'price_out_of_range' };
    return { ...pending, status: 'calculated', customerUnitPrice: price, multiplierPercent: input.value };
  }

  const numerator = value * 100n;
  const displayScale = 10_000n;
  const roundedPercent = (numerator * displayScale + costExact / 2n) / costExact;
  return {
    ...pending,
    status: 'calculated',
    multiplierPercent: quotationAmount(roundedPercent * (SCALE / displayScale)),
    exactMultiplierPercent: { numerator: numerator.toString(), denominator: costExact.toString() },
  };
}

type QuotationDraftReviewRow = {
  complete: boolean;
  reviews: readonly ('returned' | 'resubmitted')[];
  craftApproval: 'not_applicable' | 'pending' | 'approved';
};

/** Read-facing status only. Confirmation must still check the actual adopted identities under lock. */
export function quotationDraftReviewSummary(rows: readonly QuotationDraftReviewRow[]) {
  const counts = { returned: 0, resubmitted: 0, incomplete: 0, pendingCraftApproval: 0 };
  for (const row of rows) {
    for (const review of row.reviews) counts[review]++;
    if (!row.complete) counts.incomplete++;
    if (row.craftApproval === 'pending') counts.pendingCraftApproval++;
  }
  const status = counts.returned ? 'awaiting_correction'
    : counts.resubmitted ? 'awaiting_review'
    : counts.incomplete || rows.length === 0 ? 'incomplete'
    : counts.pendingCraftApproval ? 'awaiting_craft_approval'
    : 'awaiting_customer_confirmation';
  return { status, counts } as const;
}

export const QuotationWorkbenchPreviewSchema = z.object({
  resource: QuotationResourceSchema,
  quoteId: z.string().uuid(),
  version: z.number().int().positive(),
  unitCost: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(),
  status: z.enum(['awaiting_correction','awaiting_review','incomplete','awaiting_craft_approval','awaiting_customer_confirmation']),
  counts: z.object({
    returned:z.number().int().nonnegative(), resubmitted:z.number().int().nonnegative(),
    incomplete:z.number().int().nonnegative(), pendingCraftApproval:z.number().int().nonnegative(),
  }).strict(),
  saved: z.object({input:QuotationPricingInputSchema, version:z.number().int().positive()}).strict().nullable(),
  reviews: z.array(z.object({
    reviewId:z.string().uuid(), rowId:z.string().uuid(), field:quotationReviewField,
    status:z.enum(['returned','resubmitted']), reason:z.string(),
  }).strict()).max(600),
  confirmation: z.enum(['awaiting_joint_release','joint_release_ready']),
  readiness: QuotationReadinessSchema.optional(),
}).strict();

export function compareQuotationBudget(document:BudgetDocument,confirmation:QuotationConfirmation,quantity:number){
  if(confirmation.taxBasis!=='excludes_tax')return {state:'incomparable' as const,reason:'客户确认含税金额与当前不含税预算不可直接比较，请核对真实报价口径',budgetComparableTotal:null,confirmedQuoteTotal:confirmation.customerConfirmedTotal};
  if(confirmation.amountScope==='order_total'&&confirmation.quantity!==quantity)return {state:'incomparable' as const,reason:'正式订单件数与客户确认报价件数不一致，请复核报价版本',budgetComparableTotal:null,confirmedQuoteTotal:confirmation.customerConfirmedTotal};
  const cost=quotationExact(calculateBudget(document).cost)*(confirmation.amountScope==='order_total'?BigInt(quantity):1n),limit=quotationExact(confirmation.customerConfirmedTotal);
  return {state:cost<=limit?'within_limit' as const:'exceeds' as const,reason:cost<=limit?'预算总额不高于客户确认报价':'预算总额高于客户确认报价，不能发布（无特批）',budgetComparableTotal:quotationAmount(cost),confirmedQuoteTotal:confirmation.customerConfirmedTotal};
}
export type QuotationRowDelta={kind:'up'|'down'|'equal'|'new'|'unmatched';amount:string|null;percent:string|null;label:string};
export function quotationRowDelta(row:BudgetRow,baseline:BudgetRow|undefined):QuotationRowDelta{
  if(!baseline)return {kind:'new',amount:null,percent:null,label:'新增'};
  if(row.rowId!==baseline.rowId||row.section!==baseline.section||row.name!==baseline.name||row.specification!==baseline.specification||row.unit!==baseline.unit||[row.consumption,row.unitPrice,baseline.consumption,baseline.unitPrice].includes(''))return {kind:'unmatched',amount:null,percent:null,label:'未匹配口径'};
  const amount=(r:BudgetRow)=>quotationExact(r.consumption)*quotationExact(r.unitPrice)/SCALE;
  const before=amount(baseline),delta=amount(row)-before;
  if(delta===0n)return {kind:'equal',amount:'0',percent:before===0n?null:'0.00',label:'— 持平'};
  if(before===0n)return {kind:'new',amount:quotationAmount(delta),percent:null,label:'新增（原金额为零）'};
  const magnitude=delta<0n?-delta:delta,rounded=(magnitude*10_000n+before/2n)/before;
  const percent=`${rounded/100n}.${(rounded%100n).toString().padStart(2,'0')}`;
  return {kind:delta>0n?'up':'down',amount:quotationAmount(delta),percent,label:`${delta>0n?'↑':'↓'} ${percent}%`};
}
