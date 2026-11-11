import {describe,it,expect} from 'vitest';
import {evaluateFixedScheduleScope,fixedDurationSummary,fixedGoalDelta,scheduleElapsed,type ScheduleScopeInput,type ScheduleWork,type ScheduleFact} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {shiftFixedTimeline} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
const origin=Date.parse('2026-11-02T00:00:00+08:00'),at=(hours:number)=>new Date(origin+hours*3600000).toISOString();
const unknown={precision:'unknown' as const},instant=(hours:number)=>({precision:'instant' as const,at:at(hours)});
const work=(id:string,start:number,end:number,dependsOn:string[]=[],extra:Partial<ScheduleWork>={}):ScheduleWork=>({id,canonicalWorkRef:'native:'+id,dependsOn,start:at(start),end:at(end),minutes:(end-start)*60,calendar:'continuous',responsibilitySlaRef:'adopted:'+id,responsibilityMinutes:(end-start)*60,responsibilityCalendar:'continuous',...extra});
const fact=(ready:number|null,completed:number|null,extra:Partial<ScheduleFact>={}):ScheduleFact=>({ready:ready===null?unknown:instant(ready),completed:completed===null?unknown:instant(completed),clockStart:ready===null?unknown:instant(ready),businessCompleted:completed!==null,waitingForPredecessors:ready===null,evidenceRefs:['native:test'],...extra});
const scope=(works:ScheduleWork[],facts:Record<string,ScheduleFact>,terminalIds=[works.at(-1)!.id]):ScheduleScopeInput=>({scopeRef:'po:one',lineId:'one',targetRevision:'B0',work:works,facts,terminalIds,customerGoal:works.at(-1)!.end});
const evaluate=(input:ScheduleScopeInput,hours:number)=>evaluateFixedScheduleScope(input,at(hours));

describe('fixed schedule progress, independent goal/own SLA and physical spans',()=>{
 it.each([[6,-3],[8,-1],[9,0],[10,1]])('spends only earned credit at%s and keeps fixed B', (now,lag)=>{const input=scope([work('a',0,5),work('b',5,9,['a'])],{a:fact(0,2),b:fact(2,null)}),result=evaluate(input,now);expect(result.lagMinutes).toEqual({minimum:lag*60,maximum:lag*60});expect(result.nodes[1]!.goalDelta.targetAt).toBe(at(9));expect(result.state).toBe(lag>0?'late':'normal');});
 it('keeps the approved A5 B4 C1 states and labels an overdue unfinished boundary honestly',()=>{
  const input=scope([work('a',0,5),work('b',5,9,['a']),work('c',9,10,['b'])],{a:fact(0,2),b:fact(2,null),c:fact(null,null)});
  for(const [now,end,lag,kind,own]of [[5,7,-3,'conditional',0],[8,9,-1,'lower_bound',2],[10,11,1,'lower_bound',4]] as const){
   const result=evaluate(input,now);
   expect(result.completionEstimate).toEqual({kind,earliest:at(end),latest:kind==='lower_bound'?null:at(end)});
   expect(result.lagMinutes).toEqual({minimum:lag*60,maximum:lag*60});
   expect(result.nodes[1]!.ownSla.overdueMinutes).toEqual({minimum:own*60,maximum:own*60});
   expect(result.nodes[1]!.goalDelta.targetAt).toBe(at(9));
   expect(input.facts.b!.completed).toEqual(unknown);
  }
  input.facts={...input.facts,b:fact(2,8),c:fact(8,null)};
  expect(evaluate(input,8)).toMatchObject({lagMinutes:{minimum:-60},completionEstimate:{kind:'conditional',earliest:at(9)}});
  input.facts={...input.facts,c:fact(8,9)};
  for(const now of [9,20])expect(evaluate(input,now)).toMatchObject({lagMinutes:{minimum:-60},completionEstimate:{kind:'actual',earliest:at(9)}});
 });
 it('replaces the active estimate with complete A once, never double counts prior credit',()=>{for(const [done,lag]of [[8,-1],[11,2]]){const input=scope([work('a',0,5),work('b',5,9,['a'])],{a:fact(0,2),b:fact(2,done)});expect(evaluate(input,12).lagMinutes!.minimum).toBe(lag*60);}});
 it('keeps carried delay when own next SLA is normal, then recovers on real completion',()=>{const input=scope([work('a',0,4),work('b',4,8,['a'])],{a:fact(0,6),b:fact(6,null)}),running=evaluate(input,7);expect(running.state).toBe('late');expect(running.lagMinutes!.minimum).toBe(120);expect(running.nodes[1]!.ownSla.state).toBe('within');input.facts={...input.facts,b:fact(6,8)};expect(evaluate(input,9).lagMinutes!.minimum).toBe(0);});
 it('does not consume now once per unstarted descendant',()=>{const works=Array.from({length:6},(_,index)=>work('n'+index,index*2,index*2+2,index?['n'+(index-1)]:[])),facts=Object.fromEntries(works.map((node,index)=>[node.id,fact(index?null:0,null)]));expect(evaluate(scope(works,facts),3).lagMinutes!.minimum).toBe(60);});
 it('retains structural parallel float and waits for the last required branch',()=>{const works=[work('long',0,5),work('short',3,5),work('end',5,6,['long','short'])],facts={long:fact(0,null),short:fact(0,null),end:fact(null,null)},input=scope(works,facts),running=evaluate(input,3);expect(running.state).toBe('normal');expect(running.nodes[1]!.ownSla).toMatchObject({state:'overdue',overdueMinutes:{minimum:60}});input.facts={...facts,long:fact(0,3)};expect(evaluate(input,3).lagMinutes!.minimum).toBe(0);input.facts={...facts,long:fact(0,3),short:fact(0,3),end:fact(3,null)};expect(evaluate(input,3).lagMinutes!.minimum).toBe(-120);});
 it('aligns a shared tighter own target to this consumer without awarding unused float',()=>{const input=scope([work('a',0,5),work('b',1,3),work('c',5,6,['a','b'])],{a:fact(0,2),b:fact(1,null),c:fact(null,null)});expect(evaluate(input,3).lagMinutes!.minimum).toBe(0);input.facts={...input.facts,b:fact(1,3),c:fact(3,null)};expect(evaluate(input,3).lagMinutes!.minimum).toBe(-120);});
 it.each([[0,-2],[1,-1],[2,0],[3,1]])('spends added work progressively at%s without granting its own SLA budget', (duration,lag)=>{const input=scope([work('a',0,8),work('repair',6,8,['a'],{accountingRole:'added_work',originalHandoffAt:at(8)}),work('next',8,10,['repair'])],{a:fact(0,6),repair:fact(6,null,{impactStartedAt:at(6)}),next:fact(null,null)});expect(evaluate(input,6+duration).lagMinutes!.minimum).toBe(lag*60);});
 it('passes the original handoff through consecutive added scopes with different new B ends',()=>{const input=scope([work('a',0,10),work('r1',7,9,['a'],{accountingRole:'added_work',originalHandoffAt:at(10)}),work('r2',8,10,['r1'],{accountingRole:'added_work',originalHandoffAt:at(10)}),work('b',10,12,['r2'])],{a:fact(0,7),r1:fact(7,7,{impactStartedAt:at(7)}),r2:fact(null,null),b:fact(null,null)});expect(evaluate(input,7).lagMinutes!.minimum).toBe(-180);});
 it('does not infer an original handoff from the new added target',()=>{const input=scope([work('r',6,8,[],{accountingRole:'added_work'})],{r:fact(6,null)});expect(evaluate(input,6).state).toBe('unknown');});
 it('retains physical Sunday availability separately from zero counted credit',()=>{const sunday='2026-11-08T12:00:00+08:00',monday='2026-11-09T00:00:00+08:00',start='2026-11-07T00:00:00+08:00',first=work('a',0,1,[],{start,end:monday,minutes:1440,calendar:'beijing_sunday_excluded',responsibilityCalendar:'beijing_sunday_excluded'}),second=work('b',0,1,['a'],{start:monday,end:'2026-11-10T00:00:00+08:00',minutes:1440}),input=scope([first,second],{a:{...fact(0,null),ready:{precision:'instant',at:start},clockStart:{precision:'instant',at:start}},b:fact(null,null)});expect(shiftFixedTimeline(sunday,0,'beijing_sunday_excluded')).toBe(sunday);expect(evaluateFixedScheduleScope(input,sunday).lagMinutes!.minimum).toBe(0);input.facts={...input.facts,a:{...input.facts.a!,businessCompleted:true,completed:{precision:'instant',at:sunday}},b:{...fact(null,null),ready:{precision:'instant',at:sunday}}};expect(evaluateFixedScheduleScope(input,sunday).lagMinutes!.minimum).toBe(-720);expect(scheduleElapsed(Date.parse(sunday),Date.parse(monday),'beijing_sunday_excluded')).toBe(0);});
 it('propagates unfinished physical availability during noncounting time to a continuous successor',()=>{const first=work('a',0,1,[],{calendar:'beijing_sunday_excluded'}),second=work('b',1,2,['a']);first.start='2026-11-07T22:00:00+08:00';first.end='2026-11-07T23:00:00+08:00';second.start='2026-11-08T00:00:00+08:00';second.end='2026-11-08T01:00:00+08:00';const input=scope([first,second],{a:{...fact(0,null),ready:{precision:'instant',at:first.start}},b:fact(null,null)});expect(evaluateFixedScheduleScope(input,'2026-11-08T00:30:00+08:00').lagMinutes!.minimum).toBe(30);});
 it('preserves completed but unrecorded physical time without repeatedly debiting now',()=>{const input=scope([work('a',0,4)],{a:fact(0,null,{businessCompleted:true})});expect(evaluate(input,10)).toMatchObject({state:'unknown',nodes:[{businessCompleted:true,lagMinutes:null,goalDelta:{kind:'unknown'}}]});expect(evaluate(input,20).lagMinutes).toBeNull();});
 it('does not use future completion as earned credit',()=>{const input=scope([work('a',0,4)],{a:fact(0,8)});expect(evaluate(input,5).state).toBe('unknown');});
 it.each([3,8])('retains completion before known R%s (including a future R) as unknown instead of early credit or zero own overtime',ready=>{const input=scope([work('a',0,4)],{a:fact(ready,2)}),result=evaluate(input,5);expect(result.nodes[0]).toMatchObject({businessCompleted:true,state:'unknown',goalDelta:{kind:'unknown',signedValue:null},ownSla:{state:'unknown',overdueMinutes:null}});expect(fixedDurationSummary([input],at(5)).finalActualSpanMinutes).toBeNull();});
 it('keeps date-only completion as an interval and never publishes midnight actual',()=>{const node=work('a',0,4),input=scope([node],{a:fact(0,null,{businessCompleted:true,completed:{precision:'date',date:'2026-11-02'}})}),result=evaluate(input,24);expect(result.state).toBe('unknown');expect(result.nodes[0]!.goalDelta).toMatchObject({kind:'unknown',actual:{precision:'date',date:'2026-11-02'}});});
 it('returns signed goal deltas independently and keeps subhour lateness positive',()=>{const node=work('a',0,4),input=scope([node],{});expect(fixedGoalDelta(node,fact(0,2),input,at(6))).toMatchObject({kind:'early',signedValue:-120});expect(fixedGoalDelta(node,fact(0,4),input,at(6))).toMatchObject({kind:'on_target',signedValue:0});expect(fixedGoalDelta(node,fact(0,null),input,at(4+1/60))).toMatchObject({kind:'late',signedValue:1});});
 it('keeps date targets normal throughout their original business date',()=>{const node=work('a',0,24,[],{targetPrecision:'date',targetDate:'2026-11-02'}),input=scope([node],{});expect(fixedGoalDelta(node,fact(0,null),input,at(23))).toMatchObject({kind:'on_target',signedValue:0,unit:'day'});expect(fixedGoalDelta(node,fact(0,null),input,at(24))).toMatchObject({kind:'late',signedValue:1});});
 it('requires an independently adopted own SLA and retains terminated unfinished goal state',()=>{const input=scope([work('a',0,4,[],{responsibilitySlaRef:null})],{a:fact(0,null)}),end={at:at(8),kind:'special_closure' as const},result=evaluateFixedScheduleScope(input,at(20),end);expect(result.state).toBe('terminated');expect(result.nodes[0]!.goalDelta.kind).toBe('terminated');expect(result.nodes[0]!.ownSla.state).toBe('not_adopted');});
 it('uses one whole-order span and real delivery or termination, never sums PO windows',()=>{const a=scope([work('a',0,12)],{a:fact(1,null)}),b={...scope([work('b',2,10)],{b:fact(3,null)}),scopeRef:'po:two',lineId:'two'};expect(fixedDurationSummary([a,b],at(8))).toMatchObject({planSpanMinutes:720,elapsedSpanMinutes:{minimum:420,maximum:420},finalActualSpanMinutes:null});expect(fixedDurationSummary([a,b],at(20),{at:at(8),kind:'cancelled'})).toMatchObject({observationAt:at(8),elapsedSpanMinutes:{minimum:420},finalActualSpanMinutes:null});a.facts={a:fact(1,11)};b.facts={b:fact(3,10)};expect(fixedDurationSummary([a,b],at(20))).toMatchObject({elapsedSpanMinutes:{minimum:600},finalActualSpanMinutes:{minimum:600},deliveryCompletedAt:instant(11)});});
 it('does not replace an unrecorded termination with now or a customer goal',()=>{const input=scope([work('a',0,12)],{a:fact(1,null)});expect(fixedDurationSummary([input],at(20),{at:null,kind:'cancelled'})).toMatchObject({observationAt:null,elapsedSpanMinutes:null,finalActualSpanMinutes:null});});
 it('retains an unknown original start when only downstream packing has R and A',()=>{
  const input=scope([work('original',0,6),work('packing',6,8,['original'])],{original:fact(null,null),packing:fact(6,8)});
  expect(fixedDurationSummary([input],at(10))).toMatchObject({actualStart:{precision:'unknown'},elapsedSpanMinutes:null,finalActualSpanMinutes:null,coverage:expect.arrayContaining(['本单可信起点待核'])});
  input.facts={...input.facts,original:fact(1,5)};
  expect(fixedDurationSummary([input],at(10))).toMatchObject({actualStart:instant(1),finalActualSpanMinutes:{minimum:420,maximum:420}});
 });
 it('does not turn a partly unknown parallel original start into an exact span',()=>{
  const input=scope([work('a',0,6),work('b',1,6),work('packing',6,8,['a','b'])],{a:fact(1,5),b:fact(null,6),packing:fact(6,8)});
  expect(fixedDurationSummary([input],at(10))).toMatchObject({actualStart:{precision:'unknown'},finalActualSpanMinutes:null});
 });

 it('starts elapsed time from the first credible required root without waiting for a genuinely future root',()=>{
  const input=scope([work('a',0,6),work('b',1,6),work('packing',6,8,['a','b']),work('optional_shipping',0,20)],{a:fact(1,null),b:fact(null,null,{notYetReady:true}),packing:fact(null,null),optional_shipping:fact(null,null)},['packing']);
  input.customerGoal=at(8);
  expect(fixedDurationSummary([input],at(4))).toMatchObject({actualStart:instant(1),elapsedSpanMinutes:{minimum:180,maximum:180},planSpanMinutes:480,finalActualSpanMinutes:null});
  input.facts={...input.facts,b:fact(null,3,{notYetReady:true})};
  expect(fixedDurationSummary([input],at(4)).actualStart).toEqual(unknown);
 });

 it('freezes a terminated unfinished own SLA at credible Z and leaves missing or inverted Z unknown',()=>{
  const input=scope([work('a',0,4)],{a:fact(0,null)});
  for(const now of [8,20,30])expect(evaluateFixedScheduleScope(input,at(now),{at:at(8),kind:'cancelled'}).nodes[0]!.ownSla).toMatchObject({state:'terminated',overdueMinutes:{minimum:240,maximum:240}});
  for(const stop of [null,at(-1),at(40)])expect(evaluateFixedScheduleScope(input,at(30),{at:stop,kind:'special_closure'}).nodes[0]!.ownSla).toMatchObject({state:'terminated',overdueMinutes:null});
  input.facts={a:fact(0,null,{terminated:true})};expect(evaluate(input,30).nodes[0]!.ownSla.overdueMinutes).toBeNull();
  input.facts={a:fact(0,null,{terminated:true,terminationAt:at(8)})};
  for(const now of [8,20,30])expect(evaluate(input,now).nodes[0]!.ownSla.overdueMinutes).toEqual({minimum:240,maximum:240});
 });

});
