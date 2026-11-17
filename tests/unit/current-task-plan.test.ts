import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {TimeFrameworkInputSchema} from '@dx-rework/contracts/order-time-framework';
import type {DigitalTask,DigitalTaskCurrentPlan} from '@dx-rework/contracts/digital-production-tasks';
import type {StoredOrderTimePlan} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {initialFrameworkMilestoneStandard,evaluateTimeFrameworkCandidate,freezeTimeFrameworkCandidate} from '../../apps/api/src/production-platform/order-time-framework.js';
import {selectCurrentTaskPlan} from '../../apps/api/src/production-platform/current-task-plan-targets.js';
import {TaskPlanTargets} from '../../apps/web/src/task-plan-targets.js';

const resource={kind:'source' as const,id:'TEST-exact-source'},at=(hour:number)=>new Date(Date.UTC(2026,10,17,hour)).toISOString();
const task={taskId:'TEST-original-task',resource,round:2,kind:'development_pattern',routeRef:'TEST-original-route',stepRef:null,state:'ready',retired:false};
function version(steps=false):StoredOrderTimePlan{
 const work=(steps?['left','right']:['pattern']).map(step=>({id:'work-'+step,parameterKey:steps?'development_special_test':'development_pattern',stage:2 as const,dependsOn:[],canonicalWorkRef:`source:${resource.id}:round:2:${steps?'step:'+step+':work:craft':'work:development_pattern'}`}));
 const standard=initialFrameworkMilestoneStandard('B','TEST frozen standard',1);
 const plan={version:'order-time-plan-v1' as const,revision:1,overrides:{},company:{version:'order-time-standard-v1' as const,reference:'TEST company',revision:1,stageBufferMinutes:0,nodes:Object.fromEntries(work.map(w=>[w.parameterKey,{kind:'work',minutes:60,calendar:'continuous',reminder:{enabled:false,percent:70}}]))}};
 const scopeRef='TEST-exact-scope',input=TimeFrameworkInputSchema.parse({scopeRef,route:'B',acceptedAt:{precision:'instant',value:at(8),source:'TEST true admission'},customerDelivery:{date:'2027-03-01',source:'TEST true future goal',revision:1},plan,milestoneStandard:standard,work,bindings:Object.entries(standard.offsets).filter(([,offset])=>offset!==null).map(([key])=>({key,workIds:work.map(w=>w.id)})),notBefore:{}});
 const candidate=evaluateTimeFrameworkCandidate(input,{purpose:'order_proposal',observedAt:at(8)}),frozen=freezeTimeFrameworkCandidate(candidate,{reference:'TEST confirmed plan',revision:2,previousReference:'TEST original plan',eventRef:'TEST authorized arrangement'});
 return {id:'TEST-current-immutable-version',resource,revision:2,identityHash:'TEST',time:{now:at(8),scenarioId:null,revision:0},actorId:'TEST-manager',eventRef:'TEST-arrangement',changeKind:'arrangement',targets:{},input:{version:'order-time-input-v1',plan:input.plan,work:input.work,scopes:[{scopeRef,lineId:null,terminalIds:work.map(w=>w.id),customerGoalIds:[],customerGoal:{precision:'date',value:'2027-03-01',source:'TEST future customer goal'},goals:{}}],route:{complete:true,missing:[]},frameworkPlans:{[scopeRef]:frozen}}};
}
const binding=(ref=`source:${resource.id}:round:2:work:development_pattern`)=>({captured:true,canonicalWorkRef:ref});

describe('exact native task current P independent of original B and responsibility',()=>{
 it('selects the effective arranged P and exact version without mutating the frozen input',()=>{
  const saved=version(),before=structuredClone(saved),current=selectCurrentTaskPlan(saved,task,binding());
  expect(current).toMatchObject({state:'ready',planVersionId:saved.id,planRevision:2,targets:[{scopeRef:'TEST-exact-scope',workRef:binding().canonicalWorkRef,startAt:at(8),endAt:at(9),precision:'instant',date:null}]});
  expect(saved).toEqual(before);
 });
 it('does not borrow another source, round, missing binding or duplicate current work',()=>{
  const saved=version();
  expect(selectCurrentTaskPlan(saved,{...task,resource:{...resource,id:'TEST-foreign'}},binding()).state).toBe('unknown');
  expect(selectCurrentTaskPlan(saved,{...task,round:1},binding()).state).toBe('unknown');
  expect(selectCurrentTaskPlan(saved,task,{...binding(),captured:false}).state).toBe('unknown');
  saved.input.work.push(structuredClone(saved.input.work[0]!));
  expect(selectCurrentTaskPlan(saved,task,binding()).state).toBe('unknown');
 });
 it('keeps two same-kind craft steps independent and missing step unknown',()=>{
  const saved=version(true),framework=saved.input.frameworkPlans!['TEST-exact-scope']!;
  framework.arranged.find(row=>row.id==='work-right')!.end.at=at(10);
  const choose=(step:string)=>selectCurrentTaskPlan(saved,{...task,kind:'development_printing',stepRef:step},binding(`source:${resource.id}:round:2:step:${step}:work:craft`));
  expect(choose('left').targets[0]?.endAt).toBe(at(9));expect(choose('right').targets[0]?.endAt).toBe(at(10));expect(choose('missing').state).toBe('unknown');
 });
 it('does not replace explicitly unknown current P with a known original or sibling value',()=>{
  const saved=version();saved.input.frameworkPlans!['TEST-exact-scope']!.arranged[0]!.end.at=null;
  const current=selectCurrentTaskPlan(saved,task,binding());expect(current).toMatchObject({state:'unknown',targets:[{endAt:null}]});
 });
 it('keeps date precision only for a proven exclusive Beijing date boundary',()=>{
  const saved=version(),end=saved.input.frameworkPlans!['TEST-exact-scope']!.arranged[0]!.end;
  end.at='2026-11-17T16:00:00.000Z';end.exclusive=true;
  expect(selectCurrentTaskPlan(saved,task,binding()).targets[0]).toMatchObject({precision:'date',date:'2026-11-17',endAt:end.at});
  end.exclusive=false;expect(selectCurrentTaskPlan(saved,task,binding()).targets[0]).toMatchObject({precision:'instant',date:null});
 });
 it('reports every authorized PO separately and retains a partial unknown without averaging',()=>{
  const saved=version(),original=saved.input.scopes[0]!,framework=saved.input.frameworkPlans!['TEST-exact-scope']!;
  saved.resource={kind:'order',id:'TEST-mother'};saved.input.scopes=[{...original,scopeRef:'po:left',lineId:'left'},{...original,scopeRef:'po:right',lineId:'right'}];
  saved.input.frameworkPlans={'po:left':structuredClone(framework),'po:right':structuredClone(framework)};saved.input.frameworkPlans['po:right']!.arranged[0]!.end.at=null;
  const current=selectCurrentTaskPlan(saved,task,binding(),new Map([['left','PO-left'],['right','PO-right']]));
  expect(current).toMatchObject({state:'unknown',targets:[{scopeRef:'po:left',scopeLabel:'PO-left',endAt:at(9)},{scopeRef:'po:right',scopeLabel:'PO-right',endAt:null}]});
  expect(selectCurrentTaskPlan(saved,task,binding(),new Map([['left','PO-left']])).targets).toEqual([]);
 });
 it('marks retired/cancelled and proven superseded rounds not applicable without recovering old P',()=>{
  const saved=version();expect(selectCurrentTaskPlan(saved,{...task,retired:true},binding()).state).toBe('not_applicable');expect(selectCurrentTaskPlan(saved,{...task,state:'cancelled'},binding()).state).toBe('not_applicable');
  const priorTask={...task,round:1},priorBinding=binding(`source:${resource.id}:round:1:work:development_pattern`);
  expect(selectCurrentTaskPlan(saved,priorTask,priorBinding).state).toBe('not_applicable');saved.input.route.complete=false;
  expect(selectCurrentTaskPlan(saved,priorTask,priorBinding).state).toBe('unknown');
 });
 it('does not invent a separately arranged P for a handoff included in its parent work',()=>{
  const saved=version(),ref=`source:${resource.id}:round:2:step:TEST-step:development_craft_dispatch`;
  saved.input.work.push({id:'TEST-included-dispatch',parameterKey:'development_craft_dispatch',stage:2,dependsOn:[],includedIn:'work-pattern',includedPosition:'start',canonicalWorkRef:ref});
  saved.input.plan.company.nodes.development_craft_dispatch={kind:'included',minutes:30,calendar:'continuous',reminder:{enabled:false,percent:70}};
  expect(selectCurrentTaskPlan(saved,{...task,kind:'development_craft_dispatch',stepRef:'TEST-step'},binding(ref))).toMatchObject({state:'not_applicable',reason:'本任务内含于已安排工作，未单列独立计划时间',targets:[]});
 });
});

describe('native current-plan panel',()=>{
 const markup=(current:DigitalTaskCurrentPlan|undefined)=>renderToStaticMarkup(createElement(TaskPlanTargets,{task:{currentPlanTargets:current,dueAt:at(18),completedAt:at(20)} as DigitalTask}));
 it('shows the exact date and each PO while never substituting the native deadline',()=>{
  const current=selectCurrentTaskPlan(version(),task,binding());current.targets[0]!.precision='date';current.targets[0]!.date='2026-11-17';
  const html=markup(current);expect(html).toContain('2026-11-17（日期）');expect(html).toContain('本单安排第2版');expect(html).not.toContain('18:00');
 });
 it('distinguishes unknown, absent and not-applicable without inventing dates',()=>{
  expect(markup(undefined)).toContain('依据待核');expect(markup({state:'unknown',reason:'TEST 缺少可信当前P',planVersionId:null,planRevision:null,targets:[]})).toContain('TEST 缺少可信当前P');
  expect(markup({state:'not_applicable',reason:null,planVersionId:null,planRevision:null,targets:[]})).toContain('已退出当前计划范围');
 });
});
