import {describe,it,expect} from 'vitest';
import {FrozenOrderTimePlanSchema,reviseOrderTimePlan,orderTimeRule,type FrozenOrderTimePlan,type OrderTimeRule} from '../../packages/contracts/src/order-time-plan.js';
import {digitalSlaDefaults,DIGITAL_SLA_RULE_VERSION} from '@dx-rework/contracts/digital-sla';
import {evaluateOrderTimeScenario,type OrderTimeWork} from '../../apps/api/src/production-platform/order-time-schedule.js';
import {frozenWorkDefinition,type FixedWorkInputs} from '../../apps/api/src/production-platform/fixed-work-definition.js';
import {fixedDevelopmentWork} from '../../apps/api/src/production-platform/fixed-development-work.js';
import {fixedOrderWork} from '../../apps/api/src/production-platform/fixed-order-work.js';
import {fixedTimelineTargets} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
const DAY=1440,at=(day:number)=>new Date(Date.parse('2026-11-02T00:00:00.000Z')+day*DAY*60000).toISOString();
const anchor=(day:number)=>({precision:'instant' as const,value:at(day),source:'TEST explicit business input'});
const rule=(days:number,kind:OrderTimeRule['kind']='work'):OrderTimeRule=>({kind,minutes:days*DAY,calendar:'continuous',reminder:{enabled:true,percent:70}} as OrderTimeRule);
const plan=(nodes:Record<string,OrderTimeRule>):FrozenOrderTimePlan=>FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,company:{version:'order-time-standard-v1',reference:'TEST company creation version',revision:3,nodes,stageBufferMinutes:0},overrides:{}});
const work=(id:string,dependsOn:string[]=[],stage=2):OrderTimeWork=>({id,parameterKey:id,dependsOn,stage});
const serial=[work('a'),work('b',['a']),work('c',['b']),work('pack',['c'])];
const scenario=(saved:FrozenOrderTimePlan,goal=10,nodes:OrderTimeWork[]=serial)=>({plan:saved,work:nodes,start:anchor(0),route:{complete:true,missing:[]},scopes:[{scopeRef:'TEST PO1',terminalIds:[nodes.at(-1)!.id],goals:{[nodes.at(-1)!.id]:anchor(goal)},customerGoal:anchor(goal)}]});
const standard=()=>plan({a:rule(2),b:rule(3),c:rule(2),pack:rule(1),printing:rule(2),embroidery:rule(1.5)});

describe('one frozen order time plan and exact existing DAG calendars',()=>{
 it('backplans all known work immediately and distinguishes8days work from10days available',()=>{
  const result=evaluateOrderTimeScenario(scenario(standard()))[0]!;
  expect(result).toMatchObject({feasibility:'sufficient',requiredSpanMinutes:8*DAY,planSpanMinutes:8*DAY,marginMinutes:2*DAY,lateMinutes:0});
  expect(result.targets.map(row=>[row.id,row.start.at,row.end.at])).toEqual([['a',at(2),at(4)],['b',at(4),at(7)],['c',at(7),at(9)],['pack',at(9),at(10)]]);
  expect(result.expectedEnd?.at).toBe(at(8));
 });
 it('reports the actual two-day shortage without changing the customer promise',()=>{
  const input=scenario(standard(),6),result=evaluateOrderTimeScenario(input)[0]!;
  expect(result).toMatchObject({feasibility:'insufficient',lateMinutes:2*DAY,marginMinutes:-2*DAY});
  expect(result.targets[0]!.start.at).toBe(at(-2));expect(input.scopes[0]!.customerGoal).toEqual(anchor(6));
 });
 it('uses only the original company counterpart plus explicit per-order changes',()=>{
  const original=standard(),changed=reviseOrderTimePlan(original,{a:rule(1),b:rule(2)});
  expect(evaluateOrderTimeScenario(scenario(changed,6))[0]).toMatchObject({feasibility:'sufficient',requiredSpanMinutes:6*DAY,marginMinutes:0});
  expect(changed.company).toEqual(original.company);expect(original.overrides).toEqual({});
  expect(orderTimeRule(changed,'printing')).toMatchObject({source:'company',rule:{minutes:2*DAY}});
  expect(()=>reviseOrderTimePlan(original,{a:{kind:'event',minutes:0,calendar:'continuous',reminder:{enabled:false,percent:70}}})).toThrow('节点性质');
 });
 it('preserves unknown route and missing time separately while returning independent known targets',()=>{
  const unknownRoute={...scenario(standard()),route:{complete:false,missing:['大货是否预缩尚未确认']}};
  const result=evaluateOrderTimeScenario(unknownRoute)[0]!;
  expect(result).toMatchObject({feasibility:'unknown',requiredSpanMinutes:null,planSpanMinutes:null,expectedEnd:null});
  expect(result.targets.at(-1)!.end.at).toBe(at(10));expect(result.coverage).toContain('大货是否预缩尚未确认');
  const incomplete=standard();delete incomplete.company.nodes.b;
  expect(evaluateOrderTimeScenario(scenario(incomplete))[0]).toMatchObject({feasibility:'unknown',expectedEnd:null});
  expect(orderTimeRule(incomplete,'new_craft')).toBeNull();
 });
 it('takes the last necessary parallel branch and does not pretend shortening the other branch saves the whole order',()=>{
  const nodes=[work('a'),work('b'),work('pack',['a','b'])],original=plan({a:rule(3),b:rule(2),pack:rule(1)});
  for(const saved of [original,reviseOrderTimePlan(original,{b:rule(1)})])expect(evaluateOrderTimeScenario(scenario(saved,10,nodes))[0]).toMatchObject({requiredSpanMinutes:4*DAY,planSpanMinutes:4*DAY});
 });
 it('keeps printing and embroidery serial in their explicitly selected order',()=>{
  const nodes=[work('embroidery'),work('printing',['embroidery']),work('pack',['printing'])];
  const result=evaluateOrderTimeScenario(scenario(standard(),10,nodes))[0]!;
  expect(result.requiredSpanMinutes).toBe(4.5*DAY);expect(result.arranged[1]!.start.at).toBe(at(1.5));
 });
 it('does not count included dispatch and return a second time',()=>{
  const saved=plan({a:rule(2),dispatch:rule(.25,'included'),return:rule(.25,'included'),pack:rule(1)}),nodes=[work('a'),{...work('dispatch'),includedIn:'a'}, {...work('return'),includedIn:'a',includedPosition:'end' as const},work('pack',['a'])];
  const result=evaluateOrderTimeScenario(scenario(saved,10,nodes))[0]!;
  expect(result.requiredSpanMinutes).toBe(3*DAY);
  // Included rows stay available to the original complete-node caller, but
  // do not become independent delivery roots or terminal work.
  expect(result.arranged.map(row=>row.id)).toEqual(['a','pack']);
 });
 it('charges the shared stage reserve once per real stage crossing',()=>{
  const saved=plan({a:rule(1/24),b:rule(1/24),pack:rule(1/24)});saved.company.stageBufferMinutes=60;
  const nodes=[work('a',[],2),work('b',['a'],3),work('pack',['b'],3)],result=evaluateOrderTimeScenario(scenario(saved,1,nodes))[0]!;
  expect(result.requiredSpanMinutes).toBe(240);expect(result.planSpanMinutes).toBe(240);
  const changed=reviseOrderTimePlan(saved,{},0);expect(evaluateOrderTimeScenario(scenario(changed,1,nodes))[0]!.requiredSpanMinutes).toBe(180);
 });
 it('compares actual calendar instants while48counted hours excluding Sunday span72physical hours',()=>{
  const saved=plan({a:{...rule(2),calendar:'beijing_sunday_excluded'}}),input=scenario(saved,10,[work('a')]);
  input.start={precision:'instant',value:'2026-11-06T08:00:00+08:00',source:'TEST Friday planned start'};
  const result=evaluateOrderTimeScenario(input)[0]!;expect(result.expectedEnd?.at).toBe('2026-11-09T00:00:00.000Z');expect(result.requiredSpanMinutes).toBe(72*60);
 });
 it('honors a genuinely later expected prerequisite without recording it as actual readiness',()=>{
  const input={...scenario(plan({a:rule(2)}),10,[work('a')]),notBefore:{a:anchor(4)}};
  const result=evaluateOrderTimeScenario(input)[0]!;expect(result.expectedEnd?.at).toBe(at(6));expect(input).not.toHaveProperty('facts');
 });
 it('keeps the exclusive end of a customer date instead of treating next midnight as on time',()=>{
  const original=scenario(plan({a:rule(1/24)}),10,[work('a')]),goal={precision:'date' as const,value:'2026-11-09',source:'TEST original date-only H'};
  const input={...original,start:{precision:'instant' as const,value:'2026-11-09T23:00:00+08:00',source:'TEST actual creation instant'},scopes:[{...original.scopes[0]!,goals:{a:goal},customerGoal:goal}]};
  expect(evaluateOrderTimeScenario(input)[0]).toMatchObject({feasibility:'insufficient',lateMinutes:1/60000,customerGoal:{at:'2026-11-09T16:00:00.000Z',exclusive:true}});
 });
 it('keeps PO risk independent rather than offsetting a late PO with an early sibling',()=>{
  const input=scenario(standard());input.scopes.push({...input.scopes[0]!,scopeRef:'TEST PO2',goals:{pack:anchor(6)},customerGoal:anchor(6)});
  expect(evaluateOrderTimeScenario(input).map(row=>[row.scopeRef,row.feasibility,row.lateMinutes])).toEqual([['TEST PO1','sufficient',0],['TEST PO2','insufficient',2*DAY]]);
 });
 it('keeps retained B while a new craft uses remaining adopted budgets to obtain its first target',()=>{
  const saved=plan({cut:rule(2),printing:rule(2),sew:rule(2),pack:rule(1)}),old=[work('cut'),work('sew',['cut']),work('pack',['sew'])];
  const fixed=Object.fromEntries(fixedTimelineTargets(old.map(n=>({...n,minutes:saved.company.nodes[n.parameterKey]!.minutes,calendar:'continuous' as const})),{pack:anchor(10)}).map(row=>[row.id,row]));
  const added=[work('cut'),work('printing',['cut']),work('sew',['printing']),work('pack',['sew'])];
  const adjusted=reviseOrderTimePlan(saved,{printing:rule(1),sew:rule(1)}),input={...scenario(adjusted,10,added),start:anchor(5),fixedTargets:fixed};
  const result=evaluateOrderTimeScenario(input)[0]!;
  expect(result).toMatchObject({feasibility:'sufficient',expectedEnd:{at:at(10)}});
  for(const id of ['cut','sew','pack'])expect(result.targets.find(row=>row.id===id)).toEqual(fixed[id]);
  expect(result.targets.find(row=>row.id==='printing')!.end.at).toBe(at(8));
  const missing=reviseOrderTimePlan(adjusted,{sew:{...rule(1),minutes:null}});
  const unknown=evaluateOrderTimeScenario({...input,plan:missing})[0]!;
  expect(unknown.feasibility).toBe('unknown');expect(unknown.targets.find(row=>row.id==='printing')!.end.at).toBeNull();
  expect(unknown.targets.find(row=>row.id==='sew')).toEqual(fixed.sew);
 });
});

describe('new ordinary-node value and old frozen compatibility',()=>{
 const legacy=():FixedWorkInputs=>({data:{unified:{configurationId:'TEST original',snapshotRef:'TEST frozen unified',values:{ruleVersion:DIGITAL_SLA_RULE_VERSION,parameters:Object.fromEntries(Object.entries(digitalSlaDefaults()).map(([key,value])=>[key,{value,source:'global',sourceVersion:1}]))}},development:{snapshotRef:'TEST cycle',version:1,values:{externalWashDays:9}},planning:{standardRef:'TEST planning',version:1,values:{development_washing:{minutes:DAY,calendar:'continuous'}}}}});
 it('does not reinterpret old split planning and responsibility windows',()=>{
  const input=legacy();input.data.planning!.values.development_pattern={minutes:DAY,calendar:'beijing_sunday_excluded'};
  expect(frozenWorkDefinition(input,'development_pattern')).toMatchObject({minutes:DAY,responsibilityMinutes:2*DAY,responsibilityCalendar:'continuous'});
 });
 it('uses the same adopted duration/calendar for new planning and ordinary responsibility without external-wash override',()=>{
  const input=legacy();input.data.orderTimePlan=plan({development_washing:{...rule(2),calendar:'beijing_sunday_excluded'}});
  expect(frozenWorkDefinition(input,'development_washing')).toMatchObject({minutes:2*DAY,responsibilityMinutes:2*DAY,calendar:'beijing_sunday_excluded',responsibilityCalendar:'beijing_sunday_excluded'});
  const current=fixedDevelopmentWork(input,'TEST source',1,['development_washing'],[],false,'外洗',false);
  expect(current.work[0]).toMatchObject({minutes:2*DAY,responsibilityMinutes:2*DAY});
  delete input.data.orderTimePlan;expect(fixedDevelopmentWork(input,'TEST source',1,['development_washing'],[],false,'外洗',false).work[0]!.minutes).toBe(9*DAY);
 });
 it('keeps dates, logistics estimates, supervision and included work distinct from ordinary responsibility',()=>{
  const input=legacy();input.data.orderTimePlan=plan({date:{...rule(0),kind:'date'},travel:rule(2,'forecast'),measure:rule(3,'supervision'),handoff:rule(0.5,'included')});
  expect(frozenWorkDefinition(input,'date')).toMatchObject({minutes:0,responsibilitySlaRef:null});
  expect(frozenWorkDefinition(input,'travel')).toMatchObject({minutes:2*DAY,responsibilitySlaRef:null});
  expect(frozenWorkDefinition(input,'measure')).toMatchObject({minutes:0,responsibilitySlaRef:null});
  expect(orderTimeRule(input.data.orderTimePlan,'measure')!.rule.minutes).toBe(3*DAY);
  expect(()=>evaluateOrderTimeScenario(scenario(input.data.orderTimePlan,10,[work('handoff')]))).toThrow('内含交接');
 });
 it('uses adopted offsets and the same stage reserve edges in original native work builders',()=>{
  const input=legacy();input.data.orderTimePlan=plan({ship_sample_advance:{...rule(0),kind:'offset',days:4}});input.data.orderTimePlan.stageBufferMinutes=60;
  const current=fixedOrderWork(input,'TEST order','TEST source',1,'不需预缩',[],false,null,[{line_id:'TEST PO',goal:anchor(10),customerDateVersion:1}]);
  expect(current.consumers[0]!.shipSample!.advanceDays).toBe(4);
  expect(current.work.find(node=>node.id==='warehouse_dispatch')!.dependencyReserves).toEqual({bulk_cutting:{minutes:60,calendar:'continuous'},sourcing_approval:{minutes:60,calendar:'continuous'}});
  expect(current.work.find(node=>node.id==='factory_work:TEST PO')!.dependencyReserves).toEqual({warehouse_dispatch:{minutes:60,calendar:'continuous'}});
  expect(current.work.find(node=>node.id==='garment_packing:TEST PO')!.dependencyReserves).toEqual({});
 });
});
