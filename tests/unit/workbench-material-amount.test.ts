import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {workbenchMaterialAmount} from '../../apps/web/src/workbench-material-amount.js';
import {initialDevelopmentDocument,sameDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DevelopmentDocumentSchema,DevelopmentMaterialSchema,developmentAuxiliaryPlanningPublishIssues,developmentPublishErrors} from '@dx-rework/contracts/digital-development';
import {validateDevelopmentMaterialPlan,withDevelopmentMaterialLineTotals} from '../../apps/api/src/production-platform/development-document-format.js';
import {sameDevelopmentMaterialBasis,withoutDevelopmentPrices} from '../../apps/api/src/production-platform/development-commercial-fields.js';
import {readDevelopmentMaterialSuppliers,validateDevelopmentMaterialSuppliers} from '../../apps/api/src/production-platform/development-material-suppliers.js';

describe('C2 exact workbench material line totals',()=>{
 it('uses the exact price rather than its one-decimal presentation',()=>{
  expect(workbenchMaterialAmount({quantity:'400 米',pricingUnit:'米',unitPrice:'0.35'})).toEqual({exact:'140',label:'140'});
  expect(workbenchMaterialAmount({quantity:'200',quantityUnit:'件',pricingUnit:'件',unitPrice:'12'})).toEqual({exact:'2400',label:'2400'});
 });
 it('preserves exact values and does not disguise small positive totals as zero',()=>{
  expect(workbenchMaterialAmount({quantity:'1件',pricingUnit:'件',unitPrice:'0.000001'})).toEqual({exact:'0.000001',label:'小于 0.1'});
  expect(workbenchMaterialAmount({quantity:'0.50 件',pricingUnit:'件',unitPrice:'25'})).toEqual({exact:'12.5',label:'12.5'});
  expect(workbenchMaterialAmount({quantity:'1件',pricingUnit:'件',unitPrice:'0'})).toEqual({exact:'0',label:'0'});
 });
 it('does not invent a missing price, missing quantity or unsupported conversion',()=>{
  expect(workbenchMaterialAmount({quantity:'20 码',pricingUnit:'米',unitPrice:'8'})).toBeNull();
  expect(workbenchMaterialAmount({quantity:'20',pricingUnit:'米',unitPrice:'8'})).toBeNull();
  expect(workbenchMaterialAmount({quantity:'20米',quantityUnit:'码',pricingUnit:'米',unitPrice:'8'})).toBeNull();
  expect(workbenchMaterialAmount({quantity:'1米',pricingUnit:'米',unitPrice:''})).toBeNull();
 });
 it('recalculates and redacts a server line total without confusing the exact save acknowledgement',()=>{
  const draft=initialDevelopmentDocument(),material=draft.materials[0]!;
  Object.assign(material,{quantity:'400 米',pricingUnit:'米',unitPrice:'0.35',lineTotal:'999',supplier:'TEST 原供应商',
   supplierReference:{supplierId:'00000000-0000-4000-8000-000000000001',version:1}});
  const saved=withDevelopmentMaterialLineTotals({...draft,materialSupplierCatalog:true});
  expect(saved.materials[0]?.lineTotal).toBe('140');
  expect(withoutDevelopmentPrices(saved).materials[0]).not.toHaveProperty('lineTotal');
  expect(withoutDevelopmentPrices(saved).materials[0]).not.toHaveProperty('unitPrice');
  expect(sameDevelopmentDocument(saved,draft)).toBe(true);
  const changed=structuredClone(draft);
  changed.materials[0]!.supplierReference!.version=2;
  expect(sameDevelopmentDocument(saved,changed)).toBe(false);
  material.quantity='400 码';
  expect(withDevelopmentMaterialLineTotals({...draft,materialSupplierCatalog:true}).materials[0]).not.toHaveProperty('lineTotal');
 });
});

describe('C2 material supplier snapshot authority',()=>{
 const supplierId='00000000-0000-4000-8000-000000000001';
 const row={supplier_id:supplierId,supplier_code:'TEST-05',supplier_name:'TEST 原布行',version:3};
 const materialDraft=()=>{
  const draft=initialDevelopmentDocument();
  Object.assign(draft.materials[0]!,{name:'TEST 面料',supplier:row.supplier_name,supplierReference:{supplierId,version:3}});
  return draft;
 };
 it('returns only the bounded fabric projection and validates the selected exact active version',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{...row,bank_account:'TEST should not be returned'}]});
  const db={query} as unknown as PoolClient;
  expect(await readDevelopmentMaterialSuppliers(db,' 原布行 ')).toEqual([{supplierId,code:row.supplier_code,name:row.supplier_name,version:3}]);
  expect(query).toHaveBeenCalledWith(expect.stringMatching(/supplier_type='fabric' AND active=true[\s\S]+LIMIT 20/),['原布行']);
  query.mockClear();
  await validateDevelopmentMaterialSuppliers(db,materialDraft(),undefined,{catalog:true});
  expect(query.mock.calls[0]?.[0]).toContain("FOR SHARE");
  const changed=materialDraft();changed.materials[0]!.supplierReference!.version=2;
  await expect(validateDevelopmentMaterialSuppliers(db,changed,undefined,{catalog:true})).rejects.toMatchObject({code:'DEVELOPMENT_CONFLICT'});
 });
 it('keeps the unchanged historical supplier but does not adopt an unauthoritative new name',async()=>{
  const query=vi.fn();
  const db={query} as unknown as PoolClient;
  const legacy=materialDraft();delete legacy.materials[0]!.supplierReference;
  await validateDevelopmentMaterialSuppliers(db,structuredClone(legacy),legacy,{catalog:true,publish:true});
  await expect(validateDevelopmentMaterialSuppliers(db,legacy,undefined,{catalog:true})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  const unchanged=materialDraft();
  await validateDevelopmentMaterialSuppliers(db,structuredClone(unchanged),unchanged,{catalog:true,publish:true});
  expect(query).not.toHaveBeenCalled();
 });
});

describe('C2 auxiliary planning remains distinct from material receipt',()=>{
 const base=initialDevelopmentDocument();
 const auxiliary={...base.materials[0]!,category:'辅料' as const,label:'TEST 辅料',name:'TEST 拉链'};
 const doc={...base,templateConfirmed:true as const,materials:[auxiliary]};
 it('keeps unknown historical data unknown and accepts draft gaps, but blocks explicit no without date on publication',()=>{
  expect(developmentAuxiliaryPlanningPublishIssues(doc)).toEqual([]);
  const noDate={...doc,materials:[{...auxiliary,designerHasMaterial:false}]};
  expect(DevelopmentDocumentSchema.safeParse(noDate).success).toBe(true);
  const missing=developmentAuxiliaryPlanningPublishIssues(noDate);
  expect(missing).toEqual([{materialId:auxiliary.materialId,field:'expectedDate',message:'TEST 辅料选择了没有实物，请填写预计日期'}]);
  expect(developmentPublishErrors(noDate)).toContain(missing[0]!.message);
  const withDate={...doc,materials:[{...auxiliary,designerHasMaterial:false,expectedDate:'2026-12-03'}]};
  expect(developmentAuxiliaryPlanningPublishIssues(withDate)).toEqual([]);
  expect(withDate.materials[0]?.available).toBe(false);
 });
 it('does not treat even an explicit yes as an arrival or let fabric adopt the auxiliary-only control',()=>{
  const yes={...auxiliary,designerHasMaterial:true};
  expect(sameDevelopmentMaterialBasis(auxiliary,yes)).toBe(true);
  expect(()=>validateDevelopmentMaterialPlan({...doc,materials:[yes]},doc)).not.toThrow();
  expect(()=>validateDevelopmentMaterialPlan({...doc,materials:[{...yes,available:true}]},doc)).toThrow(/不能登记或改写实到/);
  expect(DevelopmentMaterialSchema.safeParse({...yes,category:'主布'}).success).toBe(false);
  expect(()=>validateDevelopmentMaterialPlan({...doc,materials:[{...base.materials[0]!,expectedDate:'2026-12-03'}]},base)).toThrow(/面料沿原跟单流程/);
 });
});
