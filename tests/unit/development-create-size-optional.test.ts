import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {DevelopmentDocumentSchema,developmentPublishErrors,developmentSizeQuantityIssues} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema,initialCustomerOrderIsReady,salesYearOptions} from '@dx-rework/contracts/digital-production';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {developmentIssues} from '../../apps/web/src/digital-development-validation.js';

const order=()=>InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-ID',temporaryStyleNo:null,orderDate:'2026-11-01',contractDeliveryDate:null,salesYear:2027,salesSeries:'P05',requiresColorMatching:false,lines:[{color:'蓝',deliveryDate:'2027-03-15',sizes:[{size:'',quantity:''}]}]});
describe('development creation sizes are optional for both order intents',()=>{
  for(const withOrder of [false,true])it(`publishes without fabricated sizes withOrder=${withOrder}`,()=>{
    const document={...initialDevelopmentDocument(),quantity:1,orderDate:'2026-11-01',files:[{attachmentId:randomUUID(),kind:'款图' as const}],...(withOrder?{customerOrderDraft:{withOrder,order:order()}}:{})};
    expect(document.sizes).toEqual([]);expect(document.sizeQuantities).toEqual([]);
    expect(DevelopmentDocumentSchema.safeParse(document).success).toBe(true);
    expect(developmentPublishErrors(document)).toEqual([]);
    expect(developmentIssues(document,'1',document.measurements.map(()=>randomUUID()),true,null,[])).toEqual([]);
    expect(developmentSizeQuantityIssues(document).length).toBeGreaterThan(0);
  });
  it('preserves strict actual PO and supplied per-size quantity validation',()=>{
    expect(initialCustomerOrderIsReady(order())).toBe(false);
    const invalid={...initialDevelopmentDocument(),quantity:2,sizes:['M'],sizeQuantities:[1],measurements:[],orderDate:'2026-11-01',files:[{attachmentId:randomUUID(),kind:'款图' as const}]};
    expect(developmentPublishErrors(invalid).join()).toContain('合计');
    expect(DigitalOrderCreateSchema.safeParse({...order(),lines:[{color:'蓝',sizes:[]}]}).success).toBe(false);
  });
  it('keeps all ordering fields editable until every PO has a customer promise',()=>{
    const complete=order();complete.lines[0]!.sizes=[{size:'M',quantity:'12'}];
    expect(initialCustomerOrderIsReady(complete)).toBe(true);
    const missing=structuredClone(complete);missing.lines[0]!.deliveryDate=null;
    expect(initialCustomerOrderIsReady(missing)).toBe(false);
    missing.contractDeliveryDate='2027-03-15';
    expect(initialCustomerOrderIsReady(missing)).toBe(false);
    const mixed=structuredClone(complete);mixed.lines.push({...missing.lines[0]!,color:'红'});
    expect(initialCustomerOrderIsReady(mixed)).toBe(false);
    missing.lines[0]!.customerWarehouseArrivalDate='2027-03-15';
    expect(initialCustomerOrderIsReady(missing)).toBe(true);
  });
  it('rejects publication of a fully filled preorder until explicitly changed to development',()=>{
    const document={...initialDevelopmentDocument(),quantity:1,orderDate:'2026-11-01',files:[{attachmentId:randomUUID(),kind:'款图' as const}],customerOrderDraft:{withOrder:true,stage:'preorder' as const,order:order()}};
    expect(developmentPublishErrors(document)).toContain('预下单备料资料仅可保存草稿，请先明确切换为开发单后再发布');
    expect(developmentPublishErrors({...document,customerOrderDraft:{...document.customerOrderDraft,stage:'formal'}})).toEqual([]);
  });
  it('retains historical sales years and distinguishes series from a customer promise',()=>{
    expect(salesYearOptions('2026-11-01')).toEqual([2026,2027]);
    expect(salesYearOptions('2027-01-01',2025)).toEqual([2025,2027,2028]);
    expect(salesYearOptions(undefined,2025)).toEqual([2025]);
    const value=order();expect(value.salesSeries).toBe('P05');expect(value.requiresColorMatching).toBe(false);expect(value.lines[0]?.deliveryDate).toBe('2027-03-15');
    expect('plannedShippingDate' in value).toBe(false);
    expect(InitialCustomerOrderDraftSchema.safeParse({...value,salesSeries:'P13'}).success).toBe(false);
  });
});
