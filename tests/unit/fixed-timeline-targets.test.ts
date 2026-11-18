import {expect,it} from 'vitest';
import {fixedMinutesToMilliseconds,fixedTimelineElapsedMilliseconds,fixedTimelineForward,fixedTimelineTargets,shiftFixedTimeline,shiftFixedTimelineMilliseconds,type FixedTimelineWork} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
import {fixedConsumerTargets,type FixedTimelineConsumer,type FixedTimelineInput} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
const work=(id:string,minutes:number,dependsOn:string[]=[]):FixedTimelineWork=>({id,minutes,dependsOn,calendar:'continuous'});
const end={precision:'instant' as const,value:'2026-11-09T12:00:00.000Z',source:'TEST approved PO H'};
it('backplans all applicable serial and parallel work without adding parallel durations',()=>{
 const nodes=[work('technical',60),work('commercial',120),work('cut',30,['technical','commercial']),work('pack',60,['cut'])];
 expect(fixedTimelineTargets(nodes,{pack:end}).map(node=>({id:node.id,start:node.start.at,end:node.end.at}))).toEqual([
  {id:'technical',start:'2026-11-09T09:30:00.000Z',end:'2026-11-09T10:30:00.000Z'},
  {id:'commercial',start:'2026-11-09T08:30:00.000Z',end:'2026-11-09T10:30:00.000Z'},
  {id:'cut',start:'2026-11-09T10:30:00.000Z',end:'2026-11-09T11:00:00.000Z'},
  {id:'pack',start:'2026-11-09T11:00:00.000Z',end:'2026-11-09T12:00:00.000Z'}
 ]);
});
it('uses earliest real consumer requirement and keeps contained handoff inside its original parent',()=>{
 const nodes=[work('shared',120),work('early',60,['shared']),work('late',30,['shared']),{...work('handoff',30),includedIn:'shared',includedPosition:'start' as const}];
 const result=fixedTimelineTargets(nodes,{early:end,late:{...end,value:'2026-11-10T12:00:00.000Z'}});
 expect(result[0]!.end.at).toBe('2026-11-09T11:00:00.000Z');expect(result[0]!.start.at).toBe('2026-11-09T09:00:00.000Z');
 expect(result[3]!.end.at).toBe('2026-11-09T09:30:00.000Z');
});
it('retains date-only exclusive customer boundary without treating it as actual midnight',()=>{
 const target=fixedTimelineTargets([work('pack',60)],{pack:{precision:'date',value:'2026-11-09',source:'TEST actual PO customer date'}})[0]!;
 expect(target.end).toEqual({at:'2026-11-09T16:00:00.000Z',exclusive:true,reasons:[]});expect(target.start.exclusive).toBe(true);
});
it('preserves Sunday zero and follows the original Sunday-excluded positive and backward boundaries',()=>{
 const sunday='2026-11-08T05:00:00.123Z';expect(shiftFixedTimeline(sunday,0,'beijing_sunday_excluded')).toBe(sunday);
 expect(shiftFixedTimeline('2026-11-07T15:00:00.000Z',60,'beijing_sunday_excluded')).toBe('2026-11-08T16:00:00.000Z');
 expect(shiftFixedTimeline('2026-11-08T16:00:00.000Z',-60,'beijing_sunday_excluded')).toBe('2026-11-07T15:00:00.000Z');
});
it('recovers the exact observed whole milliseconds through both planning directions',()=>{
 const delta=16_553_351_593,minutes=delta/60_000;
 const start='2026-11-18T01:50:48.407Z',finish='2027-05-28T16:00:00.000Z';
 expect(Math.abs(minutes*60_000-delta)).toBeGreaterThan(1e-6);
 expect(fixedMinutesToMilliseconds(minutes)).toBe(delta);
 expect(fixedMinutesToMilliseconds(-minutes)).toBe(-delta);
 for(const calendar of ['continuous','natural_days'] as const){
  const nodes=[{...work('pack',minutes),calendar}];
  expect(fixedTimelineTargets(nodes,{pack:{...end,value:finish}})[0]!.start.at).toBe(start);
  expect(fixedTimelineForward(nodes,{...end,value:start})[0]!.end.at).toBe(finish);
 }
});
it('keeps true submillisecond and unsafe inputs outside the fixed timeline',()=>{
 for(const minutes of [.25/60_000,.5/60_000,-.5/60_000,Infinity,NaN,(Number.MAX_SAFE_INTEGER+1)/60_000]){
  expect(()=>fixedMinutesToMilliseconds(minutes)).toThrow('合法毫秒精度');
 }
 expect(()=>shiftFixedTimelineMilliseconds(0,.5,'continuous')).toThrow('合法毫秒精度');
 expect(()=>shiftFixedTimelineMilliseconds(8_640_000_000_000_000,1,'natural_days')).toThrow('时刻超出有效范围');
 expect(()=>fixedTimelineElapsedMilliseconds(-8_640_000_000_000_000,8_640_000_000_000_000,'continuous')).toThrow('合法毫秒精度');
});
it('skips whole Beijing weeks without changing midnight or one-millisecond boundaries',()=>{
 const monday=Date.parse('2026-11-09T00:00:00+08:00'),day=86_400_000,weeks=10_000,calendar='beijing_sunday_excluded';
 const limit=monday+weeks*7*day;
 expect(shiftFixedTimelineMilliseconds(monday,weeks*6*day,calendar)).toBe(limit);
 expect(shiftFixedTimelineMilliseconds(limit,-weeks*6*day,calendar)).toBe(monday);
 expect(shiftFixedTimelineMilliseconds(monday,weeks*6*day-1,calendar)).toBe(limit-day-1);
 expect(shiftFixedTimelineMilliseconds(limit,1,calendar)).toBe(limit+1);
 expect(shiftFixedTimelineMilliseconds(limit,-1,calendar)).toBe(limit-day-1);
 expect(fixedTimelineElapsedMilliseconds(monday+1,limit,calendar)).toBe(weeks*6*day-1);
 expect(fixedTimelineElapsedMilliseconds(limit,monday+1,calendar)).toBe(1-weeks*6*day);
 expect(fixedTimelineElapsedMilliseconds(limit-day,limit,calendar)).toBe(0);
});
it('agrees with counting individual Beijing dates at partial-week boundaries',()=>{
 const day=86_400_000,offset=28_800_000,calendar='beijing_sunday_excluded';
 const begin=Date.parse('2026-11-07T22:10:20.123+08:00');
 const count=(from:number,to:number)=>{
  let total=0;
  for(let start=from;start<to;){
   const local=new Date(start+offset);
   const midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+1)-offset;
   const end=Math.min(midnight,to);
   if(local.getUTCDay()!==0)total+=end-start;
   start=end;
  }
  return total;
 };
 for(const days of [0,1,3,7,11,33]){
  const end=begin+days*day+2*offset;
  const counted=count(begin,end);
  expect(fixedTimelineElapsedMilliseconds(begin,end,calendar)).toBe(counted);
  expect(fixedTimelineElapsedMilliseconds(end,begin,calendar)).toBe(-counted);
  // Partial destinations on a Sunday are equivalent on the counted clock;
  // the positive and reverse movement contracts choose their own boundaries.
  for(const delta of [counted-1,counted,counted+1]){
   const forward=shiftFixedTimelineMilliseconds(begin,delta,calendar);
   const backward=shiftFixedTimelineMilliseconds(end,-delta,calendar);
   expect(count(begin,forward)).toBe(delta);
   expect(count(backward,end)).toBe(delta);
  }
 }
});
it('does not manufacture deadlines for unknown targets, disconnected work or cyclic routes',()=>{
 expect(()=>fixedTimelineTargets([work('pack',60)],{pack:{precision:'unknown',reason:'TEST missing H'}})).toThrow('终点缺少');
 expect(()=>fixedTimelineTargets([work('pack',60),work('unconnected',60)],{pack:end})).toThrow('缺少交付');
 expect(()=>fixedTimelineTargets([work('a',60,['b']),work('b',60,['a'])],{b:end})).toThrow('成环');
});
it('keeps the stricter date-only boundary when equal consumer instants have different precision',()=>{
 const nodes=[work('shared',0),work('instant',0,['shared']),work('date',0,['shared'])];
 const target=fixedTimelineTargets(nodes,{instant:{...end,value:'2026-11-09T16:00:00.000Z'},date:{precision:'date',value:'2026-11-09',source:'TEST customer date'}})[0]!;
 expect(target.end.exclusive).toBe(true);
 expect(()=>fixedTimelineTargets([work('parent',30),{...work('dispatch',30),includedIn:'parent'},{...work('return',30),includedIn:'parent',includedPosition:'end'}],{parent:end})).toThrow('合计不能超过');
});
it('preserves known independent targets while missing work inputs propagate only to required predecessors',()=>{
 const nodes=[work('shared',60),work('known',60,['shared']),{...work('missing',60,['shared']),minutes:null},work('independent',30)];
 const targets=fixedTimelineTargets(nodes,{known:end,missing:end,independent:end},{preserveUnknown:true});
 expect(targets.find(node=>node.id==='known')!.start.at).toBe('2026-11-09T11:00:00.000Z');
 expect(targets.find(node=>node.id==='missing')).toMatchObject({start:{at:null},end:{at:end.value}});
 expect(targets.find(node=>node.id==='shared')!.start.at).toBeNull();
 expect(targets.find(node=>node.id==='independent')!.start.at).toBe('2026-11-09T11:30:00.000Z');
 const unknown=fixedTimelineTargets([work('packing',60)],{packing:{precision:'unknown',reason:'客户交期待补'}},{preserveUnknown:true});
 expect(unknown[0]).toMatchObject({start:{at:null},end:{at:null,reasons:['客户交期待补']}});
});
it('bounds ship sample by both frozen production start and customer advance without making it a physical gate',()=>{
 const nodes:FixedTimelineInput['work']=[work('production',60),work('packing',30,['production']),work('ship',15)].map(node=>({...node,canonicalWorkRef:node.id,planningParameterRef:'TEST explicit adopted',responsibilitySlaRef:null}));
 const consumer:FixedTimelineConsumer={scopeRef:'TEST PO',lineId:null,nodeIds:nodes.map(node=>node.id),ends:{packing:{precision:'date',value:'2026-11-20',source:'TEST original H'},ship:{precision:'unknown',reason:'calculated soft bound'}},shipSample:{nodeId:'ship',productionNodeId:'production',customerGoalId:'packing',advanceDays:10}};
 const early=fixedConsumerTargets(nodes,consumer);
 expect(early.find(node=>node.id==='ship')!.end).toMatchObject({at:'2026-11-10T16:00:00.000Z',exclusive:true});
 const productionBound=fixedConsumerTargets(nodes,{...consumer,shipSample:{...consumer.shipSample!,advanceDays:0}});
 expect(productionBound.find(node=>node.id==='ship')!.end).toEqual(productionBound.find(node=>node.id==='production')!.start);
 expect(early.find(node=>node.id==='production')).toEqual(productionBound.find(node=>node.id==='production'));
 expect(nodes.find(node=>node.id==='production')!.dependsOn).toEqual([]);
});
