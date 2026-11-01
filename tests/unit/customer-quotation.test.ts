import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {compareQuotationBudget,QuotationConfirmationSchema,QuotationRowInputSchema,quotationRowDelta,type QuotationConfirmation} from '../../packages/contracts/src/digital-quotation.js';
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
  expect(QuotationConfirmationSchema.safeParse({...confirmation(),amountScope:'order_total',quantity:null}).success).toBe(false);
  expect(QuotationConfirmationSchema.safeParse({...confirmation(),sourceField:'cost'}).success).toBe(false);
 });
});
