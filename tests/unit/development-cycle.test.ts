import {describe,it,expect} from 'vitest';
import {calculateDevelopmentCycle} from '../../packages/domain/src/development-cycle.js';
import {scheduleElapsed} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {shiftFixedTimeline} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
const day=86400000,start='2026-10-23T00:00:00Z';
const at=(days:number)=>new Date(Date.parse(start)+days*day).toISOString();
const cycle=(days:number,extra:Partial<Parameters<typeof calculateDevelopmentCycle>[0]>={})=>calculateDevelopmentCycle({publishedAt:start,completedAt:null,now:at(days),allowedDays:7,warningRatio:.7,intervals:[],...extra});
describe('approved natural development cycle',()=>{
 it('includes weekends and evaluates exact7/5day boundaries from the same publication',()=>{
  expect(cycle(7).state).toBe('warning');expect(cycle(7.00001).state).toBe('overdue');
  expect(cycle(7,{completedAt:at(7)}).onTime).toBe(true);
  expect(cycle(5,{allowedDays:5,completedAt:at(5)}).onTime).toBe(true);
  expect(cycle(6,{allowedDays:5}).state).toBe('overdue');
  expect(cycle(3).internalSeconds).toBe(3*86400); // Friday through Monday is three natural days.
 });
 it('deducts overlapping and duplicate real external intervals only once',()=>{
  const result=cycle(9,{intervals:[{id:'a',departedAt:at(1),returnedAt:at(3),credible:true,closed:true},{id:'b',departedAt:at(2),returnedAt:at(4),credible:true,closed:true},{id:'a-copy',departedAt:at(1),returnedAt:at(3),credible:true,closed:true}]});
  expect(result.excludedSeconds).toBe(3*86400);expect(result.internalSeconds).toBe(6*86400);expect(result.state).toBe('warning');
 });
 it('clips evidence to the actual publication/tail interval and excludes later customer wait',()=>{
  const result=cycle(20,{completedAt:at(7),intervals:[{id:'prior',departedAt:at(-2),returnedAt:at(1),credible:true,closed:true},{id:'later',departedAt:at(8),returnedAt:at(10),credible:true,closed:true}]});
  expect(result.internalSeconds).toBe(6*86400);expect(result.excludedSeconds).toBe(86400);expect(result.onTime).toBe(true);
 });
 it('an ongoing real external interval pauses elapsed internal time without inventing a return',()=>{
  const result=cycle(10,{intervals:[{id:'open',departedAt:at(2),returnedAt:null,credible:true,closed:false}]});
  expect(result.internalSeconds).toBe(2*86400);expect(result.openExternal).toBe(true);expect(result.dueAt).toBeNull();
 });
 it('missing, unverified and closed-without-return evidence limits rating, never claims on-time',()=>{
  for(const interval of [{id:'missing',departedAt:null,returnedAt:null,credible:true,closed:false},{id:'unverified',departedAt:at(1),returnedAt:at(9),credible:false,closed:true},{id:'closed',departedAt:at(1),returnedAt:null,credible:true,closed:true}]){
   const result=cycle(10,{intervals:[interval]});expect(result.state).toBe('unrated');expect(result.onTime).toBeNull();expect(result.precisionReasons.length).toBeGreaterThan(0);
  }
  expect(cycle(10,{completedAt:at(7),intervals:[{id:'not-returned',departedAt:at(1),returnedAt:null,credible:true,closed:false}]}).state).toBe('unrated');
 });
 it('keeps leap-day and explicit+08instants precise and rejects future/negative cycles',()=>{
  const result=calculateDevelopmentCycle({publishedAt:'2028-02-28T08:00:00+08:00',completedAt:'2028-03-01T08:00:00+08:00',now:'2028-03-02T00:00:00Z',allowedDays:7,warningRatio:.7,intervals:[]});
  expect(result.internalSeconds).toBe(2*86400);
  expect(()=>cycle(1,{completedAt:at(2)})).toThrow();expect(()=>cycle(1,{publishedAt:at(2)})).toThrow();
 });
 it('keeps a completed tail with unknown time unrated without inventing an end',()=>{
  const result=calculateDevelopmentCycle({publishedAt:'2026-11-01T00:00:00Z',completedAt:null,internalCompleted:true,now:'2026-11-02T00:00:00Z',allowedDays:7,warningRatio:0.7,intervals:[]});
  expect(result.state).toBe('unrated');expect(result.onTime).toBeNull();expect(result.dueAt).toBeNull();
 });
 it('uses the same confirmed counted calendar while deducting only the counted union of real external intervals',()=>{
  const result=calculateDevelopmentCycle({publishedAt:'2027-01-09T16:00:00Z',completedAt:null,now:'2027-01-11T16:00:00Z',allowedDays:2,warningRatio:.7,intervals:[{id:'TEST real Sunday external interval',departedAt:'2027-01-09T16:00:00Z',returnedAt:'2027-01-10T16:00:00Z',credible:true,closed:true}]},{elapsedSeconds:(from,to)=>scheduleElapsed(from,to,'beijing_sunday_excluded')*60,shiftSeconds:(from,seconds)=>Date.parse(shiftFixedTimeline(new Date(from).toISOString(),seconds/60,'beijing_sunday_excluded'))});
  expect(result.internalSeconds).toBe(86400);expect(result.excludedSeconds).toBe(0);expect(result.dueAt).toBe('2027-01-12T16:00:00.000Z');
  expect(cycle(10,{allowedDays:null})).toMatchObject({state:'unrated',allowedSeconds:null,dueAt:null,onTime:null});
 });
});
