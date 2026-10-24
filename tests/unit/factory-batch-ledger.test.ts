import {describe,it,expect} from 'vitest';
import {factoryBatchLedger,type BatchFact} from '../../apps/api/src/production-platform/factory-batch-ledger.js';
const at='2026-10-23T00:00:00Z';
const fact=(fact_id:string,kind:string,quantity:number,extra:Record<string,unknown>={}):BatchFact=>({fact_id,kind,occurred_at:at,payload:{lines:[{lineId:'po',quantity}],...extra}});
describe('native factory batch ledger',()=>{
 it('keeps another batch in transit while a qualified return is partly dispatched',()=>{
  const facts=[fact('send','工艺发出',100),fact('return','工艺回仓',40,{sendFactId:'send'}),fact('dispatch','仓库实际发厂',20,{returnFactId:'return'})];
  const ledger=factoryBatchLedger([{lineId:'po',quantity:100}],facts,[{return_fact_id:'return',line_id:'po',result:'合格',checked_at:at}],false);
  expect(ledger.pendingSends[0]?.rows[0]?.remaining).toBe(60);expect(ledger.batches[0]?.rows[0]).toMatchObject({available:20,sent:20,allowDispatch:true});expect(ledger.complete).toBe(false);
 });
 it('retains failure when QC explicitly permits the scoped batch and removes reworked pieces',()=>{
  const facts=[fact('send','工艺发出',100),fact('return','工艺回仓',100,{sendFactId:'send'}),fact('redo','工艺发出',40,{fromReturnId:'return'})];
  const ledger=factoryBatchLedger([{lineId:'po',quantity:100}],facts,[{return_fact_id:'return',line_id:'po',result:'需处理',allow_dispatch:true,dispatch_reason:'后续安排',checked_at:at}],false);
  expect(ledger.batches[0]?.rows[0]).toMatchObject({result:'需处理',available:60,allowDispatch:true,reworked:40});expect(ledger.totals[0]?.craftRemaining).toBe(0);
 });
 it('surfaces a later cutting correction below already dispatched quantity without deleting shipments',()=>{
  const result=factoryBatchLedger([{lineId:'po',quantity:90}],[fact('d','仓库实际发厂',100)],[],true);expect(result.quantityConflict).toBe(true);expect(result.complete).toBe(false);expect(result.totals[0]?.sent).toBe(100);
 });
 it('no craft needs no fake QC and completes only after all actual quantities leave',()=>{
  const first=fact('d1','仓库实际发厂',40),second=fact('d2','仓库实际发厂',60);
  expect(factoryBatchLedger([{lineId:'po',quantity:100}],[first],[],true)).toMatchObject({complete:false,canDispatch:true,batches:[]});
  expect(factoryBatchLedger([{lineId:'po',quantity:100}],[first,second],[],true)).toMatchObject({complete:true,canDispatch:false});
 });
});
