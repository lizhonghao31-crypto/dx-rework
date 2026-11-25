import {describe,expect,it} from 'vitest';
import {workbenchFactoryCommunication} from '../../apps/api/src/production-platform/workbench-factory-communication.js';

const at='2026-11-20T12:00:00Z';
const one='656b1102-1b3f-43e0-b6ee-3345c7a56c44',two='60f6a395-4592-485b-9b7d-2980262dfe22';
const base={orderId:'original-order',preparationId:'original-route'};
const fact=(factId:string,kind:string,payload:Record<string,unknown>)=>({factId,kind,payload,occurredAt:null,recordedAt:at,actorName:'TEST 工艺跟单'});
const history=[fact('first','工艺沟通',{stepRef:one,supplier:'工艺厂一',note:'原沟通'}),fact('send','工艺发出',{stepRef:one,supplier:'非沟通',lines:[{quantity:23}]}),
 fact('second','工艺沟通',{stepRef:two,supplier:'工艺厂二',note:'不能串读'}),fact('old','工艺沟通',{note:'旧整款沟通'}),fact('broken','工艺沟通',{stepRef:null,note:'归属未核'})];
const current={...base,routeSchemaVersion:2 as const,craftSteps:[{stepId:one},{stepId:two}],facts:history};

describe('X6 original factory communication projection',()=>{
 it('keeps the actual actor, note and original dates, only for the exact order, route and craft step',()=>{
  expect(workbenchFactoryCommunication(current,{...base,stepRef:one})).toEqual([{factId:'first',occurredAt:null,recordedAt:at,actorName:'TEST 工艺跟单',supplier:'工艺厂一',note:'原沟通'}]);
  expect(workbenchFactoryCommunication(current,{...base,stepRef:two})?.map(row=>row.factId)).toEqual(['second']);
  expect(workbenchFactoryCommunication(current,{...base,orderId:'others',stepRef:one})).toBeNull();
  expect(workbenchFactoryCommunication(current,{...base,preparationId:'prior-route',stepRef:one})).toBeNull();
 });
 it('keeps real legacy communication where exact and does not assume the first step or a supplier',()=>{
  expect(workbenchFactoryCommunication(current,{...base,stepRef:null})).toBeNull();
  expect(workbenchFactoryCommunication(current,{...base,stepRef:'unknown'})).toBeNull();
  expect(workbenchFactoryCommunication({...base,facts:history},{...base,stepRef:null})).toMatchObject([{factId:'old',supplier:null,occurredAt:null}]);
 });
});
