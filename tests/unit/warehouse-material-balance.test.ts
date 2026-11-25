import { describe, expect, it } from 'vitest';
import { currentWarehouseReceiptQuantity, warehouseMaterialBalance, warehouseReceiptBatches, scopedWarehouseReceiptQuantity, warehouseReceiptTaskBasis, type WarehouseReceiptBasis, type WarehouseReceiptMovement } from '../../apps/api/src/production-platform/warehouse-material-balance.js';
import {preparationHash,preparationInvestmentScope,warehouseReceiptMaterialCurrent} from '../../apps/api/src/production-platform/preparation-material-repository.js';

const metres = (quantity: string) => ({ quantity, unit: '米' });
const original = {
  unit: '米', invested: metres('520'), received: metres('500'), productionRequired: metres('500'),
  usableAfterOccupancy: metres('500'), dispatchRequired: metres('500'), dispatched: metres('300'),
};

describe('warehouse material balances for one verified basis', () => {
  it('separates purchasing shortage, production shortage and dispatch remainder', () => {
    expect(warehouseMaterialBalance(original)).toEqual({ unit: '米', procurementRemaining: '20', excessReceived: '0',
      productionShortage: '0', dispatchRemaining: '200' });
    expect(warehouseMaterialBalance({ ...original, usableAfterOccupancy: metres('400') })).toMatchObject({
      procurementRemaining: '20', productionShortage: '100', dispatchRemaining: '200' });
  });

  it('keeps explicit zero apart from history with no recorded quantity or available stock', () => {
    expect(warehouseMaterialBalance({ ...original, received: null, usableAfterOccupancy: null, dispatched: metres('0') }))
      .toMatchObject({ procurementRemaining: null, excessReceived: null, productionShortage: null, dispatchRemaining: '500' });
    expect(warehouseMaterialBalance({ ...original, received: metres('0') })).toMatchObject({ procurementRemaining: '520', excessReceived: '0' });
  });

  it('does not combine unconverted units or accept an inferred unit', () => {
    expect(warehouseMaterialBalance({ ...original, received: { quantity: '500', unit: '码' }, dispatched: { quantity: '1', unit: '箱' } }))
      .toMatchObject({ procurementRemaining: null, excessReceived: null, productionShortage: '0', dispatchRemaining: null });
    expect(warehouseMaterialBalance({ ...original, unit: null })).toMatchObject({ procurementRemaining: null, productionShortage: null });
  });

  it('preserves real excess and exact fractional differences', () => {
    expect(warehouseMaterialBalance({ ...original, received: metres('530.001'), dispatchRequired: metres('0.3'), dispatched: metres('0.2') }))
      .toMatchObject({ procurementRemaining: '0', excessReceived: '10.001', dispatchRemaining: '0.1' });
  });
});

describe('original current authorized material receipt', () => {
  it('keeps source accessory receipts through unrelated changes but not the same material with changed specifications',()=>{
    const material={materialId:'lace-1',category:'辅料' as const,quantity:'520',name:'TEST original',color:'黑',specification:'2m',supplier:'TEST supplier'};
    const evidence={kind:'accessories_ready' as const,scopeRef:'whole',materialId:material.materialId,lineId:null,supplierId:null,
     unit:'米',investment:{recordId:'TEST purchase',version:1},materialFingerprint:preparationHash(preparationInvestmentScope([material]).rows[0]),quantity:'500'};
    expect(warehouseReceiptMaterialCurrent('source',evidence,[material,{...material,materialId:'lace-2',specification:'new unrelated material'}],null)).toBe(true);
    expect(warehouseReceiptMaterialCurrent('source',evidence,[{...material,specification:'3m'}],null)).toBe(false);
    expect(warehouseReceiptMaterialCurrent('source',evidence,[{...material,supplier:'different supplier'}],null)).toBe(false);
    expect(warehouseReceiptMaterialCurrent('source',evidence,[material,material],null)).toBe(false);
    expect(warehouseReceiptMaterialCurrent('order',evidence,[material],null)).toBe(false);
  });
  const scope = { resource: { kind: 'order' as const, id: 'TEST-PARENT' }, kind: 'fabric_receipt' as const,
    scopeRef: 'whole', materialId: 'TEST-COTTON', lineId: null, unit: '米' };
  const part = { materialId: scope.materialId, lineId: null, quantity: 300.25, unit: '米' };
  const received = { ...scope, state: 'partial', valid: true, occurredAt: '2026-11-25T01:00:00Z', quantities: [part] };

  it('reads only the exact current receipt resource, material, unit and physical scope', () => {
    const quantity = currentWarehouseReceiptQuantity(received, scope);
    expect(quantity).toEqual(metres('300.25'));
    expect(warehouseMaterialBalance({ ...original, received: quantity, usableAfterOccupancy: null })).toMatchObject({
      procurementRemaining: '219.75', productionShortage: null,
    });
    expect(currentWarehouseReceiptQuantity(received, { ...scope, lineId: 'TEST-OTHER-PO' })).toBeNull();
    expect(currentWarehouseReceiptQuantity(received, { ...scope, resource: { ...scope.resource, id: 'TEST-NEIGHBOUR' } })).toBeNull();
    expect(currentWarehouseReceiptQuantity(received, { ...scope, unit: '码' })).toBeNull();
  });

  it('does not turn unknown or ambiguous historical snapshots into quantities', () => {
    expect(currentWarehouseReceiptQuantity({ ...received, state: 'ready', quantities: [] }, scope)).toBeNull();
    expect(currentWarehouseReceiptQuantity({ ...received, occurredAt: null }, scope)).toBeNull();
    expect(currentWarehouseReceiptQuantity({ ...received, valid: false }, scope)).toBeNull();
    expect(currentWarehouseReceiptQuantity({ ...received, quantities: [part, part] }, scope)).toBeNull();
  });
});

describe('authoritative warehouse batch receipt arithmetic',()=>{
 const batches=[
  {id:'receipt-first',quantity:metres('200.125')},
  {id:'receipt-second',quantity:metres('300')},
  {id:'receipt-correction',replaces:'receipt-first',quantity:metres('199.75')},
 ];
 it('adds independent batches and replaces only the exactly selected live correction target',()=>{
  expect(warehouseReceiptBatches('米',batches)).toEqual(metres('499.75'));
  expect(warehouseReceiptBatches('米',[...batches,{id:'receipt-correction-2',replaces:'receipt-correction',quantity:metres('200')}])).toEqual(metres('500'));
  expect(warehouseReceiptBatches('米',[{id:'receipt-cancel',replaces:'receipt-first',quantity:metres('0')},...batches])).toBeNull();
 });
 it('fails closed for stale, duplicate, incompatible or missing provenance instead of inventing quantity',()=>{
  expect(warehouseReceiptBatches('米',[...batches,{id:'receipt-correction-2',replaces:'receipt-first',quantity:metres('201')}])).toBeNull();
  expect(warehouseReceiptBatches('米',[...batches,batches[0]!])).toBeNull();
  expect(warehouseReceiptBatches('米',[...batches,{id:'different-unit',quantity:{quantity:'5',unit:'码'}}])).toBeNull();
  expect(warehouseReceiptBatches('米',[])).toBeNull();
 });
});

describe('X3 scope-bound physical receipt movements',()=>{
 const basis:WarehouseReceiptBasis={resource:{kind:'source',id:'TEST-source'},kind:'fabric_receipt',scopeRef:'whole',
   materialId:'TEST-shared-cotton',lineId:null,adoptedRef:'TEST-source-doc-v4',supplierId:'TEST-mill',unit:'米'};
 const time='2026-11-25T06:00:00Z',asOf='2026-11-25T06:20:00Z';
 const movement=(recordId:string,version:number,quantity:string,current:WarehouseReceiptBasis=basis):WarehouseReceiptMovement=>
  ({basis:current,original:{recordId,version},quantity:metres(quantity),occurredAt:time,valid:true});
 it('counts a shared material once and does not reuse separate PO, foreign supplier, old adopted version or another formal order',()=>{
  const same=[movement('a',1,'300'),movement('a',2,'200')];
  const other=[
   movement('other-po',1,'11',{...basis,lineId:'TEST-po'}),
   movement('other-supplier',1,'15',{...basis,supplierId:'TEST-other-mill'}),
   movement('old-adopted',1,'20',{...basis,adoptedRef:'TEST-source-doc-v3'}),
   movement('not-the-source',1,'40',{...basis,resource:{kind:'order',id:basis.resource.id}}),
  ];
  expect(scopedWarehouseReceiptQuantity(basis,[...same,...other],asOf)).toEqual(metres('500'));
  expect(scopedWarehouseReceiptQuantity(basis,other,asOf)).toBeNull();
 });
 it('replaces only the explicit native record version and does not count lost proof or a future occurrence',()=>{
  const a=movement('a',1,'300'),b=movement('a',2,'200'),corrected={...movement('a',3,'195'),replaces:b.original};
  expect(scopedWarehouseReceiptQuantity(basis,[a,b,corrected],asOf)).toEqual(metres('495'));
  expect(scopedWarehouseReceiptQuantity(basis,[a,corrected],asOf)).toBeNull();
  expect(scopedWarehouseReceiptQuantity(basis,[a,{...b,occurredAt:null}],asOf)).toBeNull();
  expect(scopedWarehouseReceiptQuantity(basis,[a,{...b,occurredAt:'2026-11-25T06:21:00Z'}],asOf)).toBeNull();
  expect(scopedWarehouseReceiptQuantity(basis,[a,{...b,valid:false}],asOf)).toBeNull();
 });
});

describe('X3 evidence-driven awaiting receipt from native investment',()=>{
 const basis:WarehouseReceiptBasis={resource:{kind:'source',id:'TEST-source'},kind:'fabric_receipt',scopeRef:'whole',
  materialId:'TEST-shared-cotton',lineId:null,adoptedRef:'TEST-material-version',supplierId:'TEST-mill',unit:'米'};
 const occurredAt='2026-11-25T06:00:00Z';
 const investment:NonNullable<Parameters<typeof warehouseReceiptTaskBasis>[1]>={
  resource:basis.resource,kind:'material_investment',scopeRef:basis.scopeRef,valid:true,state:'partial',recordId:'invested',version:2,
  quantities:[{materialId:basis.materialId,lineId:null,name:'TEST 基础物料',quantity:520,unit:'米'}],
  investmentScopeBasis:{materialIds:[basis.materialId],materialFingerprints:{[basis.materialId]:basis.adoptedRef},
   fingerprint:'TEST-all-materials-v2',handoverRecordId:'native-handover',handoverVersion:1,preorder:true},
  investmentMaterialOccurrences:{[basis.materialId]:{fingerprint:basis.adoptedRef,occurredAt}},
 };
 it('derives a real purchasing task from a partial investment receipt without requiring an active formal order or inventing a clock',()=>{
  expect(warehouseReceiptTaskBasis(basis,investment)).toEqual({invested:metres('520'),investedAt:occurredAt,
   original:{recordId:'invested',version:2},handover:{recordId:'native-handover',version:1}});
  expect(warehouseReceiptTaskBasis({...basis,lineId:'TEST-other-PO'},investment)).toBeNull();
  expect(warehouseReceiptTaskBasis({...basis,adoptedRef:'TEST-new-material-version'},investment)).toBeNull();
 });
 it('uses the exact PO line registration when the same material also had a later separate placement',()=>{
  const first={...investment.quantities[0]!,lineId:'TEST-blue-po',quantity:200};
  const other={...investment.quantities[0]!,lineId:'TEST-green-po',quantity:320};
  const current={...investment,quantities:[first,other]};
  expect(warehouseReceiptTaskBasis({...basis,lineId:first.lineId},current)).toBeNull();
  expect(warehouseReceiptTaskBasis({...basis,lineId:first.lineId},{
   ...current,investmentQuantityOccurrences:{
    [JSON.stringify([basis.materialId,first.lineId,basis.unit,null])]:{fingerprint:basis.adoptedRef,occurredAt},
    [JSON.stringify([basis.materialId,other.lineId,basis.unit,null])]:{fingerprint:basis.adoptedRef,occurredAt:'2026-11-25T08:00:00Z'},
   },
  })).toMatchObject({invested:metres('200'),investedAt:occurredAt});
 });
 it('excludes untrusted investment scope, a draft-like ready marker and incompatible original unit',()=>{
  expect(warehouseReceiptTaskBasis(basis,{...investment,investmentMaterialOccurrences:{}})).toBeNull();
  expect(warehouseReceiptTaskBasis(basis,{...investment,state:'unknown'})).toBeNull();
  expect(warehouseReceiptTaskBasis(basis,{...investment,valid:false})).toBeNull();
  expect(warehouseReceiptTaskBasis({...basis,unit:'码'},investment)).toBeNull();
 });
});
