import {describe,it,expect} from 'vitest';
import {FrozenOrderTimePlanSchema,reviseOrderTimePlan,type OrderTimeRule} from '../../packages/contracts/src/order-time-plan.js';
import {TimeFrameworkInputSchema,readTimeFrameworkPlan,type TimeFrameworkInput,type FrameworkResponsibilityWindow} from '../../packages/contracts/src/order-time-framework.js';
import {evaluateTimeFrameworkCandidate,freezeTimeFrameworkCandidate,initialFrameworkMilestoneStandard,evaluateFrameworkResponsibility} from '../../apps/api/src/production-platform/order-time-framework.js';
import {fixedTimelineForward} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
import {overlayFrameworkCompletion,retainedFrameworkWork} from '../../apps/api/src/production-platform/order-time-framework-route.js';

const at=(day:number,hour=8)=>`2026-11-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00+08:00`;
const iso=(day:number,hour=8)=>new Date(at(day,hour)).toISOString();
const anchor=(day:number,hour=8)=>({precision:'instant' as const,value:at(day,hour),source:'TEST native evidence'});
const rule=(days:number):OrderTimeRule=>({kind:'work',minutes:days*1440,calendar:'continuous',reminder:{enabled:true,percent:70}});
const context=(day=2)=>({purpose:'order_proposal' as const,observedAt:at(day)});
function fixture():TimeFrameworkInput{
 const standard=initialFrameworkMilestoneStandard('B','TEST original milestone standard',1);
 // This fixture intentionally customizes company offsets. Dates are independent
 // business expectations, not dates obtained by calling the production code.
 for(const key of Object.keys(standard.offsets) as Array<keyof typeof standard.offsets>)if(key!=='color_confirmation')standard.offsets[key]=0;
 standard.offsets.processing_dispatch=5;
 const work=[{id:'fabric',parameterKey:'fabric',stage:2,dependsOn:[]},{id:'pattern',parameterKey:'pattern',stage:2,dependsOn:[]},
  {id:'dispatch',parameterKey:'dispatch',stage:2,dependsOn:['fabric','pattern']},{id:'pack',parameterKey:'pack',stage:2,dependsOn:['dispatch']}];
 return TimeFrameworkInputSchema.parse({scopeRef:'TEST PO1/round1',route:'B',acceptedAt:anchor(2),customerDelivery:{date:'2026-11-10',source:'TEST customer approval',revision:1},
  plan:{version:'order-time-plan-v1',revision:1,company:{version:'order-time-standard-v1',reference:'TEST original company',revision:1,
   nodes:{fabric:rule(3),pattern:rule(2),dispatch:rule(1),pack:rule(2)},stageBufferMinutes:0},overrides:{}},
  milestoneStandard:standard,work,bindings:Object.entries(standard.offsets).filter(([,offset])=>offset!==null).map(([key])=>({key,workIds:[key==='processing_dispatch'?'dispatch':'pack']})),notBefore:{}});
}
const version={reference:'TEST plan1',revision:1,previousReference:null,eventRef:'TEST native approval'};

describe('three-layer time foundation, no live adoption',()=>{
 it('retains started native windows and arrangements when a milestone is only partly complete',()=>{
  const input=fixture(),original=evaluateTimeFrameworkCandidate(input,context()),native={completed:false,actualAt:null,readyAt:iso(3),deadline:iso(7),calendar:'continuous' as const,unresolvedOverrun:true};
  const partial=overlayFrameworkCompletion(native,{scopeRef:'whole',completed:false,precision:'unknown',occurredAt:null});
  expect(partial).toEqual(native);
  const kept=retainedFrameworkWork(input,new Map([['fabric',partial]]),{reference:'TEST current plan',arranged:original.arranged});
  expect(kept.fabric?.target).toEqual(original.arranged[0]);
  expect(evaluateTimeFrameworkCandidate(input,{...context(6),retained:kept}).arranged[0]).toEqual(original.arranged[0]);
  const done={...native,completed:true,actualAt:iso(5)};
  expect(overlayFrameworkCompletion(done,{scopeRef:'whole',completed:false,precision:'unknown',occurredAt:null})).toEqual(done);
  expect(overlayFrameworkCompletion({...done,actualAt:null},{scopeRef:'whole',completed:true,precision:'instant',occurredAt:iso(6)})).toEqual({...done,actualAt:iso(6)});
  expect(overlayFrameworkCompletion(done,{scopeRef:'whole',completed:true,precision:'instant',occurredAt:iso(8)})).toEqual(done);
  expect(overlayFrameworkCompletion(native,{scopeRef:input.scopeRef,completed:true,precision:'instant',occurredAt:iso(6)})).toEqual({...native,completed:true,actualAt:iso(6)});
 });
 it('retains a completed original plan while successors use the genuine later completion boundary',()=>{
  const input=fixture(),end={at:iso(5),exclusive:false,reasons:[]},start={...end,at:iso(2)};
  const result=evaluateTimeFrameworkCandidate(input,{...context(6),retained:{fabric:{target:{id:'fabric',start,end},sourceRef:'TEST plan before completion',actualCompletion:{...end,at:iso(6)}}}});
  expect(result.arranged.find(row=>row.id==='fabric')?.end.at).toBe(iso(5));
  // The unstarted pattern cannot be placed before the actual approval on 6th.
  expect(result.arranged.find(row=>row.id==='pattern')?.start.at).toBe(iso(6));
  expect(result.arranged.find(row=>row.id==='dispatch')?.start.at).toBe(iso(8));
  expect(result.retained.fabric?.actualCompletion?.at).toBe(iso(6));
  const snapshot=freezeTimeFrameworkCandidate(result,version);
  expect(readTimeFrameworkPlan(snapshot)).toMatchObject({kind:'framework',plan:{retained:{fabric:{target:{end:{at:iso(5)}},actualCompletion:{at:iso(6)}}}}});
 });
 it('reuses original A9/B8 offsets including shipment without conflating factory and customer dates',()=>{
  const a=initialFrameworkMilestoneStandard('A','TEST A',1),b=initialFrameworkMilestoneStandard('B','TEST B',1);
  expect(a.offsets).toEqual({design_handover:95,material_investment:95,fabric_receipt:54,color_confirmation:42,client_sample_approval:44,accessories_ready:33,style_label_ready:33,processing_dispatch:28,planned_shipment:0});
  expect(b.offsets).toEqual({...a.offsets,design_handover:64,material_investment:64,fabric_receipt:33,color_confirmation:null});
  expect(Object.values(a.offsets).filter(value=>value!==null)).toHaveLength(9);
  expect(Object.values(b.offsets).filter(value=>value!==null)).toHaveLength(8);
 });
 it('plans before ready, detects a late intermediate milestone even though delivery still fits',()=>{
  const result=evaluateTimeFrameworkCandidate(fixture(),context());
  expect(result.arranged.map(row=>[row.id,row.end.at])).toEqual([['fabric',iso(5)],['pattern',iso(4)],['dispatch',iso(6)],['pack',iso(8)]]);
  // Dispatch must finish within Beijing Nov5, so Nov6 08:00 is 8h late.
  expect(result.milestones.find(row=>row.key==='processing_dispatch')).toMatchObject({date:'2026-11-05',status:'insufficient',lateMinutes:480});
  expect(result.milestones.find(row=>row.key==='planned_shipment')).toMatchObject({date:'2026-11-10',status:'sufficient',marginMinutes:64*60});
  expect(result.status).toBe('insufficient');expect(result).not.toHaveProperty('ready');
 });
 it('shortening a noncritical parallel branch saves no total time and does not move milestones',()=>{
  const input=fixture(),before=evaluateTimeFrameworkCandidate(input,context());
  input.plan=reviseOrderTimePlan(input.plan,{pattern:rule(1)});
  const changed=evaluateTimeFrameworkCandidate(input,context());
  expect(changed.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(8));
  expect(changed.milestones.map(row=>row.date)).toEqual(before.milestones.map(row=>row.date));
  input.plan=reviseOrderTimePlan(input.plan,{fabric:rule(2)});
  expect(evaluateTimeFrameworkCandidate(input,context()).milestones.find(row=>row.key==='processing_dispatch')).toMatchObject({status:'sufficient',marginMinutes:16*60});
 });
 it('reports each shortage without summing them and preserves known late branches beside unknown ones',()=>{
  const input=fixture();input.plan.company.nodes.pattern={...rule(2),minutes:null};
  input.milestoneStandard.offsets.fabric_receipt=7;
  input.bindings.find(row=>row.key==='fabric_receipt')!.workIds=['fabric','pattern'];
  const result=evaluateTimeFrameworkCandidate(input,context());
  expect(result.milestones.find(row=>row.key==='fabric_receipt')).toMatchObject({status:'insufficient',planned:{at:null},lateMinutes:32*60,marginMinutes:null,blockingWorkIds:['fabric','pattern']});
  expect(result.milestones.find(row=>row.key==='planned_shipment')!.status).toBe('unknown');
  expect(result.status).toBe('insufficient');expect(()=>freezeTimeFrameworkCandidate(result,version)).toThrow('必要依据');
 });
 it('requires complete applicable milestone membership, valid references and the original shipment date',()=>{
  const input=fixture();input.bindings.pop();expect(()=>TimeFrameworkInputSchema.parse(input)).toThrow();
  const bad=fixture();bad.bindings[0]!.workIds=['unrelated'];expect(()=>evaluateTimeFrameworkCandidate(bad,context())).toThrow();
  const shipment=fixture();shipment.milestoneStandard.offsets.planned_shipment=1;expect(()=>TimeFrameworkInputSchema.parse(shipment)).toThrow();
  const color=fixture();color.route='A';expect(()=>TimeFrameworkInputSchema.parse(color)).toThrow();
 });
 it('uses current submission as a lower bound once, not as repeated extra waiting at every successor',()=>{
  const result=evaluateTimeFrameworkCandidate(fixture(),context(6));
  expect(result.arranged.map(row=>row.end.at)).toEqual([iso(9),iso(8),iso(10),iso(12)]);
  expect(result.milestones.find(row=>row.key==='planned_shipment')).toMatchObject({status:'insufficient',lateMinutes:32*60});
  expect(result.arranged[0]!.start.at).toBe(iso(6));
 });
 it('keeps completed work before approval and only bounds remaining work at the approval time',()=>{
  const input=fixture(),retained={fabric:{id:'fabric',start:{at:iso(2),exclusive:false,reasons:[]},end:{at:iso(5),exclusive:false,reasons:[]}},
   pattern:{id:'pattern',start:{at:iso(2),exclusive:false,reasons:[]},end:{at:iso(4),exclusive:false,reasons:[]}}};
  const result=evaluateTimeFrameworkCandidate(input,{...context(6),retained:Object.fromEntries(Object.entries(retained).map(([id,target])=>[id,{target,sourceRef:'TEST original native completion '+id}]))});
  expect(result.arranged.find(row=>row.id==='fabric')).toEqual(retained.fabric);
  expect(result.arranged.find(row=>row.id==='dispatch')).toMatchObject({start:{at:iso(6)},end:{at:iso(7)}});
  expect(result.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(9));
  expect(freezeTimeFrameworkCandidate(result,version).retained.fabric!.sourceRef).toBe('TEST original native completion fabric');
 });
 it('separates settings preview from effective snapshots and never rereads a later company standard',()=>{
  const input=fixture(),preview=evaluateTimeFrameworkCandidate(input,{purpose:'settings_preview',observedAt:at(6)});
  expect(preview.arranged[0]!.start.at).toBe(iso(2));expect(()=>freezeTimeFrameworkCandidate(preview,version)).toThrow('设置演算');
  const saved=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(input,context()),version);
  input.plan.company.nodes.fabric=rule(30);input.customerDelivery.date='2026-12-31';
  expect(saved.input.plan.company.nodes.fabric!.minutes).toBe(3*1440);
  expect(saved.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(8));
  const decoded=readTimeFrameworkPlan(JSON.parse(JSON.stringify(saved)));
  expect(decoded).toEqual({kind:'framework',plan:saved});
 });
 it('reads v1 unchanged, rejects unknown/malformed new versions, and does not invent missing layers',()=>{
  const old=FrozenOrderTimePlanSchema.parse(fixture().plan),decoded=readTimeFrameworkPlan(JSON.parse(JSON.stringify(old)));
  expect(decoded).toEqual({kind:'legacy',plan:old});expect(decoded.plan).not.toHaveProperty('milestones');
  expect(()=>readTimeFrameworkPlan({...old,version:'order-time-plan-v999'})).toThrow('不支持');
  const saved=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(fixture(),context()),version);
  expect(()=>readTimeFrameworkPlan({...saved,arranged:[]})).toThrow();
  expect(()=>readTimeFrameworkPlan({...saved,revision:2,previousReference:null})).toThrow();
  expect(()=>readTimeFrameworkPlan({...saved,revision:2,previousReference:saved.reference})).toThrow();
 });
 it('holds independent scope versions instead of sharing mutable per-PO results',()=>{
  const input=fixture(),one=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(input,context()),version);
  input.scopeRef='TEST PO2/round1';input.customerDelivery.date='2026-11-20';
  const two=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(input,context()),{...version,reference:'TEST plan2'});
  expect(one.input.customerDelivery.date).toBe('2026-11-10');expect(two.input.customerDelivery.date).toBe('2026-11-20');
  expect(one.milestones.find(row=>row.key==='processing_dispatch')!.date).toBe('2026-11-05');
 });
 it('does not charge included handoff twice and enforces original parent calendar',()=>{
  const input=fixture();input.plan.company.nodes.handoff={...rule(.25),kind:'included'};
  input.work.push({id:'handoff',parameterKey:'handoff',stage:2,dependsOn:[],includedIn:'fabric',includedPosition:'end'});
  const result=evaluateTimeFrameworkCandidate(input,context());
  expect(result.arranged.find(row=>row.id==='handoff')).toMatchObject({start:{at:iso(5,2)},end:{at:iso(5)}});
  expect(result.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(8));
  input.work.find(row=>row.id==='dispatch')!.dependsOn=['handoff'];expect(()=>evaluateTimeFrameworkCandidate(input,context())).toThrow('内含交接');
 });
 it('joins stage reserves with max and uses the original Sunday calendar',()=>{
  const input=fixture();input.acceptedAt=anchor(6);input.plan.company.nodes.fabric={...rule(2),calendar:'beijing_sunday_excluded'};
  input.plan.company.nodes.pattern=rule(1);input.plan.company.stageBufferMinutes=60;input.work.find(row=>row.id==='dispatch')!.stage=3;
  input.work.find(row=>row.id==='pack')!.stage=3;
  const result=evaluateTimeFrameworkCandidate(input,context(6));
  expect(result.arranged.find(row=>row.id==='fabric')!.end.at).toBe(iso(9));
  expect(result.arranged.find(row=>row.id==='dispatch')!.start.at).toBe(iso(9,9));
  expect(result.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(12,9));
 });
 it('does not reinterpret dates as exact actual arrivals or erase unknown planned prerequisites',()=>{
  const input=fixture();input.notBefore.fabric={precision:'date',value:'2026-11-05',source:'TEST expected arrival day'};
  const result=evaluateTimeFrameworkCandidate(input,context());
  expect(result.arranged.find(row=>row.id==='fabric')!.start).toMatchObject({at:iso(6,0),exclusive:true});
  input.notBefore.fabric={precision:'unknown',reason:'采购预计依据待补'};
  expect(evaluateTimeFrameworkCandidate(input,context()).arranged.find(row=>row.id==='fabric')!.end.at).toBeNull();
 });
 it('counts explicitly ordered special work serially without changing the milestone template',()=>{
  const input=fixture();input.plan.company.nodes.special=rule(1);
  input.work.push({id:'special',parameterKey:'special',stage:2,dependsOn:['dispatch']});
  input.work.find(row=>row.id==='pack')!.dependsOn=['special'];
  const result=evaluateTimeFrameworkCandidate(input,context());
  expect(result.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(9));
  expect(result.milestones.find(row=>row.key==='processing_dispatch')!.date).toBe('2026-11-05');
 });
 it('treats exact next-day Beijing midnight as beyond a date-only delivery deadline',()=>{
  const input=fixture();input.acceptedAt=anchor(2,0);input.customerDelivery.date='2026-11-07';
  const result=evaluateTimeFrameworkCandidate(input,{purpose:'order_proposal',observedAt:at(2,0)});
  expect(result.arranged.find(row=>row.id==='pack')!.end.at).toBe(iso(8,0));
  expect(result.milestones.find(row=>row.key==='planned_shipment')).toMatchObject({status:'insufficient',lateMinutes:1/60000});
 });
 it('keeps an exact-boundary late branch when another completion shares its exclusive upper bound',()=>{
  const input=fixture();input.bindings.find(row=>row.key==='fabric_receipt')!.workIds=['fabric','pattern'];
  const target=(id:string,exclusive:boolean)=>({id,start:{at:iso(2),exclusive:false,reasons:[]},end:{at:iso(11,0),exclusive,reasons:[]}});
  for(const ordered of [['fabric','pattern'],['pattern','fabric']]){
   input.bindings.find(row=>row.key==='fabric_receipt')!.workIds=ordered;
   const result=evaluateTimeFrameworkCandidate(input,{...context(),retained:{fabric:{target:target('fabric',true),sourceRef:'TEST retained date bound'},pattern:{target:target('pattern',false),sourceRef:'TEST retained exact plan'}}});
   expect(result.milestones.find(row=>row.key==='fabric_receipt')).toMatchObject({status:'insufficient',planned:{exclusive:false},lateMinutes:1/60000,blockingWorkIds:['pattern']});
  }
 });
 it('rejects retained wrong identities, backwards time, dependency cycles and duplicate work',()=>{
  const input=fixture();input.work[0]!.dependsOn=['pack'];expect(()=>evaluateTimeFrameworkCandidate(input,context())).toThrow('成环');
  const duplicate=fixture();duplicate.work.push(duplicate.work[0]!);expect(()=>evaluateTimeFrameworkCandidate(duplicate,context())).toThrow('身份重复');
  const work=[{id:'a',minutes:60,calendar:'continuous' as const,dependsOn:[]}];
  const row={id:'b',start:{at:iso(4),exclusive:false,reasons:[]},end:{at:iso(3),exclusive:false,reasons:[]}};
  expect(()=>fixedTimelineForward(work,anchor(2),{},{retained:{a:row}})).toThrow('不属于');
  expect(()=>fixedTimelineForward(work,anchor(2),{},{retained:{a:{...row,id:'a'}}})).toThrow('早于');
 });
});

describe('native responsibility is not a plan or a milestone',()=>{
 const window=():FrameworkResponsibilityWindow=>({scopeRef:'TEST PO1/round1',workId:'sew',eventRef:'TEST native readiness',standardRef:'TEST adopted',standardRevision:1,startedAt:at(5),minutes:3*1440,calendar:'continuous',attributionKnown:true});
 it('5th start, three days, 8th finish is within its own window; 9th finish is one day overdue',()=>{
  expect(evaluateFrameworkResponsibility({actual:{state:'completed',completion:anchor(8)},window:window(),observedAt:at(10)})).toMatchObject({deadline:iso(8),overdueMinutes:0,status:'within_window'});
  expect(evaluateFrameworkResponsibility({actual:{state:'completed',completion:anchor(9)},window:window(),observedAt:at(10)})).toMatchObject({deadline:iso(8),overdueMinutes:1440,status:'overdue'});
 });
 it('does not open an unready PO clock and does not reset a sibling from the whole-task start',()=>{
  const a={...window(),startedAt:at(2,2),minutes:1440};
  expect(evaluateFrameworkResponsibility({actual:{state:'running'},window:a,observedAt:at(3,1)})).toMatchObject({deadline:iso(3,2),overdueMinutes:0});
  expect(evaluateFrameworkResponsibility({actual:{state:'not_started'},window:null,observedAt:at(3,1)})).toEqual({deadline:null,overdueMinutes:null,status:'not_started'});
 });
 it('freezes terminated observation at its real event, without claiming completion',()=>{
  for(const day of [9,15,20])expect(evaluateFrameworkResponsibility({actual:{state:'terminated',termination:anchor(9)},window:window(),observedAt:at(day)})).toMatchObject({status:'overdue',overdueMinutes:1440});
  expect(evaluateFrameworkResponsibility({actual:{state:'terminated',termination:{precision:'unknown',reason:'原取消时间缺失'}},window:window(),observedAt:at(20)})).toMatchObject({status:'unknown',overdueMinutes:null});
 });
 it('keeps measured overrun even when its attribution is still unknown',()=>{
  expect(evaluateFrameworkResponsibility({actual:{state:'completed',completion:anchor(9)},window:{...window(),attributionKnown:false},observedAt:at(10)}))
   .toMatchObject({deadline:iso(8),status:'unknown',overdueMinutes:1440});
 });
 it('does not label missing, date-only or future evidence as innocent',()=>{
  const cases=[{completion:anchor(9),window:null},
   {completion:{precision:'date' as const,value:'2026-11-09',source:'TEST date only'},window:window()},
   {completion:anchor(11),window:window()},{completion:anchor(4),window:window()}];
  for(const item of cases)expect(evaluateFrameworkResponsibility({actual:{state:'completed',completion:item.completion},window:item.window,observedAt:at(10)})).toMatchObject({status:'unknown',overdueMinutes:null});
 });
 it('uses the frozen responsibility calendar and counts no Sunday overdue hours',()=>{
  const own={...window(),startedAt:at(6),minutes:24*60,calendar:'beijing_sunday_excluded' as const};
  expect(evaluateFrameworkResponsibility({actual:{state:'running'},window:own,observedAt:at(9)})).toMatchObject({deadline:iso(7),overdueMinutes:1440});
 });
});

it('derives event constraints from frozen milestones and downstream preparation without inventing event work or changing the plan',async()=>{
 const {frameworkNodeTargets,frameworkTargetPrecision}=await import('../../apps/api/src/production-platform/framework-node-targets.js');
 const input=fixture(),event={kind:'event' as const,minutes:0 as const,calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
 input.plan.company.nodes.budget=event;input.plan.company.nodes.design_handover=event;
 input.work.push({id:'budget',parameterKey:'budget',stage:2,dependsOn:[]},{id:'handover',parameterKey:'design_handover',stage:1,dependsOn:[]});
 input.work.find(row=>row.id==='dispatch')!.dependsOn.push('budget');
 input.bindings.find(row=>row.key==='design_handover')!.workIds=['handover'];
 const frozen=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(input,context()),version),before=structuredClone(frozen);
 const targets=frameworkNodeTargets(frozen);
 expect(targets.get('handover')!.end).toMatchObject({at:iso(11,0),exclusive:true});
 // Dispatch must end by November5, and takes one day; budget has no extra
 // work quota, but must be available before that downstream work begins.
 expect(targets.get('budget')!.end).toMatchObject({at:iso(5,0),exclusive:true});
 expect(frameworkTargetPrecision(targets.get('budget'))).toEqual({targetPrecision:'date',targetDate:'2026-11-04'});
 expect(frozen.arranged.find(row=>row.id==='budget')!.end.at).toBe(iso(2));
 expect(frozen).toEqual(before);
 const later=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(input,context(3)),{...version,reference:"TEST plan2",revision:2,previousReference:version.reference});
 expect(later.arranged.find(row=>row.id==='budget')!.end.at).toBe(iso(3));
 expect(frameworkNodeTargets(later).get('budget')).toEqual(targets.get('budget'));
 expect(frameworkTargetPrecision({id:'precise',start:{at:iso(5,0),exclusive:false,reasons:[]},end:{at:iso(5,0),exclusive:false,reasons:[]}})).toEqual({targetPrecision:'instant',targetDate:null});
});
