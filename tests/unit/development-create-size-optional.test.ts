import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {DevelopmentDocumentSchema,developmentPublishErrors,developmentSizeQuantityIssues,developmentMaterialPublishIssues,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema,initialCustomerOrderIsReady,salesYearOptions} from '@dx-rework/contracts/digital-production';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {developmentDraftForSave,developmentRevisionForSave} from '../../apps/api/src/production-platform/development-document-format.js';
import {developmentAmendmentErrors} from '@dx-rework/contracts/digital-development-amendments';
import {developmentIssues} from '../../apps/web/src/digital-development-validation.js';

const order=()=>InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-ID',temporaryStyleNo:null,orderDate:'2026-11-01',contractDeliveryDate:null,salesYear:2027,salesSeries:'P05',requiresColorMatching:false,lines:[{color:'蓝',deliveryDate:'2027-03-15',sizes:[{size:'',quantity:''}]}]});
const calendar={serverToday:'2026-11-01',minimumInitialCustomerDate:'2026-12-01'};
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
    expect(initialCustomerOrderIsReady(order(),calendar)).toBe(false);
    const invalid={...initialDevelopmentDocument(),quantity:2,sizes:['M'],sizeQuantities:[1],measurements:[],orderDate:'2026-11-01',files:[{attachmentId:randomUUID(),kind:'款图' as const}]};
    expect(developmentPublishErrors(invalid).join()).toContain('合计');
    expect(DigitalOrderCreateSchema.safeParse({...order(),lines:[{color:'蓝',sizes:[]}]}).success).toBe(false);
  });
  it('keeps all ordering fields editable until every PO has a customer promise',()=>{
    const complete=order();complete.lines[0]!.sizes=[{size:'M',quantity:'12'}];
    expect(initialCustomerOrderIsReady(complete,calendar)).toBe(true);
    const missing=structuredClone(complete);missing.lines[0]!.deliveryDate=null;
    expect(initialCustomerOrderIsReady(missing,calendar)).toBe(false);
    missing.contractDeliveryDate='2027-03-15';
    expect(initialCustomerOrderIsReady(missing,calendar)).toBe(false);
    const mixed=structuredClone(complete);mixed.lines.push({...missing.lines[0]!,color:'红'});
    expect(initialCustomerOrderIsReady(mixed,calendar)).toBe(false);
    missing.lines[0]!.customerWarehouseArrivalDate='2027-03-15';
    expect(initialCustomerOrderIsReady(missing,calendar)).toBe(true);
  });
  it('rejects publication of a fully filled preorder until explicitly changed to development',()=>{
    const document={...initialDevelopmentDocument(),quantity:1,orderDate:'2026-11-01',files:[{attachmentId:randomUUID(),kind:'款图' as const}],customerOrderDraft:{withOrder:true,stage:'preorder' as const,order:order()}};
    expect(developmentPublishErrors(document)).toContain('预下单备料资料仅可保存草稿，请先明确切换为开发单后再发布');
    expect(developmentPublishErrors({...document,customerOrderDraft:{...document.customerOrderDraft,stage:'formal'}})).toEqual([]);
  });
  it('uses the supplied server calendar for invalid, mixed and next-day promises without inventing dates',()=>{
    const value=order();value.lines[0]!.sizes=[{size:'M',quantity:'12'}];
    expect(initialCustomerOrderIsReady(value,undefined)).toBe(false);
    value.lines[0]!.deliveryDate='2026-11-15';expect(initialCustomerOrderIsReady(value,calendar)).toBe(false);
    value.lines[0]!.deliveryDate='2026-12-01';expect(initialCustomerOrderIsReady(value,calendar)).toBe(true);
    expect(initialCustomerOrderIsReady(value,{serverToday:'2026-11-02',minimumInitialCustomerDate:'2026-12-02'})).toBe(false);
    value.lines.push({...value.lines[0]!,color:'红',deliveryDate:'2026-11-15'});
    expect(initialCustomerOrderIsReady(value,calendar)).toBe(false);
    value.lines.pop();value.lines[0]!.deliveryDate='2027-03-15';value.orderDate='2026-11-02';
    expect(initialCustomerOrderIsReady(value,calendar)).toBe(false);
    expect(initialCustomerOrderIsReady(value,{serverToday:'2026-11-02',minimumInitialCustomerDate:'2026-12-02'})).toBe(true);
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

describe('versioned workbench sheets preserve the legacy document contract',()=>{
  const draft=():DevelopmentDocument=>({
    ...initialDevelopmentDocument(),orderDate:'2026-11-01',quantity:2,
    workbenchSheet:{
      version:1,styleName:'外套',brand:'TEST',gender:'女装',boardType:'船头版',processingSelected:true,referenceNote:'纸样说明',
      sewingRows:[{rowId:randomUUID(),color:'蓝',size:'',quantity:null}],
    },
  });
  it('validates only the declared new fields and actual fabric rows before publication',()=>{
    const sheet=draft();
    const fabric={...sheet.materials[0]!,name:'斜纹布',composition:'棉',width:'120 cm',supplier:'TEST 布行'};
    const auxiliary={...sheet.materials[0]!,materialId:randomUUID(),category:'辅料' as const,name:'钮扣',label:'辅料'};
    sheet.materials=[fabric,auxiliary,{...sheet.materials[0]!,materialId:randomUUID()}];
    expect(DevelopmentDocumentSchema.parse(sheet)).toEqual(sheet);
    expect(developmentPublishErrors(sheet)).toEqual([]);
    expect(developmentMaterialPublishIssues({...sheet,materials:[{...fabric,supplier:''},auxiliary]})).toEqual([
      expect.objectContaining({materialId:fabric.materialId,field:'supplier'}),
    ]);
    const legacy={...sheet};delete legacy.workbenchSheet;
    expect(developmentPublishErrors(legacy).join()).toMatch(/请上传款图.*缺规格.*预计日期/);
    expect(developmentPublishErrors({...sheet,workbenchSheet:{...sheet.workbenchSheet!,styleName:'',processingSelected:false}})).toEqual([
      '请填写或选择款名','请填写或选择加工类型',
    ]);
  });
  it('keeps sample pictures in the same document, stable row IDs and original version guards',()=>{
    const sheet=draft(),attachmentId=randomUUID();
    sheet.materials[0]!.sampleAttachmentId=attachmentId;
    expect(DevelopmentDocumentSchema.safeParse(sheet).success).toBe(false);
    sheet.files=[{attachmentId,kind:'款图'}];
    expect(DevelopmentDocumentSchema.safeParse(sheet).success).toBe(false);
    sheet.files=[{attachmentId,kind:'局部图'}];
    expect(DevelopmentDocumentSchema.parse(sheet)).toEqual(sheet);
    expect(DevelopmentDocumentSchema.safeParse({...sheet,workbenchSheet:{...sheet.workbenchSheet!,sewingRows:[...sheet.workbenchSheet!.sewingRows,...sheet.workbenchSheet!.sewingRows]}}).success).toBe(false);
    const downgraded={...sheet};delete downgraded.workbenchSheet;
    expect(()=>developmentDraftForSave(downgraded,sheet,'2026-11-01T00:00:00Z')).toThrow(/不能移除/);
    expect(()=>developmentRevisionForSave(downgraded,sheet)).toThrow(/须保留/);
    expect(()=>developmentDraftForSave(sheet,downgraded,'2026-11-01T00:00:00Z')).toThrow(/沿用/);
    expect(()=>developmentRevisionForSave(sheet,downgraded)).toThrow(/沿用/);
    expect(developmentAmendmentErrors(sheet,downgraded)).toHaveLength(1);
    expect(developmentAmendmentErrors(sheet,{...sheet,materials:sheet.materials.map(row=>({...row,available:true}))}).length).toBeGreaterThan(0);
  });
});
