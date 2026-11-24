import {describe,expect,it} from 'vitest';
import {deriveStyleLabelOccurrences,evaluateStyleLabels} from '../../apps/api/src/production-platform/style-label-evidence.js';

const t1='2026-11-02T00:00:00.000Z',t2='2026-11-02T03:00:00.000Z';
const order='order',basis=[{lineId:'blue',quantity:35},{lineId:'green',quantity:25}];
type RecordInput=Parameters<typeof deriveStyleLabelOccurrences>[2];
const row=(lineId:string,quantity:number,name='标签',unit='枚')=>({lineId,materialId:null,name,quantity,unit});
const receipt=(version:number,occurredAt:string|null,quantities:RecordInput['quantities'],extras:Partial<RecordInput>={}):RecordInput=>
 ({kind:'style_label_ready',state:'ready',valid:true,version,occurredAt,recordId:'original',resource:{kind:'order',id:order},scopeRef:'whole',quantities,...extras});
const withProof=(input:RecordInput,prior?:RecordInput)=>({...input,...deriveStyleLabelOccurrences(order,basis,input,prior)});
const read=(material:RecordInput,history:RecordInput[]=[material])=>evaluateStyleLabels(order,basis,[material],[{kind:'whole_order_preparation'}],history);

describe('style label quantities and occurrence evidence',()=>{
 it('keeps unchanged blue receipt T1 and supplies T2 for green and the whole order',()=>{
  const first=withProof(receipt(1,t1,[row('blue',35),row('green',24)]));
  expect(read(first).lines.get('blue')).toMatchObject({status:'sufficient',completedAt:t1});
  expect(read(first).lines.get('green')).toMatchObject({status:'insufficient',shortfall:1,startedAt:t1,completedAt:null});
  expect(read(first).whole).toMatchObject({sufficient:false,startedAt:t1,completedAt:null});
  const second=withProof(receipt(2,t2,[row('green',25),row('blue',35)]),first),result=read(second,[first,second]);
  expect(result.lines.get('blue')).toMatchObject({completedAt:t1,completionRecord:{recordId:'original',version:1}});
  expect(result.lines.get('green')).toMatchObject({completedAt:t2,completionRecord:{recordId:'original',version:2}});
  expect(result.whole).toMatchObject({sufficient:true,completedAt:t2});
  const invalidated=read(second,[{...first,valid:false},second]);
  expect(invalidated.lines.get('blue')).toMatchObject({status:'sufficient',completedAt:null});
  expect(invalidated.lines.get('green')?.completedAt).toBe(t2);
  expect(invalidated.whole).toMatchObject({sufficient:true,completedAt:null});
  expect(invalidated.evidenceRevision).not.toBe(result.evidenceRevision);
 });
 it('leaves dates unknown for old receipts, changed demands and ambiguous time-only changes',()=>{
  const legacy=receipt(1,t1,[row('blue',35),row('green',24)]);
  const both=withProof(receipt(2,t2,[row('blue',35),row('green',25)]),legacy);
  expect(read(both).lines.get('blue')).toMatchObject({status:'sufficient',completedAt:null});
  expect(read(both).lines.get('green')?.completedAt).toBe(t2);
  expect(read(both).whole).toMatchObject({sufficient:true,completedAt:null});
  const changed=evaluateStyleLabels(order,[basis[0]!,{lineId:'green',quantity:24}],[both],[]);
  expect(changed.requirementsRevision).not.toBe(read(both).requirementsRevision);
  expect(changed.lines.get('green')).toMatchObject({status:'sufficient',completedAt:null});
  const corrected=withProof(receipt(3,t1,both.quantities),both);
  expect(read(corrected).lines.get('green')).toMatchObject({status:'sufficient',completedAt:null});
  expect(read(corrected).whole.completedAt).toBeNull();
  const exact=withProof(receipt(1,t1,[row('green',25)],{scopeRef:'po:green'}));
  const exactCorrection=withProof(receipt(2,t2,exact.quantities,{scopeRef:'po:green'}),exact);
  expect(read(exactCorrection).lines.get('green')?.completedAt).toBe(t2);
 });
 it('keeps count requirements for actual cutting and avoids combining facts or giving a sister PO a start',()=>{
  const selected=receipt(1,t1,[row('blue',60),row('blue',35,'补领'),row('blue',10,'整箱','箱'),row('blue',1.5,'小数')]);
  const result=evaluateStyleLabels(order,[{lineId:'blue',quantity:100},basis[1]!],[selected,receipt(1,t2,[row('blue',5)],{recordId:'separate',scopeRef:'blue'})],[
   {kind:'actual_cut',lineId:'blue',requiredQuantity:95},{kind:'actual_cut',lineId:'blue',requiredQuantity:100},{kind:'po_preparation',lineId:'blue'},
  ]);
  expect(result.result).toMatchObject([{status:'sufficient',quantity:95},{status:'insufficient',shortfall:5},{status:'insufficient',quantity:95}]);
  expect(result.lines.get('green')).toMatchObject({status:'unknown',quantity:null,startedAt:null,completedAt:null});
  expect(result.whole.sufficient).toBe(false);
  expect(evaluateStyleLabels(order,[],[],[{kind:'whole_order_preparation'}]).whole.sufficient).toBe(false);
 });
 it('uses only current proof, preserves a partial start and never inherits across withdrawal or invalid evidence',()=>{
  const original=withProof(receipt(1,t1,[row('blue',35)]));
  const partial=receipt(2,t2,[row('blue',35)],{state:'partial'});
  expect(read(partial).lines.get('blue')).toMatchObject({status:'unknown',startedAt:t2,completedAt:null});
  expect(read({...original,valid:false}).lines.get('blue')).toMatchObject({status:'unknown',startedAt:null,completedAt:null});
  const withdrawn=withProof(receipt(2,null,[],{state:'withdrawn'}),original);
  expect(read(withdrawn).lines.get('blue')).toMatchObject({status:'unknown',completedAt:null});
  const resumed=withProof(receipt(3,t2,original.quantities),withdrawn);
  expect(read(resumed).lines.get('blue')).toMatchObject({status:'sufficient',completedAt:t2,completionRecord:{version:3}});
 });
});
