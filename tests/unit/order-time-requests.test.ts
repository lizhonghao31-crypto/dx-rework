import {describe,expect,it} from 'vitest';
import type {OrderTimeInput} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {orderTimeRemaining,orderTimeCheck,orderTimeBegunStates,type OrderTimeNativeProgress} from '../../apps/api/src/production-platform/order-time-request-plan.js';
import {evaluateOrderTimeScenario} from '../../apps/api/src/production-platform/order-time-schedule.js';
import {orderTimeBulkSteps,orderTimeStoredBulkSteps} from '../../apps/api/src/production-platform/order-time-route-identities.js';

const at=(day:number)=>new Date(Date.UTC(2027,0,day,0)).toISOString();
function input():OrderTimeInput{return {version:'order-time-input-v1',plan:{version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST frozen creation counterpart',revision:1,stageBufferMinutes:0,nodes:{a:{kind:'work',minutes:2880,calendar:'continuous',reminder:{enabled:true,percent:70}},b:{kind:'work',minutes:2880,calendar:'continuous',reminder:{enabled:true,percent:70}}}}},route:{complete:true,missing:[]},work:[{id:'a',parameterKey:'a',stage:2,dependsOn:[]},{id:'b',parameterKey:'b',stage:2,dependsOn:['a']}],scopes:[{scopeRef:'TEST actual PO',lineId:null,terminalIds:['b'],customerGoalIds:[],customerGoal:{precision:'instant',value:at(10),source:'TEST customer commitment'},goals:{b:{precision:'instant',value:at(10),source:'TEST customer commitment'}}}]};}
const time={now:at(7),scenarioId:null,revision:0};
describe('R5 per-order conditional remaining-time evaluation',()=>{
 it('does not invent a deadline or on-time result for an independent sample with its optional completion date empty',()=>{
  const value=input();value.scopes[0]!.scopeRef='source:TEST:round:1';value.scopes[0]!.customerGoal={precision:'unknown',reason:'未填写选填样板日期'};value.scopes[0]!.goals.b=value.scopes[0]!.customerGoal;
  const original=structuredClone(value),args={value,time,progress:new Map(),sourceVersion:{},resource:{kind:'source' as const,id:'TEST source'},styleNo:'TEST',customerDates:[{po:'样板',date:null}],canRequest:true,canApply:false};
  const checked=orderTimeCheck({...args,optionalDevelopmentGoal:true});
  expect(checked).toMatchObject({feasibility:'not_applicable',availableMinutes:null,lateMinutes:null,requiredMinutes:5760,expectedEnd:at(11),coverage:[]});
  expect(orderTimeCheck(args).feasibility).toBe('unknown');
  expect(orderTimeCheck({...args,resource:{kind:'order',id:'TEST order'},optionalDevelopmentGoal:true}).feasibility).toBe('unknown');
  value.scopes[0]!.scopeRef='po:TEST';expect(orderTimeCheck({...args,optionalDevelopmentGoal:true}).feasibility).toBe('unknown');
  value.scopes[0]!.scopeRef=original.scopes[0]!.scopeRef;expect(value).toEqual(original);
 });
 it('keeps missing standards, material bounds, actual times and exhausted windows blocking an undated independent sample',()=>{
  const value=input();value.scopes[0]!.scopeRef='source:TEST:round:1';value.scopes[0]!.customerGoal={precision:'unknown',reason:'选填日期未填'};
  const progress=new Map<string,OrderTimeNativeProgress>(),check=()=>orderTimeCheck({value,time,progress,sourceVersion:{},resource:{kind:'source',id:'TEST source'},styleNo:'TEST',customerDates:[],canRequest:true,canApply:true,optionalDevelopmentGoal:true});
  const rule=value.plan.company.nodes.b!;value.plan.company.nodes.b={...rule,minutes:null};expect(check().feasibility).toBe('unknown');value.plan.company.nodes.b=rule;
  value.route={complete:false,missing:['原单面料未到位且没有预计到位日']};expect(check().coverage).toContain('原单面料未到位且没有预计到位日');value.route={complete:true,missing:[]};
  progress.set('b',{completed:true,actualAt:null,readyAt:at(4),deadline:at(6)});expect(check().coverage).toContain('已完成但缺少可信完成时间');
  progress.clear();progress.set('a',{completed:false,actualAt:null,readyAt:at(4),deadline:at(6)});expect(check()).toMatchObject({feasibility:'unknown',lateMinutes:null});expect(check().coverage).toContain('在办节点已超时，剩余工作时间尚未确认');
 });
 it('still evaluates an explicitly filled sample date and never treats it as optional missing',()=>{
  const value=input();value.scopes[0]!.scopeRef='source:TEST:round:1';
  const checked=orderTimeCheck({value,time,progress:new Map(),sourceVersion:{},resource:{kind:'source',id:'TEST source'},styleNo:'TEST',customerDates:[],canRequest:true,canApply:true,optionalDevelopmentGoal:true});
  expect(checked).toMatchObject({feasibility:'insufficient',lateMinutes:1440});
 });
 it('detects a full day short for7th start/10th promise with serial A+B of two days each without moving customer H',()=>{
  const value=input(),original=structuredClone(value),result=orderTimeRemaining(value,time,new Map());
  expect(result.scopes[0]).toMatchObject({feasibility:'insufficient',lateMinutes:1440,requiredSpanMinutes:5760,expectedEnd:{at:at(11)}});expect(value).toEqual(original);
 });
 it.each([[-1,'sufficient',0],[0,'insufficient',0],[1,'insufficient',1/60000]] as const)('preserves exact differences at %i ms around the legacy application cutoff', (milliseconds,feasibility,lateMinutes)=>{
  const value=input();value.scopes[0]!.customerGoal={precision:'date',value:'2027-01-11',source:'TEST exact exclusive customer date'};
  const observed={...time,now:new Date(Date.parse('2027-01-07T16:00:00.000Z')+milliseconds).toISOString()};
  const args={value,time:observed,progress:new Map(),sourceVersion:{},resource:{kind:'source' as const,id:'TEST source'},styleNo:'TEST',customerDates:[],canRequest:true,canApply:true};
  expect(orderTimeRemaining(value,observed,args.progress).scopes[0]).toMatchObject({feasibility,lateMinutes});
  expect(orderTimeCheck(args)).toMatchObject({feasibility,lateMinutes});
 });
 it('uses a closed endpoint when two legacy terminals share the final deadline',()=>{
  const value=input(),scope=value.scopes[0]!;scope.customerGoal={precision:'date',value:'2027-01-11',source:'TEST exclusive customer date'};
  const boundary='2027-01-11T16:00:00.000Z',observation={...time,now:at(12)};
  const progress=new Map<string,OrderTimeNativeProgress>([['a',{completed:true,actualAt:null,actualDate:'2027-01-11',readyAt:null,deadline:null}],['b',{completed:true,actualAt:boundary,readyAt:null,deadline:null}]]);
  for(const terminals of [['a','b'],['b','a']]){
   scope.terminalIds=terminals;
   expect(orderTimeRemaining(value,observation,progress).scopes[0]).toMatchObject({feasibility:'insufficient',lateMinutes:0,expectedEnd:{at:boundary,exclusive:false}});
  }
 });
 it('does not zero an unfinished sibling that shares the same company parameter or count completed work twice',()=>{
  const value=input();value.work[1]!.parameterKey='a';
  const progress=new Map<string,OrderTimeNativeProgress>([['a',{completed:true,actualAt:at(6),readyAt:at(4),deadline:at(6)}]]),result=orderTimeRemaining(value,time,progress);
  expect(result.scopes[0]).toMatchObject({feasibility:'sufficient',requiredSpanMinutes:2880,expectedEnd:{at:at(9)}});expect(value.plan.company.nodes.a!.minutes).toBe(2880);
 });
 it('retains an active original deadline after a per-order duration edit and labels an exhausted window as a lower bound',()=>{
  const value=input();value.plan.overrides.a={...value.plan.company.nodes.a!,minutes:60};
  const progress=new Map<string,OrderTimeNativeProgress>([['a',{completed:false,actualAt:null,readyAt:at(6),deadline:at(8),calendar:'continuous'}]]);
  expect(orderTimeRemaining(value,time,progress).scopes[0]).toMatchObject({requiredSpanMinutes:4320,expectedEnd:{at:at(10)}});
  progress.get('a')!.deadline=at(6);const result=orderTimeRemaining(value,time,progress);expect(result.lowerBound).toBe(true);expect(result.scopes[0]!.expectedEnd!.at).toBe(at(9));
 });
 it('passes whole milliseconds from an active deadline and a partially spent stage reserve through forward planning',()=>{
  const value=input(),now='2026-11-18T01:50:48.407Z',deadline='2027-05-28T16:00:00.000Z';
  const completion='2027-05-30T16:00:00.000Z',observation={...time,now};
  const active=new Map<string,OrderTimeNativeProgress>([['a',{completed:false,actualAt:null,readyAt:now,deadline,calendar:'continuous'}]]);
  expect(orderTimeRemaining(value,observation,active).scopes[0]!.expectedEnd?.at).toBe(completion);
  value.work[1]!.stage=3;
  value.plan.company.stageBufferMinutes=525600;
  // The physical 14,982,648,407 elapsed milliseconds leave exactly the same
  // 16,553,351,593 ms in the reserve, before the remaining two-day work.
  const actualAt=new Date(Date.parse(now)-14_982_648_407).toISOString();
  const completed=new Map<string,OrderTimeNativeProgress>([['a',{completed:true,actualAt,readyAt:null,deadline:null}]]);
  expect(orderTimeRemaining(value,observation,completed).scopes[0]!.expectedEnd?.at).toBe(completion);
 });
 it('joins truly parallel prerequisites by the last branch and keeps necessary unknown route inputs unknown',()=>{
  const value=input();value.work[1]!.dependsOn=[];value.scopes[0]!.terminalIds=['a','b'];value.scopes[0]!.goals.a=value.scopes[0]!.customerGoal;
  expect(orderTimeRemaining(value,time,new Map()).scopes[0]!.requiredSpanMinutes).toBe(2880);
  value.route={complete:false,missing:['请确认是否需要预缩']};expect(orderTimeRemaining(value,time,new Map()).scopes[0]).toMatchObject({feasibility:'unknown',lateMinutes:null,expectedEnd:null});
 });
 it('keeps included handoffs within the shrinking parent window and freezes a genuinely completed terminal',()=>{
  const value=input();value.plan.company.nodes.handoff={kind:'included',minutes:60,calendar:'continuous',reminder:{enabled:true,percent:70}};
  value.work.push({id:'handoff',parameterKey:'handoff',stage:2,dependsOn:[],includedIn:'a'});
  const progress=new Map<string,OrderTimeNativeProgress>([['a',{completed:false,actualAt:null,readyAt:at(6),deadline:'2027-01-07T00:30:00.000Z',calendar:'continuous'}]]);
  expect(orderTimeRemaining(value,time,progress).scopes[0]).toMatchObject({requiredSpanMinutes:2910,expectedEnd:{at:'2027-01-09T00:30:00.000Z'}});
  progress.set('b',{completed:true,actualAt:at(9),readyAt:at(7),deadline:at(10)});
  expect(orderTimeRemaining(value,{...time,now:at(12)},progress).scopes[0]).toMatchObject({feasibility:'sufficient',requiredSpanMinutes:0,lateMinutes:0,expectedEnd:{at:at(9)}});
  progress.get('b')!.actualAt=null;expect(orderTimeRemaining(value,{...time,now:at(12)},progress).scopes[0]).toMatchObject({feasibility:'unknown',expectedEnd:null});
 });
 it('does not call an exhausted unfinished window feasible just because its optimistic lower bound fits',()=>{
  const value=input(),progress=new Map<string,OrderTimeNativeProgress>([['a',{completed:false,actualAt:null,readyAt:at(5),deadline:at(6)}]]);
  const checked=orderTimeCheck({value,time,progress,sourceVersion:{},resource:{kind:'source',id:'TEST original source'},styleNo:'TEST',customerDates:[],canRequest:true,canApply:true});
  expect(checked).toMatchObject({feasibility:'unknown',forecastQuality:'lower_bound',expectedEnd:at(9),lateMinutes:0});expect(checked.coverage).toContain('在办节点已超时，剩余工作时间尚未确认');
 });
 it('keeps each PO own readiness and remaining work separate for a shared predecessor',()=>{
  const value=input();value.scopes[0]!.scopeRef='po:one';value.scopes.push({...structuredClone(value.scopes[0]!),scopeRef:'po:two',customerGoal:{precision:'instant',value:at(11),source:'TEST second PO'}});
  const progress=new Map<string,OrderTimeNativeProgress>([['po:one|a',{completed:true,actualAt:at(6),readyAt:at(4),deadline:at(6)}]]),result=orderTimeRemaining(value,time,progress);
  expect(result.scopes.map(scope=>scope.expectedEnd?.at)).toEqual([at(9),at(11)]);expect(result.scopes.map(scope=>scope.requiredSpanMinutes)).toEqual([2880,5760]);
 });
 it('allows a shared standard for a future PO while preserving the sibling original in-flight window',()=>{
  const value=input();value.scopes[0]!.scopeRef='po:one';value.scopes.push({...structuredClone(value.scopes[0]!),scopeRef:'po:two'});
  const progress=new Map<string,OrderTimeNativeProgress>([['po:one|a',{completed:false,actualAt:null,readyAt:at(6),deadline:at(8),calendar:'continuous'}]]);
  expect(orderTimeBegunStates(value,progress).get('a')).toEqual({any:true,all:false});
  const checked=orderTimeCheck({value,time,progress,sourceVersion:{},resource:{kind:'source',id:'TEST original source'},styleNo:'TEST',customerDates:[],canRequest:true,canApply:true});
  expect(checked.rows.find(row=>row.id==='a')).toMatchObject({begun:false,preserveBegun:true});
  value.plan.overrides.a={...value.plan.company.nodes.a!,minutes:60};
  expect(orderTimeRemaining(value,time,progress).scopes.map(scope=>scope.requiredSpanMinutes)).toEqual([4320,2940]);
  progress.set('po:two|a',{completed:true,actualAt:at(6),readyAt:at(4),deadline:at(6)});
  expect(orderTimeBegunStates(value,progress).get('a')).toEqual({any:true,all:true});
 });
 it('keeps the ship-sample side target before both production start and the original customer offset without adding a second delivery span',()=>{
  const value=input();value.plan.company.nodes.ship_sample={kind:'date',minutes:0,calendar:'continuous',reminder:{enabled:true,percent:70}};
  value.work.push({id:'sample',parameterKey:'ship_sample',stage:5,dependsOn:[]});value.scopes[0]!.shipSample={nodeId:'sample',productionNodeId:'b',customerGoalId:'b',advanceDays:4};value.scopes[0]!.goals={...value.scopes[0]!.goals,sample:{precision:'unknown',reason:'由本PO生产开始及提前量求解'}};
  const result=evaluateOrderTimeScenario({...value,start:{precision:'instant',value:at(7),source:'TEST start'}})[0]!;
  expect(result.targets.find(target=>target.id==='sample')?.end.at).toBe(at(6));expect(result.requiredSpanMinutes).toBe(5760);
 });
 it('reserves real-order step identities through actual preparation and gives a changed sequence new identities',()=>{
  const original=orderTimeBulkSteps('TEST real order',0,[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}],[]);
  const value=input();value.work=original.map(step=>({id:'bulk_'+step.craftKind+':'+step.stepId,parameterKey:'bulk_'+step.craftKind,stage:5,dependsOn:[],canonicalWorkRef:'order:TEST real order:step:'+step.stepId+':work'}));
  expect(orderTimeBulkSteps('TEST real order',1,original,orderTimeStoredBulkSteps(value))).toEqual(original);
  const changed=orderTimeBulkSteps('TEST real order',2,[{craftKind:'printing',sequence:1},{craftKind:'embroidery',sequence:2}],original);expect(changed.every(step=>!original.some(old=>old.stepId===step.stepId))).toBe(true);
  expect(orderTimeBulkSteps('TEST another order',0,original,[])).not.toEqual(original);
 });
});
