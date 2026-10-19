import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {initialInstruction,InstructionDocumentSchema,type InstructionSheet} from '@dx-rework/contracts/production-instruction';
import {ProductionInstructionPrint} from '../../apps/web/src/production-instruction-print.js';
describe('document semantics preserve the selected saved facts',()=>{
 it('prints each selected snapshot PO arrival date rather than using current PO dates or the legacy contract promise for the ship-sample instruction',()=>{
  const saved='2099-12-01',current='2099-12-20',sheet={isPublishedSnapshot:true,version:4,printedBy:'TEST',sourceRound:1,document:{...initialInstruction(),sizes:['M']},order:{designStyleNo:'TEST',contractDeliveryDate:'2099-11-20',lines:[{lineId:randomUUID(),poNumber:'TEST-PO',color:'深蓝',customerWarehouseArrivalDate:saved,deliveryDate:saved,sizes:[{size:'M',quantity:10}]}]},customerPoDates:[{date:current}]} as InstructionSheet;
  const before=structuredClone(sheet),html=renderToStaticMarkup(createElement(ProductionInstructionPrint,{sheet,imageUrl:()=>'/TEST'}));expect(html).toContain('TEST-PO / 深蓝：2099-12-01');expect(html).toContain('船样按各 PO 客户仓到货日提前10个自然日寄出');expect(html).not.toContain(current);expect(html).not.toContain('请按客户合同交付期提前');expect(sheet).toEqual(before);
 });
 it('treats an explicitly missing snapshot customer date as unknown and uses legacy dates only when the new field was absent',()=>{
  const render=(line:Record<string,unknown>)=>renderToStaticMarkup(createElement(ProductionInstructionPrint,{sheet:{isPublishedSnapshot:true,version:4,printedBy:'TEST',document:{...initialInstruction(),sizes:['M']},order:{designStyleNo:'TEST',lines:[{lineId:randomUUID(),poNumber:'TEST-PO',color:'深蓝',sizes:[],...line}]}} as InstructionSheet,imageUrl:()=>'/TEST'}));
  expect(render({customerWarehouseArrivalDate:null,deliveryDate:'2099-11-01'})).toContain('TEST-PO / 深蓝：未登记');expect(render({customerWarehouseArrivalDate:null,deliveryDate:'2099-11-01'})).not.toContain('2099-11-01');expect(render({deliveryDate:'2099-11-01'})).toContain('TEST-PO / 深蓝：2099-11-01');
 });
 it('retains the original sixty-image schema limit independently of its screen capacity wording',()=>{
  const document={...initialInstruction(),images:Array.from({length:60},()=>({attachmentId:randomUUID(),kind:'款图' as const,description:''}))};expect(InstructionDocumentSchema.safeParse(document).success).toBe(true);expect(InstructionDocumentSchema.safeParse({...document,images:[...document.images,{attachmentId:randomUUID(),kind:'款图',description:''}]}).success).toBe(false);
 });
});
