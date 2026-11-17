import {describe,it,expect,vi} from 'vitest';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {FrozenOrderTimePlanSchema} from '@dx-rework/contracts/order-time-plan';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import type {StoredOrderTimePlan} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import * as operations from '../../apps/api/src/production-platform/order-time-operation-state.js';
import {applicableLinkedOrderTimeChanges,refreshLinkedOrderTimeInput} from '../../apps/api/src/production-platform/order-time-linked-applicability.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';

const rule:OrderTimeRule={kind:'work',minutes:1440,calendar:'continuous',reminder:{enabled:true,percent:70}};
const time={now:'2026-11-17T08:00:00.000Z',scenarioId:null,revision:0};
it.each(['unlinked','independent-company'])('retains the original no-propagation boundary for %s instead of qualifying a foreign target',async mode=>{
 // This unit isolates the repository's routing boundary. Original native
 // publication, transaction and receipt behavior is exercised in PG, not mocked.
 const plan=(companyRevision:number,minutes?:number)=>FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,company:{version:'order-time-standard-v1',reference:'TEST original company adoption',revision:companyRevision,nodes:{warehouse_dispatch:rule},stageBufferMinutes:0},overrides:minutes?{warehouse_dispatch:{...rule,minutes}}:{}});
 const original={revision:1,input:{plan:plan(1)}} as StoredOrderTimePlan,result={revision:2,input:{plan:plan(1,120)}} as StoredOrderTimePlan,counterpart={revision:1,input:{plan:plan(2)}} as StoredOrderTimePlan;
 const query=vi.fn(async()=>({rows:mode==='unlinked'?[]:[{source_id:'TEST other source'}]})),repo=new OrderTimePlanRepository({query} as never);
 const current=vi.spyOn(repo,'current').mockResolvedValueOnce(original).mockResolvedValueOnce(counterpart);
 const append=vi.spyOn(repo as unknown as {append:()=>Promise<StoredOrderTimePlan>},'append').mockResolvedValue(result),refresh=vi.fn();
 const before=structuredClone({original,result,counterpart});
 try{
  expect(await repo.confirm({resource:{kind:'order',id:'TEST original order'},expectedRevision:1,value:result.input,actorId:'TEST authorized actor',eventRef:'TEST original arrangement',time,requestKey:'TEST original command'},refresh)).toBe(result);
  expect(append).toHaveBeenCalledTimes(1);expect(refresh).not.toHaveBeenCalled();expect(current).toHaveBeenCalledTimes(mode==='unlinked'?1:2);
  expect({original,result,counterpart}).toEqual(before);
 }finally{current.mockRestore();append.mockRestore();}
});
describe('current target applicability is qualification, not permission or failure suppression',()=>{
 it('retains actual shared work and extra settings, omits only proven inapplicable changes and never edits input',()=>{
  const changes={shared:rule,development_cycle_normal:rule,only_main_C:rule},before=structuredClone(changes);
  expect(applicableLinkedOrderTimeChanges({complete:true,parameterKeys:['shared','development_cycle_normal']},changes)).toEqual({shared:rule,development_cycle_normal:rule});
  expect(changes).toEqual(before);expect(applicableLinkedOrderTimeChanges({complete:true,parameterKeys:[]},changes)).toEqual({});
 });
 it('keeps incomplete scope unknown even for an empty apparent work set',()=>{
  expect(()=>applicableLinkedOrderTimeChanges({complete:false,parameterKeys:[]},{only_main_C:rule})).toThrow('当前适用范围尚未明确');
 });
 it('reads the authorized target without foreign C first, then revalidates only its real shared changes',async()=>{
  const loader=vi.spyOn(operations,'loadOrderTimeOperation'),base={value:{tag:'TEST target original'},linkedApplicability:{complete:true,parameterKeys:['shared']}},selected={value:{tag:'TEST target reread'}};
  loader.mockResolvedValueOnce(base as never).mockResolvedValueOnce(selected as never);
  try{
   const resource={kind:'source' as const,id:'TEST original linked source'},result=await refreshLinkedOrderTimeInput({} as never,{} as never,{} as never,resource,time,{shared:rule,only_main_C:rule});
   expect(loader.mock.calls[0]!.slice(3)).toEqual([{kind:'arrangement',resource},time]);expect(loader.mock.calls[1]!.slice(3)).toEqual([{kind:'arrangement',resource},time,{shared:rule}]);
   expect(result).toEqual({value:selected.value,updates:{shared:rule}});
  }finally{loader.mockRestore();}
 });
 it('does not reapply an empty filtered update or manufacture a target revision',async()=>{
  const loader=vi.spyOn(operations,'loadOrderTimeOperation'),value={tag:'TEST unchanged target'};
  loader.mockResolvedValue({value,linkedApplicability:{complete:true,parameterKeys:['shared']}} as never);
  try{expect(await refreshLinkedOrderTimeInput({} as never,{} as never,{} as never,{kind:'source',id:'TEST target'},time,{only_main_C:rule})).toEqual({value,updates:{}});expect(loader).toHaveBeenCalledTimes(1);}finally{loader.mockRestore();}
 });
 it.each([false,true])('propagates an original permission/read/version/begun-work failure, afterQualification=%s',async after=>{
  const loader=vi.spyOn(operations,'loadOrderTimeOperation'),error=new ApplicationError(after?'ORDER_TIME_STALE':'FORBIDDEN','TEST original required target failure',after?409:403);
  if(after)loader.mockResolvedValueOnce({value:{},linkedApplicability:{complete:true,parameterKeys:['shared']}} as never);
  loader.mockRejectedValueOnce(error);
  try{await expect(refreshLinkedOrderTimeInput({} as never,{} as never,{} as never,{kind:'source',id:'TEST target'},time,{shared:rule})).rejects.toBe(error);}finally{loader.mockRestore();}
 });
});
