import {expect,it} from 'vitest';
import type {ReceiptQualityFact} from '@dx-rework/contracts/order-closure';
import {packingQualityCoverage} from '../../apps/api/src/production-platform/packing-quality-coverage.js';

const line={lineId:'TEST line',actualQuantity:2,packingQuantity:2,cutScope:'verified' as const};
const quality=[{receiptId:'TEST old zero',lineId:line.lineId,quantity:0,qualifiedQuantity:0,inspected:false},
 {receiptId:'TEST positive A',lineId:line.lineId,quantity:1,qualifiedQuantity:1,inspected:true},
 {receiptId:'TEST positive B',lineId:line.lineId,quantity:1,qualifiedQuantity:1,inspected:true}] as ReceiptQualityFact[];
const washing=new Map<string,number|null>([['TEST old zero',null],['TEST positive A',1],['TEST positive B',1]]);
it('retains corrected zero-receipt history while only positive native quantities determine effective quality and packing',()=>{
 const result=packingQualityCoverage(line,quality,washing);
 expect(result.checks).toEqual(quality);
 expect(result.totals).toEqual({received:2,inspected:2,qualified:2});expect(result.effectiveQuantity).toBe(2);
});
it('keeps missing washing or quality on a positive receipt unresolved and never uses zero history as a substitute',()=>{
 const unknown=new Map(washing);unknown.set('TEST positive A',null);
 expect(packingQualityCoverage(line,quality,unknown)).toMatchObject({totals:null,effectiveQuantity:null});
 expect(packingQualityCoverage(line,quality.map(check=>check.receiptId==='TEST positive A'?{...check,inspected:false,qualifiedQuantity:0}:check),washing)).toMatchObject({totals:{received:2,inspected:1,qualified:1},effectiveQuantity:null});
 expect(packingQualityCoverage({...line,actualQuantity:3},quality,washing).effectiveQuantity).toBeNull();
});
it('keeps zero packing known without inventing positive receipt, quality or washing completion',()=>{
 const result=packingQualityCoverage({...line,actualQuantity:0,packingQuantity:0},[quality[0]!],washing);
 expect(result.checks).toEqual([quality[0]!]);expect(result.totals).toEqual({received:0,inspected:0,qualified:0});expect(result.effectiveQuantity).toBe(0);
 expect(packingQualityCoverage(line,undefined,washing)).toMatchObject({totals:null,effectiveQuantity:null});
});
