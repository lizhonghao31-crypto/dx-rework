import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {calculateQuotationPricing,calculateQuotationUnitCost,compareQuotationBudget,QuotationConfirmationSchema,QuotationPricingInputSchema,QuotationRowInputSchema,quotationDraftReviewSummary,quotationRowDelta,type QuotationConfirmation} from '../../packages/contracts/src/digital-quotation.js';
import type {BudgetDocument,BudgetRow} from '../../packages/contracts/src/digital-budget.js';
const row=(price='1'):BudgetRow=>({rowId:randomUUID(),section:'主料',category:'',name:'TEST面料',specification:'平纹',unit:'米',supplier:'TEST',consumption:'1',unitPrice:price});
const document=(rows:BudgetRow[]):BudgetDocument=>({fabricType:'针织',productCategory:'上衣',monthSeries:'',date:'2026-11-01',currency:'人民币',rows,freight:'0',cm:'0',salePrice:'999',outsourcingScope:'车缝',outsourcingUnitPrice:'8',imageAttachmentIds:[]});
const confirmation=(total='1'):QuotationConfirmation=>QuotationConfirmationSchema.parse({expectedVersion:1,customerCode:'PD',customerConfirmedTotal:total,amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST 客户确认记录',confirmedAt:'2026-01-01T00:00:00Z'});
describe('PR02 confirmed customer total and reference differences',()=>{
 it('allows <=, refuses a one-trillionth excess without substituting salePrice or rounded display',()=>{
  expect(compareQuotationBudget(document([row('1')]),confirmation('1'),5).state).toBe('within_limit');
  const a=row('0.000001');a.consumption='0.000001';const d=document([row('1'),a]);expect(compareQuotationBudget(d,confirmation('1'),5)).toMatchObject({state:'exceeds',budgetComparableTotal:'1.000000000001'});
 });
 it('compares order totals with frozen quantity and refuses incompatible tax/quantity',()=>{
  const c={...confirmation('10'),amountScope:'order_total' as const,quantity:5};expect(compareQuotationBudget(document([row('2')]),c,5).state).toBe('within_limit');
  expect(compareQuotationBudget(document([row('2')]),c,6).state).toBe('incomparable');
  expect(compareQuotationBudget(document([row('2')]),{...c,taxBasis:'includes_tax'},5).state).toBe('incomparable');
 });
 it('uses stable row identity, units/specification and honest new/zero/unknown differences',()=>{
  const base=row('2');expect(quotationRowDelta({...base,unitPrice:'3'},base)).toMatchObject({kind:'up',percent:'50.00',label:'↑ 50.00%'});
  expect(quotationRowDelta({...base,unitPrice:'1'},base)).toMatchObject({kind:'down',percent:'50.00'});
  expect(quotationRowDelta(base,base).kind).toBe('equal');
  expect(quotationRowDelta({...base,unitPrice:'0'},{...base,unitPrice:'0'})).toMatchObject({kind:'equal',percent:null});
  expect(quotationRowDelta(base,{...base,unitPrice:'0'})).toMatchObject({kind:'new',percent:null});
  for(const changed of [{...base,unit:'码'},{...base,specification:'斜纹'},{...base,unitPrice:''}])expect(quotationRowDelta(changed,base).kind).toBe('unmatched');
  expect(quotationRowDelta(base,undefined).kind).toBe('new');
 });
 it('permits individual increases when total stays within the frozen customer ceiling',()=>{
  const a=row('5'),b=row('5'),d=document([{...a,unitPrice:'6'},{...b,unitPrice:'3'}]);expect(quotationRowDelta(d.rows[0]!,a).kind).toBe('up');expect(compareQuotationBudget(d,confirmation('10'),1).state).toBe('within_limit');
 });
 it('rejects malformed amounts, unknown fields and impossible confirmation quantity',()=>{
  for(const value of ['Infinity','NaN','1e4','-1','0.0000001'])expect(QuotationRowInputSchema.safeParse({expectedVersion:1,consumption:value}).success).toBe(false);
  expect(QuotationRowInputSchema.safeParse({expectedVersion:1,unitPrice:'2',canBypass:true}).success).toBe(false);
  expect(QuotationRowInputSchema.safeParse({expectedVersion:1,pricingUnit:'米'}).success).toBe(true);
  for(const pricingUnit of ['', ' ', 'x'.repeat(101)])expect(QuotationRowInputSchema.safeParse({expectedVersion:1,pricingUnit}).success).toBe(false);
  expect(QuotationConfirmationSchema.safeParse({...confirmation(),amountScope:'order_total',quantity:null}).success).toBe(false);
  expect(QuotationConfirmationSchema.safeParse({...confirmation(),sourceField:'cost'}).success).toBe(false);
 });
});

describe('Workbench pricing calculation',()=>{
 it('adds material, IE and adopted craft units exactly without changing budget extras',()=>{
  const material={...row('0.000001'),consumption:'0.000001'};
  const ie={...row('9'),section:'外发工序',name:'IE加工',unit:'件'} as const;
  const craft={...row('5'),section:'外发工序',name:'印花',unit:'件'} as const;
  expect(calculateQuotationUnitCost({...document([material,ie,craft]),freight:'2',cm:'7'})).toBe('14.000000000001');
  expect(calculateQuotationUnitCost(document([{...material,unitPrice:''},ie,craft]))).toBeNull();
  expect(calculateQuotationUnitCost(document([row('0')]))).toBe('0');
 });
 it('preserves the last edited input when cost changes',()=>{
  const multiplier={field:'multiplier',value:'130'} as const;
  expect(calculateQuotationPricing('100',multiplier)).toMatchObject({status:'calculated',customerUnitPrice:'130',multiplierPercent:'130'});
  expect(calculateQuotationPricing('90',multiplier)).toMatchObject({status:'calculated',customerUnitPrice:'117',multiplierPercent:'130'});
  expect(calculateQuotationPricing('100',{field:'customerUnitPrice',value:'80'})).toMatchObject({status:'calculated',customerUnitPrice:'80',multiplierPercent:'80'});
  const price={field:'customerUnitPrice',value:'125.000001'} as const;
  expect(calculateQuotationPricing('100',price)).toMatchObject({status:'calculated',customerUnitPrice:price.value,multiplierPercent:'125'});
  expect(calculateQuotationPricing('90',price)).toMatchObject({status:'calculated',customerUnitPrice:price.value,multiplierPercent:'138.8889'});
 });
 it('rounds a generated price once at the existing confirmation precision, not at cents',()=>{
  const fullRate={field:'multiplier',value:'100'} as const;
  expect(calculateQuotationPricing('0.005',fullRate).customerUnitPrice).toBe('0.005');
  expect(calculateQuotationPricing('0.000000499999',fullRate).customerUnitPrice).toBe('0');
  expect(calculateQuotationPricing('0.0000005',fullRate).customerUnitPrice).toBe('0.000001');
  expect(calculateQuotationPricing('1.23456789',{field:'multiplier',value:'137.5'})).toMatchObject({
   status:'calculated',customerUnitPrice:'1.697531',multiplierPercent:'137.5',
  });
 });
 it('keeps the exact ratio and original input for a manually entered price',()=>{
  const result=calculateQuotationPricing('3',{field:'customerUnitPrice',value:'1.000000'});
  expect(result).toMatchObject({customerUnitPrice:'1.000000',multiplierPercent:'33.3333'});
  const ratio=result.exactMultiplierPercent!;
  expect(BigInt(ratio.numerator)*3n).toBe(BigInt(ratio.denominator)*100n);
 });
 it('distinguishes incomplete cost, zero cost, an explicit zero price and an out-of-range result',()=>{
  const customerPrice={field:'customerUnitPrice',value:'0'} as const;
  expect(calculateQuotationPricing(null,customerPrice)).toMatchObject({status:'cost_missing',customerUnitPrice:'0',multiplierPercent:null});
  expect(calculateQuotationPricing('0',customerPrice)).toMatchObject({status:'zero_cost',customerUnitPrice:'0',multiplierPercent:null});
  expect(calculateQuotationPricing('50',customerPrice)).toMatchObject({status:'calculated',customerUnitPrice:'0',multiplierPercent:'0'});
  expect(calculateQuotationPricing('0',{field:'multiplier',value:'125'})).toMatchObject({status:'zero_cost',customerUnitPrice:null,multiplierPercent:null});
  expect(calculateQuotationPricing('9999999999',{field:'multiplier',value:'1000'})).toMatchObject({status:'price_out_of_range',customerUnitPrice:null});
 });
 it('rejects a second price input and preserves the original decimal limits',()=>{
  expect(QuotationPricingInputSchema.safeParse({field:'multiplier',value:'100',customerUnitPrice:'90'}).success).toBe(false);
  for(const value of ['','-1','1.0000001','1e2','10000000000']) expect(QuotationPricingInputSchema.safeParse({field:'customerUnitPrice',value}).success).toBe(false);
 });
});

describe('Workbench quotation review summary',()=>{
 it('shows the blocking state in order and keeps counts for other blockers',()=>{
  const returned={complete:true,reviews:['returned'],craftApproval:'not_applicable'} as const;
  const resubmitted={complete:true,reviews:['resubmitted'],craftApproval:'not_applicable'} as const;
  const incomplete={complete:false,reviews:[],craftApproval:'not_applicable'} as const;
  const pendingCraft={complete:true,reviews:[],craftApproval:'pending'} as const;
  const approvedCraft={...pendingCraft,craftApproval:'approved'} as const;
  expect(quotationDraftReviewSummary([{...returned,reviews:['returned','resubmitted']},returned,incomplete,pendingCraft])).toEqual({
   status:'awaiting_correction',counts:{returned:2,resubmitted:1,incomplete:1,pendingCraftApproval:1},
  });
  expect(quotationDraftReviewSummary([returned,resubmitted,incomplete,pendingCraft]).status).toBe('awaiting_correction');
  expect(quotationDraftReviewSummary([resubmitted,incomplete,pendingCraft]).status).toBe('awaiting_review');
  expect(quotationDraftReviewSummary([incomplete,pendingCraft]).status).toBe('incomplete');
  expect(quotationDraftReviewSummary([pendingCraft]).status).toBe('awaiting_craft_approval');
  expect(quotationDraftReviewSummary([approvedCraft]).status).toBe('awaiting_customer_confirmation');
  expect(quotationDraftReviewSummary([]).status).toBe('incomplete');
 });
});
