import type {WarehouseReceiptListItem} from '@dx-rework/contracts/production-readiness';
import {describe,expect,it} from 'vitest';
import {warehouseReceiptStatus} from '../../apps/web/src/warehouse-center.js';

const metres=(quantity:string)=>({quantity,unit:'米'});
const receipt=(received:WarehouseReceiptListItem['received'],remaining:string|null,excess:string|null):
 Pick<WarehouseReceiptListItem,'invested'|'received'|'balance'>=>({
  invested:metres('60'),received,
  balance:{unit:'米',procurementRemaining:remaining,excessReceived:excess,productionShortage:null,dispatchRemaining:null},
 });

describe('warehouse receipts status cell',()=>{
 it('reports unknown receipt evidence even when the balance contains zero',()=>{
  expect(warehouseReceiptStatus(receipt(null,'0','0'))).toBe('实收待核');
 });

 it.each(['0','0.00','0.000000'])('shows confirmed receipt %s as zero without relying on the balance',quantity=>{
  expect(warehouseReceiptStatus(receipt(metres(quantity),'60','0'))).toBe('实收为零');
  expect(warehouseReceiptStatus(receipt(metres(quantity),null,null))).toBe('实收为零');
 });

 it('shows partial receipt, completed procurement and excess using the projected balances',()=>{
  expect(warehouseReceiptStatus(receipt(metres('20'),'40','0.000'))).toBe('部分收料');
  expect(warehouseReceiptStatus(receipt(metres('60'),'0.00','0'))).toBe('采购已收足');
  expect(warehouseReceiptStatus(receipt(metres('65'),'0','5'))).toBe('实收有差异');
 });

 it.each(['',' ','0e0','0x0','-1','待核'])('leaves invalid quantity %j unconfirmed',quantity=>{
  expect(warehouseReceiptStatus(receipt(metres(quantity),'60','0'))).toBe('实收待核');
 });

 it('requires a matching unit and usable balances when interpreting a positive receipt',()=>{
  const known=receipt(metres('20'),'40','0');
  expect(warehouseReceiptStatus(receipt({quantity:'0',unit:'码'},'60','0'))).toBe('实收待核');
  expect(warehouseReceiptStatus({...known,balance:{...known.balance,unit:'码'}})).toBe('实收待核');
  expect(warehouseReceiptStatus(receipt(metres('20'),null,'0'))).toBe('实收待核');
  expect(warehouseReceiptStatus(receipt(metres('20'),'40',null))).toBe('实收待核');
 });

 it('keeps the other PO and shared material independent from the PO corrected to zero',()=>{
  const items=[
   {...receipt(metres('0'),'60','0'),materialId:'TEST-SAME-MATERIAL',lineId:'TEST-PO-A'},
   {...receipt(metres('20'),'40','0'),materialId:'TEST-SAME-MATERIAL',lineId:'TEST-PO-B'},
   {...receipt(metres('65'),'0','5'),materialId:'TEST-SHARED-MATERIAL',lineId:null},
  ];
  expect(items.map(warehouseReceiptStatus)).toEqual(['实收为零','部分收料','实收有差异']);
 });
});
