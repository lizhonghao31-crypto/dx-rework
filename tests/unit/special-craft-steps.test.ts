import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {CraftStepChoicesSchema,craftChoiceLabel,hasBothBuiltinCrafts,type CraftStepChoice,type SpecialCraftVersion} from '@dx-rework/contracts/digital-craft';
import {digitalSlaDefaults,DIGITAL_SLA_RULE_VERSION} from '@dx-rework/contracts/digital-sla';
import {fixedDevelopmentWork} from '../../apps/api/src/production-platform/fixed-development-work.js';
import {fixedOrderWork} from '../../apps/api/src/production-platform/fixed-order-work.js';
import {fixedTimelineForward} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
import {FrozenOrderTimePlanSchema} from '@dx-rework/contracts/order-time-plan';
import {buildOrderTimeWork} from '../../apps/api/src/production-platform/order-time-schedule.js';
import {orderTimeInputFromRoute} from '../../apps/api/src/production-platform/order-time-request-plan.js';
import {orderTimeStoredBulkSteps,orderTimeBulkSteps} from '../../apps/api/src/production-platform/order-time-route-identities.js';
import {factoryStepLedger} from '../../apps/api/src/production-platform/factory-step-ledger.js';
import type {FixedWorkInputs} from '../../apps/api/src/production-platform/fixed-work-definition.js';
import type {BatchFact,BatchCheck} from '../../apps/api/src/production-platform/factory-batch-ledger.js';
const library=(name:string,dev:number,bulk:number):SpecialCraftVersion=>({id:randomUUID(),version:1,recordedAt:'2026-11-13T00:00:00.000Z',definition:{name,enabled:true,development:{minutes:dev,calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:bulk,calendar:'continuous',reminder:{enabled:true,percent:70}}}});
const a=library('TEST 激光',60,120),b=library('TEST 烫钻',120,240);
const steps:Array<CraftStepChoice&{stepId:string}>=[{craftKind:'special',specialCraft:a,sequence:1,stepId:randomUUID()},{craftKind:'printing',sequence:2,stepId:randomUUID()},{craftKind:'special',specialCraft:b,sequence:3,stepId:randomUUID()}];
const initial=():FixedWorkInputs=>({data:{unified:{configurationId:'TEST',snapshotRef:'TEST',values:{ruleVersion:DIGITAL_SLA_RULE_VERSION,parameters:Object.fromEntries(Object.entries(digitalSlaDefaults()).map(([key,value])=>[key,{value,source:'global',sourceVersion:1}]))}},development:null,planning:{standardRef:'TEST',version:1,values:{development_printing:{minutes:180,calendar:'continuous'},bulk_printing:{minutes:180,calendar:'continuous'},bulk_qc:{minutes:60,calendar:'continuous'}}}}});
describe('special crafts have distinct native steps rather than another combined printing task',()=>{
 it('requires concrete library entries and rejects accidental duplicate selection without merging distinct crafts',()=>{
  expect(CraftStepChoicesSchema.parse(steps.map(step=>({craftKind:step.craftKind,sequence:step.sequence,...(step.specialCraft?{specialCraft:step.specialCraft}:{})})))).toHaveLength(3);
  expect(craftChoiceLabel(steps)).toBe('TEST 激光 → 印花 → TEST 烫钻');
  expect(CraftStepChoicesSchema.safeParse([{craftKind:'special',sequence:1}]).success).toBe(false);
  expect(CraftStepChoicesSchema.safeParse([{craftKind:'special',specialCraft:a,sequence:1},{craftKind:'special',specialCraft:a,sequence:2}]).success).toBe(false);
 });
 it('does not confuse special-craft count with the legacy print/embroidery combined standard',()=>{
  expect(hasBothBuiltinCrafts(steps)).toBe(false);
  expect(hasBothBuiltinCrafts([steps[0]!,steps[1]!])).toBe(false);
  expect(hasBothBuiltinCrafts([...steps,{craftKind:'embroidery',sequence:4}])).toBe(true);
 });
 it('uses each development value, includes each handoff once and preserves real serial order',()=>{
  const kinds=steps.flatMap(()=>['development_craft_dispatch','development_printing','development_craft_confirmation'] as const);
  const route=fixedDevelopmentWork(initial(),'TEST',1,kinds,steps,false,'免洗',false);
  const parents=route.work.filter(work=>!work.includedIn);
  expect(parents.map(work=>work.minutes)).toEqual([60,180,120]);
  expect(new Set(route.work.map(work=>work.id)).size).toBe(9);
  expect(route.route.filter(row=>row.phase==='work').map(row=>row.stepId)).toEqual(steps.map(step=>step.stepId));
  const forward=fixedTimelineForward(route.work,{precision:'instant',value:'2026-11-13T00:00:00.000Z',source:'TEST start'});
  expect(forward.find(node=>node.id===parents[2]!.id)?.end.at).toBe('2026-11-13T06:00:00.000Z');
  expect(route.work.filter(work=>work.includedIn).map(work=>work.includedIn)).toEqual(parents.flatMap(work=>[work.id,work.id]));
 });
 it('uses bulk values separately and adds one QC for every actual step',()=>{
  const result=fixedOrderWork(initial(),'TEST order','TEST source',1,'不需预缩',steps,false,null,[]);
  const craft=result.work.filter(work=>work.parameterKey?.startsWith('bulk_special_')||work.parameterKey==='bulk_printing');
  expect(craft.map(work=>work.minutes)).toEqual([120,180,240]);
  expect(result.work.filter(work=>work.parameterKey==='bulk_qc')).toHaveLength(3);
  expect(result.route.filter(work=>work.kind==='process_logistics').map(work=>work.stepId)).toEqual(steps.map(step=>step.stepId));
 });
 it('keeps immutable library policy through the order-plan adapter and later route reconstruction',()=>{
  const base=initial(),plan=FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,company:{version:'order-time-standard-v1',reference:'TEST frozen',revision:1,nodes:{},stageBufferMinutes:0},overrides:{}});
  base.data.orderTimePlan=plan;
  const route=fixedOrderWork(base,'TEST order','TEST source',1,'不需预缩',steps,false,null,[]);
  const input=orderTimeInputFromRoute(plan,route,new Map(),true);
  const work=buildOrderTimeWork(plan,input.work);
  expect(work.filter(node=>node.id.startsWith('bulk_special_')).map(node=>node.minutes)).toEqual([120,240]);
  const restored=orderTimeStoredBulkSteps(input);
  expect(restored.map(step=>step.specialCraft?.definition.name??step.craftKind)).toEqual(['TEST 激光','printing','TEST 烫钻']);
  expect(orderTimeBulkSteps('TEST order',2,steps,restored)).toEqual(restored);
  const special=input.work.find(node=>node.craftStep?.specialCraft?.id===a.id)!;
  const overridden=structuredClone(plan);overridden.overrides[special.parameterKey]={kind:'work',minutes:90,calendar:'continuous',reminder:{enabled:true,percent:60}};
  expect(buildOrderTimeWork(overridden,input.work).find(node=>node.id===special.id)?.minutes).toBe(90);
  expect(buildOrderTimeWork(plan,input.work).find(node=>node.id===special.id)?.minutes).toBe(120);
  const corrupted=structuredClone(input.work);corrupted.find(node=>node.id===special.id)!.parameterKey='bulk_special_wrong';
  expect(()=>buildOrderTimeWork(plan,corrupted)).toThrow('身份不一致');
 });
 it('only exposes final qualified pieces, never sums the same pieces across three steps',()=>{
  const facts:BatchFact[]=[],checks:BatchCheck[]=[];
  for(const [index,step]of steps.entries()){
   facts.push({fact_id:'s'+index,kind:'工艺发出',payload:{stepRef:step.stepId,lines:[{lineId:'po',quantity:100}],...(index?{fromReturnId:'r'+(index-1)}:{})},occurred_at:'2026-11-13T01:00:00Z'});
   facts.push({fact_id:'r'+index,kind:'工艺回仓',payload:{stepRef:step.stepId,sendFactId:'s'+index,lines:[{lineId:'po',quantity:100}]},occurred_at:'2026-11-13T02:00:00Z'});
   checks.push({return_fact_id:'r'+index,line_id:'po',result:'合格',checked_at:'2026-11-13T03:00:00Z'});
  }
  const pending=factoryStepLedger([{lineId:'po',quantity:100}],facts,checks.slice(0,2),steps);expect(pending.canDispatch).toBe(false);
  const result=factoryStepLedger([{lineId:'po',quantity:100}],facts,checks,steps);
  expect(result.batches).toHaveLength(1);expect(result.batches[0]!.rows[0]!.available).toBe(100);expect(result.canDispatch).toBe(true);expect(result.complete).toBe(false);
 });
});
