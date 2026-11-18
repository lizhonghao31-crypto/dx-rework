import {orderTimeGapText} from '@dx-rework/contracts/order-time-requests';
import {describe,it,expect} from 'vitest';
import {TimeFrameworkInputSchema} from '../../packages/contracts/src/order-time-framework.js';
import {initialFrameworkMilestoneStandard} from '../../apps/api/src/production-platform/order-time-framework.js';
import {evaluateFrameworkSubmission} from '../../apps/api/src/production-platform/order-time-framework-submission.js';
const at=(day:number)=>`2026-11-${String(day).padStart(2,'0')}T08:00:00+08:00`;
function scope(id='PO1',route:'A'|'B'='B'){
 const standard=initialFrameworkMilestoneStandard(route,'TEST standard',1);
 for(const key of Object.keys(standard.offsets) as Array<keyof typeof standard.offsets>)if(standard.offsets[key]!==null)standard.offsets[key]=0;
 standard.offsets.processing_dispatch=5;
 const rule=(days:number)=>({kind:'work',minutes:1440*days,calendar:'continuous',reminder:{enabled:true,percent:70}});
 return {input:TimeFrameworkInputSchema.parse({scopeRef:id,route,acceptedAt:{precision:'instant',value:at(2),source:'TEST accepted'},
  customerDelivery:{date:'2026-11-10',source:'TEST customer delivery',revision:1},milestoneStandard:standard,
  plan:{version:'order-time-plan-v1',revision:1,company:{version:'order-time-standard-v1',reference:'TEST frozen',revision:1,nodes:{a:rule(3),b:rule(2),dispatch:rule(1),pack:rule(2)},stageBufferMinutes:0},overrides:{}},
  work:[{id:'a',parameterKey:'a',stage:2,dependsOn:[]},{id:'b',parameterKey:'b',stage:2,dependsOn:[]},
   {id:'dispatch',parameterKey:'dispatch',stage:5,dependsOn:['a','b']},{id:'pack',parameterKey:'pack',stage:7,dependsOn:['dispatch']}],
  bindings:Object.entries(standard.offsets).filter(([,value])=>value!==null).map(([key])=>({key,workIds:[key==='processing_dispatch'?'dispatch':'pack']})),notBefore:{}})};
}
const evaluate=(scopes=[scope()],mode:'automatic'|'adjustment'='automatic',acceptLate=false,observedAt=at(2))=>evaluateFrameworkSubmission({scopes,mode,acceptLate,observedAt});
describe('PR06 submission decision using merged PR01 only, no business writer enabled',()=>{
 it('requests adjustment for an intermediate 8h gap although final delivery is two days away',()=>{
  const result=evaluate();expect(result.action).toBe('request_adjustment');
  expect(result.gaps).toEqual([{scopeRef:'PO1',key:'processing_dispatch',date:'2026-11-05',lateMinutes:480,workIds:['dispatch']}]);
  expect(result.delivery).toEqual([{scopeRef:'PO1',date:'2026-11-10',status:'sufficient',lateMinutes:0}]);
  expect(result.candidates[0]!.arranged.find(row=>row.id==='pack')!.end.at).toBe('2026-11-08T00:00:00.000Z');
 });
 it('uses the same intermediate-gap wording in preview and submission, never saying late zero days',()=>{
  const result=evaluate(),text=orderTimeGapText({lateMinutes:0,framework:{riskAccepted:false,milestones:result.candidates.flatMap(candidate=>candidate.milestones.map(row=>({...row,scopeRef:candidate.input.scopeRef})))}});
  expect(text).toContain('0.34天');expect(text).toContain('最终交期仍可满足');expect(text).not.toContain('晚交0');
  expect(orderTimeGapText({lateMinutes:null})).toBe('完成时间尚待核实');
 });
 it('reports final delivery as insufficient when a closed endpoint has exactly zero margin',()=>{
  const item=scope();
  item.input.customerDelivery.date='2026-11-07';
  item.input.plan.company.nodes.pack={kind:'work',minutes:40*60,calendar:'continuous',reminder:{enabled:true,percent:70}};
  const result=evaluate([item]);
  expect(result.action).toBe('request_adjustment');
  const milestones=result.candidates[0]!.milestones.map(row=>({...row,scopeRef:item.input.scopeRef}));
  expect(milestones.find(row=>row.key==='planned_shipment')).toMatchObject({status:'insufficient',marginMinutes:0,lateMinutes:0});
  const text=orderTimeGapText({lateMinutes:0,framework:{riskAccepted:false,milestones}});
  expect(text).toContain('计划出货时间不足');expect(text).toContain('最终交期时间不足');
  expect(text).not.toMatch(/晚0天|最终交期仍可满足/);
 });
 it('requires explicit confirmation on the same adjustment submission and preserves accepted gaps',()=>{
  expect(evaluate([scope()],'adjustment').action).toBe('confirm_gap');
  const result=evaluate([scope()],'adjustment',true);expect(result.action).toBe('adopt');expect(result.riskAccepted).toBe(true);expect(result.gaps[0]!.lateMinutes).toBe(480);
  expect(evaluate([scope()],'automatic',true).action).toBe('request_adjustment');
 });
 it('adopts sufficient arrangements before any actual ready event exists',()=>{
  const item=scope();item.input.milestoneStandard.offsets.processing_dispatch=4;
  const result=evaluate([item]);expect(result.action).toBe('adopt');expect(result.riskAccepted).toBe(false);expect(result.missing).toEqual([]);
 });
 it('missing necessary inputs cannot be overridden by accepting risk, known late branches remain visible',()=>{
  const item=scope();delete item.input.plan.company.nodes.pack;
  const result=evaluate([item],'adjustment',true);expect(result.action).toBe('complete_inputs');expect(result.riskAccepted).toBe(false);
  expect(result.missing.some(row=>row.workId==='pack'&&row.reasons.length>0)).toBe(true);expect(result.gaps[0]!.key).toBe('processing_dispatch');
 });
 it('keeps separate PO gaps rather than offsetting one with another PO spare time',()=>{
  const other=scope('PO2');other.input.milestoneStandard.offsets.processing_dispatch=0;
  const result=evaluate([scope(),other]);expect(result.action).toBe('request_adjustment');expect(result.gaps).toHaveLength(1);expect(result.gaps[0]!.scopeRef).toBe('PO1');expect(result.delivery).toHaveLength(2);
 });
 it('late approval recalculates pending work from its actual observation without altering the prior input',()=>{
  const item=scope(),before=structuredClone(item);
  const result=evaluate([item],'adjustment',false,at(8));expect(result.action).toBe('confirm_gap');
  expect(result.candidates[0]!.arranged.find(row=>row.id==='pack')!.end.at).toBe('2026-11-14T00:00:00.000Z');
  expect(result.delivery[0]!.lateMinutes).toBe(4800);expect(item).toEqual(before);
 });
 it('retains completed work evidence while unfinished work cannot be newly scheduled in the past',()=>{
  const item=scope(),target={id:'a',start:{at:'2026-11-02T00:00:00.000Z',exclusive:false,reasons:[]},end:{at:'2026-11-05T00:00:00.000Z',exclusive:false,reasons:[]}};
  const result=evaluateFrameworkSubmission({scopes:[{...item,retained:{a:{target,sourceRef:'TEST real completion event'}}}],mode:'adjustment',acceptLate:false,observedAt:at(8)});
  expect(result.candidates[0]!.arranged.find(row=>row.id==='a')).toEqual(target);
  expect(result.candidates[0]!.arranged.find(row=>row.id==='b')!.start.at).toBe('2026-11-08T00:00:00.000Z');
  expect(result.candidates[0]!.input.plan.revision).toBe(1);expect(result.action).toBe('confirm_gap');
 });
 it('keeps A9/B8 route membership and never adds color confirmation to B',()=>{
  const result=evaluate([scope('A','A'),scope('B','B')]);expect(result.candidates.map(row=>row.milestones.length)).toEqual([9,8]);
 });
 it('rejects empty or duplicate scope input instead of adopting an empty order',()=>{
  expect(()=>evaluate([])).toThrow('缺少');expect(()=>evaluate([scope(),scope()])).toThrow('重复');
 });
});
