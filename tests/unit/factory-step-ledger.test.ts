import {describe,it,expect} from 'vitest';
import {factoryStepLedger} from '../../apps/api/src/production-platform/factory-step-ledger.js';
import type {BatchFact,BatchCheck} from '../../apps/api/src/production-platform/factory-batch-ledger.js';

const steps=[{stepId:'emb',craftKind:'embroidery' as const,sequence:1},{stepId:'print',craftKind:'printing' as const,sequence:2}];
const fact=(id:string,kind:string,stepRef:string,quantity:number,refs:Record<string,string>={}):BatchFact=>({fact_id:id,kind,payload:{stepRef,lines:[{lineId:'po',quantity}],...refs},occurred_at:'2026-11-09T08:00:00.000Z'});
const qc=(returnFactId:string):BatchCheck=>({return_fact_id:returnFactId,line_id:'po',result:'合格',checked_at:'2026-11-09T09:00:00.000Z'});
const first=[fact('send1','工艺发出','emb',100),fact('return1','工艺回仓','emb',100,{sendFactId:'send1'})];
describe('independent craft scopes and terminal-only physical supply',()=>{
 it('does not dispatch first-step100 plus second-step0, then exposes only final100 rather than200',()=>{
  const before=factoryStepLedger([{lineId:'po',quantity:100}],first,[qc('return1')],steps);
  expect(before.canDispatch).toBe(false);expect(before.batches).toEqual([]);expect(before.sendable[1]!.lines[0]!.remaining).toBe(100);
  const both=[...first,fact('send2','工艺发出','print',100,{fromReturnId:'return1'}),fact('return2','工艺回仓','print',100,{sendFactId:'send2'})];
  const after=factoryStepLedger([{lineId:'po',quantity:100}],both,[qc('return1'),qc('return2')],steps);
  expect(after.canDispatch).toBe(true);expect(after.batches.map(batch=>batch.factId)).toEqual(['return2']);
  expect(after.batches.flatMap(batch=>batch.rows).reduce((sum,row)=>sum+row.available,0)).toBe(100);
  expect(after.steps[0]!.completion[0]).toMatchObject({qualified:100,complete:true});
  expect(after.steps[0]!.batches[0]!.rows[0]!.available).toBe(0);
 });
 it('keeps the actual reverse order and allows only qualified final partial supply',()=>{
  const reverse=[{...steps[1]!,sequence:1},{...steps[0]!,sequence:2}],facts=[fact('s1','工艺发出','print',100),fact('r1','工艺回仓','print',100,{sendFactId:'s1'}),fact('s2','工艺发出','emb',100,{fromReturnId:'r1'}),fact('r2','工艺回仓','emb',60,{sendFactId:'s2'})];
  const before=factoryStepLedger([{lineId:'po',quantity:100}],facts,[qc('r1')],reverse);expect(before.canDispatch).toBe(false);
  const ready=factoryStepLedger([{lineId:'po',quantity:100}],facts,[qc('r1'),qc('r2')],reverse);
  expect(ready.terminalStepRef).toBe('emb');expect(ready.batches[0]!.rows[0]!.available).toBe(60);expect(ready.complete).toBe(false);
  const sent=factoryStepLedger([{lineId:'po',quantity:100}],[...facts,fact('out','仓库实际发厂','emb',60,{returnFactId:'r2'})],[qc('r1'),qc('r2')],reverse);
  expect(sent.totals[0]).toMatchObject({sent:60,remaining:40});expect(sent.canDispatch).toBe(false);expect(sent.complete).toBe(false);
 });
 it('does not unlock the next step from an incomplete predecessor or an unrelated return/QC',()=>{
  const partial=[fact('s1','工艺发出','emb',100),fact('r1','工艺回仓','emb',60,{sendFactId:'s1'})];
  const result=factoryStepLedger([{lineId:'po',quantity:100}],partial,[qc('r1')],steps);
  expect(result.sendable[1]!.lines[0]!.remaining).toBe(0);expect(result.canDispatch).toBe(false);
  const unrelated=factoryStepLedger([{lineId:'po',quantity:100}],[...first,fact('old','工艺回仓','old-combined',100)], [qc('return1'),qc('old')],steps);
  expect(unrelated.canDispatch).toBe(false);expect(unrelated.batches).toEqual([]);
 });
 it('allows only pieces explicitly released on the exact counted predecessor without unlocking a legacy sibling lot',()=>{
  const facts=[fact('s1','工艺发出','emb',400),fact('counted','工艺回仓','emb',300,{sendFactId:'s1'}),fact('legacy','工艺回仓','emb',100,{sendFactId:'s1'})];
  const scope={...qc('counted'),result:'需处理',quantity_scope:{inspectedQuantity:220,qualifiedQuantity:200,problemQuantity:20,unit:'片'}};
  const u=[{lineId:'po',quantity:400}];
  const before=factoryStepLedger(u,facts,[scope,qc('legacy')],steps);
  expect(before.steps[0]!.completion[0]).toMatchObject({qualified:300,complete:false});
  expect(before.sendable[1]!.lines[0]!.remaining).toBe(200);
  const after=factoryStepLedger(u,[...facts,fact('s2','工艺发出','print',200,{fromReturnId:'counted'})],[scope,qc('legacy')],steps);
  expect(after.steps[0]!.batches[0]!.rows[0]).toMatchObject({returned:300,available:100,releasedAvailable:0});
  expect(after.sendable[1]!.lines[0]!.remaining).toBe(0);
 });
 it('does not count an actual repair return as added stock or spend the original passed pieces',()=>{
  const stepsForTest=steps.slice(0,1),lines=[{lineId:'po',quantity:300}];
  const held={...qc('return1'),check_id:'check1',result:'需处理',quantity_scope:{inspectedQuantity:300,qualifiedQuantity:280,problemQuantity:20,unit:'片'}};
  const outgoing=fact('repair-send','工艺发出','emb',20,{fromReturnId:'return1'});
  const actual={...outgoing,payload:{...outgoing.payload,warehouseMotion:{reworkId:'repair',checkId:'check1'}}};
  const returned=fact('repair-back','工艺回仓','emb',20,{sendFactId:'repair-send'});
  const original=[fact('send1','工艺发出','emb',300),fact('return1','工艺回仓','emb',300,{sendFactId:'send1'})];
  const out=factoryStepLedger(lines,[...original,actual,returned],[held],stepsForTest);
  expect(out.batches.map(batch=>batch.rows[0])).toMatchObject([{available:280,releasedAvailable:280},{available:20,allowDispatch:false}]);
  expect(out.steps[0]!.completion[0]).toMatchObject({qualified:280,complete:false});
  const after=factoryStepLedger(lines,[...original,actual,returned],[held,qc('repair-back')],stepsForTest);
  expect(after.steps[0]!.completion[0]).toMatchObject({qualified:300,complete:true,conflict:false});
  expect(factoryStepLedger(lines,[...original,outgoing,returned],[held],stepsForTest).batches[0]!.rows[0]!.releasedAvailable).toBe(260);
 });
});
