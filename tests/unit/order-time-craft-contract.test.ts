import {describe,it,expect} from 'vitest';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import {prepareTimeFrameworkConfiguration,orderTimeConfigurationFromLegacy} from '@dx-rework/contracts/order-time-settings';
import {CraftStepChoiceSchema,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {fixedDevelopmentWork} from '../../apps/api/src/production-platform/fixed-development-work.js';
import {fixedOrderWork} from '../../apps/api/src/production-platform/fixed-order-work.js';
import {orderTimeSettingsCalculation} from '../../apps/api/src/production-platform/order-time-settings-calculation.js';
import {frameworkScopeInputs} from '../../apps/api/src/production-platform/order-time-framework-route.js';
import {orderTimeInputFromRoute} from '../../apps/api/src/production-platform/order-time-request-plan.js';
import type {FixedWorkInputs} from '../../apps/api/src/production-platform/fixed-work-definition.js';

const special=(id:string,sequence:number):CraftStepChoice=>({craftKind:'special',sequence,specialCraft:{id,version:3,recordedAt:'2026-11-01T00:00:00.000Z',definition:{name:'TEST 特殊'+sequence,enabled:true,
 development:{minutes:sequence*240,calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:sequence*480,calendar:'natural_days',reminder:{enabled:true,percent:70}}}}});
const choices=[special('a0000000-0000-4000-8000-000000000001',1),special('a0000000-0000-4000-8000-000000000002',2)];
const values=()=>prepareTimeFrameworkConfiguration(orderTimeConfigurationFromLegacy({unified:digitalSlaDefaults(),development:DEVELOPMENT_CYCLE_DEFAULTS,planning:{}}));
const initial=():FixedWorkInputs=>({data:{unified:{configurationId:'TEST original',snapshotRef:'TEST original',values:{ruleVersion:'20261023.1',parameters:{}}},planning:null,development:null,
 orderTimePlan:{version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST frozen',revision:2,...values()}}}});
const physical=()=>choices.map((s,index)=>({...structuredClone(s),stepId:`TEST-step-${index+1}`}));
const development=()=>fixedDevelopmentWork(initial(),'TEST source',2,['development_pattern','development_cutting',
 'development_craft_dispatch','development_printing','development_craft_confirmation',
 'development_craft_dispatch','development_printing','development_craft_confirmation','development_confirmation'],physical(),false,'免洗',false);

describe('fixed native craft identity and strict framework choices',()=>{
 it('calculates the real settings graph with two distinct special choices and complete customer dates',()=>{
  const result=orderTimeSettingsCalculation({values:values(),startAt:'2026-12-01T00:00:00Z',frameworkRoute:'B',lines:[{id:'TEST PO',customerDate:'2027-04-16'}],
   development:{enabled:true,craftSteps:choices,washing:'免洗',accessories:false},bulk:{craftSteps:choices,preshrink:false}});
  expect(result.lines[0]!.milestones).toHaveLength(8);
  const specialRows=result.lines[0]!.rows.filter(r=>r.parameterKey.includes('_special_'));
  expect(specialRows).toHaveLength(4);expect(new Set(specialRows.map(r=>r.id)).size).toBe(4);
 });

 it('keeps original step identities and frozen versions outside each strict choice in both builders',()=>{
  const source=development(),bulk=fixedOrderWork(initial(),'TEST order','TEST source',2,'无需预缩',physical(),false,source,[{line_id:'TEST PO',goal:{precision:'date',value:'2027-04-16',source:'TEST customer date'},customerDateVersion:1}],'B');
  const specialWork=[...source.work,...bulk.work.filter(w=>!w.id.startsWith('source:'))].filter(w=>w.craftStep?.craftKind==='special');
  expect(specialWork).toHaveLength(4);
  for(const work of specialWork){expect(CraftStepChoiceSchema.safeParse(work.craftStep).success).toBe(true);expect(work.craftStep!.specialCraft!.version).toBe(3);expect(work.canonicalWorkRef).toMatch(/step:TEST-step-[12]:work$/);}
  expect(source.route.filter(r=>r.phase==='work').map(r=>r.stepId)).toEqual(['TEST-step-1','TEST-step-2']);
  expect(bulk.route.filter(r=>r.phase==='logistics').map(r=>r.stepId)).toEqual(['TEST-step-1','TEST-step-2']);
 });

 it('projects old saved work with nested internal IDs without changing the original persisted business identity',()=>{
  const bulk=fixedOrderWork(initial(),'TEST order','TEST source',2,'无需预缩',physical(),false,development(),[{line_id:'TEST PO',goal:{precision:'date',value:'2027-04-16',source:'TEST customer date'},customerDateVersion:1}],'B');
  const input=orderTimeInputFromRoute(initial().data.orderTimePlan!,bulk,new Map(bulk.consumers.map(c=>[c.scopeRef,c.ends[c.customerGoalIds![0]!]!])),true);
  for(const work of input.work)if(work.craftStep)Object.assign(work.craftStep,{stepId:'TEST-old-internal-id'});
  const before=structuredClone(input),framework=frameworkScopeInputs(input,'B',{precision:'instant',value:'2026-12-01T00:00:00Z',source:'TEST accepted'});
  expect(framework).toHaveLength(1);expect(input).toEqual(before);
  for(const work of framework[0]!.work.filter(w=>w.craftStep)){expect(CraftStepChoiceSchema.safeParse(work.craftStep).success).toBe(true);expect(work.canonicalWorkRef).toBe(before.work.find(w=>w.id===work.id)!.canonicalWorkRef);}
 });
});
