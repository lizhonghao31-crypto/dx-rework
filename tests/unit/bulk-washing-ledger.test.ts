import {describe,it,expect} from 'vitest';
import {BulkWashingArrangementSchema,type BulkWashingFact,type BulkWashingScope} from '../../packages/contracts/src/bulk-washing.js';
import {bulkWashingLedger} from '../../apps/api/src/production-platform/bulk-washing-ledger.js';

const scope:BulkWashingScope={scopeId:'receipt-1',lineId:'red',factoryDecisionId:'factory-a',quantityVersion:'original',quantity:30};
const common={scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,occurredAt:'2026-11-13T01:00:00.000Z'};
const send:BulkWashingFact={...common,id:'send',kind:'send',quantity:30};
const returned:BulkWashingFact={...common,id:'return',kind:'return',sendId:'send',quantity:20};
const checked:BulkWashingFact={...common,id:'qc',kind:'inspection',completionId:'return',quantity:20,qualifiedQuantity:20};
const duration={minutes:240,calendar:'continuous',reminder:{enabled:true,percent:70}};

describe('normal bulk washing, isolated physical batch coverage',()=>{
 it.each(['after_receipt','factory'] as const)('retains genuine failures and accepts only their rewashed remainder on %s',mode=>{
  const start:BulkWashingFact=mode==='factory'?{...common,id:'first',kind:'factory_start',quantity:30}:{...send,id:'first'};
  const done:BulkWashingFact=mode==='factory'?{...common,id:'done',kind:'factory_complete',startId:'first',quantity:30}:{...returned,id:'done',sendId:'first',quantity:30};
  const failed:BulkWashingFact={...checked,id:'failed',completionId:'done',quantity:30,qualifiedQuantity:28};
  const rewash:BulkWashingFact=mode==='factory'?{...start,id:'rewash',reworkOfInspectionId:'failed',quantity:2}:{...send,id:'rewash',reworkOfInspectionId:'failed',quantity:2};
  const again:BulkWashingFact=mode==='factory'?{...common,id:'again',kind:'factory_complete',startId:'rewash',quantity:2}:{...returned,id:'again',sendId:'rewash',quantity:2};
  const second:BulkWashingFact={...checked,id:'second',completionId:'again',quantity:2,qualifiedQuantity:1};
  const facts=[start,done,failed];
  expect(bulkWashingLedger(scope,mode,facts)).toMatchObject({qualified:28,remaining:2,rework:{available:[{inspectionId:'failed',quantity:2,round:1}]}});
  facts.push(rewash,again,second);
  expect(bulkWashingLedger(scope,mode,facts)).toMatchObject({conflict:false,washed:30,qualified:29,remaining:1,complete:false,rework:{sent:2,washed:2,qualified:1,available:[{inspectionId:'second',quantity:1,round:2}],rounds:{failed:0,rewash:1,second:1}}});
  const thirdStart={...rewash,id:'third-start',quantity:1,reworkOfInspectionId:'second'};
  const thirdReturn=mode==='factory'?{...again,id:'third-return',kind:'factory_complete' as const,startId:thirdStart.id}:{...again,id:'third-return',kind:'return' as const,sendId:thirdStart.id};
  const thirdCheck={...checked,id:'third-check',completionId:thirdReturn.id,quantity:1,qualifiedQuantity:1,occurredAt:'2026-11-14T02:00:00.000Z'};
  expect(bulkWashingLedger(scope,mode,[...facts,thirdStart,{...thirdReturn,quantity:1},thirdCheck])).toMatchObject({conflict:false,washed:30,qualified:30,remaining:0,complete:true,completedAt:thirdCheck.occurredAt,rework:{sent:3,washed:3,qualified:2,available:[],rounds:{'third-check':2}}});
  expect(failed.qualifiedQuantity).toBe(28);expect(second.qualifiedQuantity).toBe(1);
 });
 it('reserves failed quantities once, across partial rounds and invalid ancestor/PO/version references',()=>{
  const done={...returned,quantity:30},failed={...checked,quantity:30,qualifiedQuantity:28};
  const rewash:BulkWashingFact={...send,id:'rewash',quantity:1,reworkOfInspectionId:'qc'};
  const first=[send,done,failed,rewash];
  expect(bulkWashingLedger(scope,'after_receipt',first).rework.available).toEqual([{inspectionId:'qc',quantity:1,round:1}]);
  expect(bulkWashingLedger(scope,'after_receipt',[...first,{...rewash,id:'other'}]).conflict).toBe(false);
  for(const facts of [
   [...first,{...rewash,id:'other',quantity:2}],
   [send,done,{...failed,qualifiedQuantity:30},rewash],
   [send,done,rewash,failed],
   [send,done,rewash],
   [send,done,{...failed,scopeId:'blue'},rewash],
   [send,done,{...failed,quantityVersion:'changed'},rewash],
   [send,done,failed,{...rewash,occurredAt:'2026-11-12T00:00:00.000Z'}],
  ])expect(bulkWashingLedger(scope,'after_receipt',facts)).toMatchObject({conflict:true,qualified:null,complete:false,rework:{available:[]}});
 });
 it('first receipt30 and wash return20 never complete either that receipt or order100',()=>{
  const result=bulkWashingLedger(scope,'after_receipt',[send,returned,checked]);
  expect(result).toMatchObject({conflict:false,sent:30,washed:20,qualified:20,remaining:10,complete:false,completedAt:null,sendable:0});
  expect(scope.quantity).toBe(30);
  expect(bulkWashingLedger({...scope,quantity:100},'after_receipt',[send,returned,checked]).complete).toBe(false);
 });
 it('supports partial returns with independent checks and uses the last real inspection',()=>{
  const rest:BulkWashingFact={...returned,id:'rest',quantity:10};
  const restQc:BulkWashingFact={...checked,id:'rest-qc',completionId:'rest',quantity:10,qualifiedQuantity:10,occurredAt:'2026-11-14T02:00:00.000Z'};
  expect(bulkWashingLedger(scope,'after_receipt',[send,returned,checked,rest,restQc]))
   .toMatchObject({qualified:30,complete:true,completedAt:'2026-11-14T02:00:00.000Z'});
  expect(bulkWashingLedger(scope,'after_receipt',[send,returned,checked,rest])).toMatchObject({qualified:20,complete:false});
 });
 it('does not borrow another PO or receipt washing/QC and rejects cross-batch parent references',()=>{
  expect(bulkWashingLedger(scope,'after_receipt',[send,{...returned,scopeId:'blue'},checked])).toMatchObject({conflict:true,qualified:null,complete:false});
  expect(bulkWashingLedger(scope,'after_receipt',[{...send,scopeId:'other'},returned])).toMatchObject({conflict:true,qualified:null});
 });
 it('quantity correction invalidates old coverage without rewriting recorded amounts',()=>{
  const result=bulkWashingLedger({...scope,quantity:25,quantityVersion:'correction'},'after_receipt',[send,returned,checked]);
  expect(result).toMatchObject({conflict:true,qualified:null,complete:false,sendable:0});
  expect(returned.quantity).toBe(20);
 });
 it('removing/revoking a source return does not leave its inspection usable',()=>{
  expect(bulkWashingLedger(scope,'after_receipt',[send,checked])).toMatchObject({conflict:true,qualified:null});
  expect(bulkWashingLedger(scope,'after_receipt',[returned,checked])).toMatchObject({conflict:true,qualified:null});
 });
 it('rejects duplicated identities, double effective inspection and over-return',()=>{
  for(const facts of [[send,send],[send,returned,checked,{...checked,id:'second-qc'}],[send,{...returned,quantity:31}]]){
   expect(bulkWashingLedger(scope,'after_receipt',facts)).toMatchObject({conflict:true,qualified:null,complete:false});
  }
 });
 it('factory route needs actual wash completion and QC, receipt alone does not imply wash',()=>{
  expect(bulkWashingLedger(scope,'factory',[])).toMatchObject({qualified:0,complete:false});
  const started:BulkWashingFact={...common,id:'factory-started',kind:'factory_start',quantity:30};
  const done:BulkWashingFact={...common,id:'factory-washed',kind:'factory_complete',startId:started.id,quantity:30};
  const qc:BulkWashingFact={...checked,completionId:done.id,quantity:30,qualifiedQuantity:30};
  expect(bulkWashingLedger(scope,'factory',[started,done,qc])).toMatchObject({sent:0,washed:30,qualified:30,complete:true});
  expect(bulkWashingLedger(scope,'factory',[send,returned,checked]).conflict).toBe(true);
 });
 it('does not invent a real time or mark a cancelled zero scope complete',()=>{
  const full={...returned,quantity:30},qc={...checked,quantity:30,qualifiedQuantity:30,occurredAt:null};
  expect(bulkWashingLedger(scope,'after_receipt',[send,full,qc])).toMatchObject({complete:true,completedAt:null});
  expect(bulkWashingLedger({...scope,quantity:0},'after_receipt',[])).toMatchObject({complete:false,completedAt:null});
 });
 it('no-wash introduces no completion or missing-time risk; performed work survives route-change review',()=>{
  expect(bulkWashingLedger(scope,'none',[])).toMatchObject({applicable:false,conflict:false,qualified:null,complete:false,reasons:[]});
  expect(bulkWashingLedger(scope,'none',[send])).toMatchObject({applicable:false,conflict:true,qualified:null});
 });
 it('rejects invalid quantity, time reversal and invalid qualified quantities',()=>{
  for(const facts of [[{...send,quantity:-1}],[send,{...returned,occurredAt:'2026-11-12T00:00:00Z'}],
   [send,returned,{...checked,qualifiedQuantity:21}],[send,returned,{...checked,occurredAt:'invalid'}]]){
   expect(bulkWashingLedger(scope,'after_receipt',facts).conflict).toBe(true);
  }
 });
 it('requires explicit standard and independent bulk durations, no development defaults',()=>{
  expect(BulkWashingArrangementSchema.parse({mode:'none'})).toEqual({mode:'none'});
  expect(BulkWashingArrangementSchema.safeParse({mode:'factory'}).success).toBe(false);
  expect(BulkWashingArrangementSchema.safeParse({mode:'after_receipt',reference:'settings:v1',revision:1,accounting:'included_in_factory',washing:duration,inspection:duration}).success).toBe(false);
  expect(BulkWashingArrangementSchema.parse({mode:'factory',reference:'settings:v1',revision:1,accounting:'included_in_factory',washing:duration,inspection:duration})).toMatchObject({washing:{minutes:240}});
 });
});
