import {describe,expect,it} from 'vitest';
import {projectWarehouseIssueAllocation,warehouseIssueFits} from '../../apps/api/src/production-platform/warehouse-issue-allocation.js';
import type {WarehouseReceiptBasis,WarehouseReceiptMovement} from '../../apps/api/src/production-platform/warehouse-material-balance.js';

const basis:WarehouseReceiptBasis={resource:{kind:'source',id:'source'},kind:'fabric_receipt',scopeRef:'whole',
 materialId:'material',lineId:null,adoptedRef:'confirmed',supplierId:'supplier',unit:'米'};
const a={recordId:'same-real-stream',version:1},b={recordId:'same-real-stream',version:2},c={recordId:'same-real-stream',version:3};
const received=(original:WarehouseReceiptMovement['original'],quantity:string,replaces?:WarehouseReceiptMovement['original']):WarehouseReceiptMovement=>({
 basis,original,quantity:{quantity,unit:basis.unit},occurredAt:'2026-11-01T04:00:00Z',valid:true,...(replaces?{replaces}:{}),
});
const issue=(allocations:ReadonlyArray<{receipt:WarehouseReceiptMovement['original'];quantity:string}>)=>({occurredAt:'2026-11-02T04:00:00Z',allocations});

describe('warehouse exact physical lot occupancy',()=>{
 it('sends 300 from 500 and permits only the remaining adopted 200, even when other batches arrive',()=>{
  const rows=[received(a,'500'),received(b,'20')],shipped=issue([{receipt:a,quantity:'300'}]);
  const ledger=projectWarehouseIssueAllocation('米',rows,[shipped]);
  expect(ledger).toMatchObject({available:{quantity:'220'},dispatched:{quantity:'300'}});
  const fits=(quantity:string)=>warehouseIssueFits(ledger,{quantity:'500',unit:'米'},{quantity,unit:'米'},issue([{receipt:a,quantity:'190'},{receipt:b,quantity:Number(quantity)>190?String(Number(quantity)-190):'1'}]));
  expect(fits('200')).toBe(true);
  expect(fits('201')).toBe(false);
  expect(warehouseIssueFits(ledger,{quantity:'520',unit:'米'},{quantity:'201',unit:'米'},issue([{receipt:a,quantity:'201'}]))).toBe(false);
 });
 it('keeps prior allocations on the same physical lot after correction and never sends again from the old version',()=>{
  const rows=[received(a,'500'),received(b,'40'),received(c,'420',a)],shipped=issue([{receipt:a,quantity:'300'}]);
  const ledger=projectWarehouseIssueAllocation('米',rows,[shipped]);
  expect(ledger?.lots).toEqual([expect.objectContaining({receipt:c,remaining:{quantity:'120',unit:'米'}}),expect.objectContaining({receipt:b,remaining:{quantity:'40',unit:'米'}})]);
  const required={quantity:'500',unit:'米'},send={quantity:'40',unit:'米'};
  expect(warehouseIssueFits(ledger,required,send,issue([{receipt:a,quantity:'40'}]))).toBe(false);
  expect(warehouseIssueFits(ledger,required,send,issue([{receipt:c,quantity:'40'}]))).toBe(true);
  expect(projectWarehouseIssueAllocation('米',[...rows,received({recordId:c.recordId,version:4},'290',c)],[shipped])).toBeNull();
 });
 it('refuses opaque historical allocations, unknown lots, mixed units, or backdated issues',()=>{
  const rows=[received(a,'0.300001')];
  expect(projectWarehouseIssueAllocation('米',rows,null)).toBeNull();
  expect(projectWarehouseIssueAllocation('米',rows,[issue([{receipt:b,quantity:'0.1'}])])).toBeNull();
  expect(projectWarehouseIssueAllocation('码',rows,[])).toBeNull();
  const ledger=projectWarehouseIssueAllocation('米',rows,[issue([{receipt:a,quantity:'0.100001'}])]);
  expect(ledger?.available).toEqual({quantity:'0.2',unit:'米'});
  const send={quantity:'0.2',unit:'米'},target={quantity:'0.5',unit:'米'};
  expect(warehouseIssueFits(ledger,target,send,{...issue([{receipt:a,quantity:'0.2'}]),occurredAt:'2026-10-31T00:00:00Z'})).toBe(false);
  expect(warehouseIssueFits(ledger,target,send,issue([{receipt:a,quantity:'0.1'},{receipt:a,quantity:'0.1'}]))).toBe(false);
 });
});
