import {describe,it,expect} from 'vitest';
import {addCalendarDays,calendarDaysBetween,seriesCalendarDate} from '../../packages/contracts/src/series-calendar.js';
import {SeriesSourceEventSchema} from '../../packages/contracts/src/digital-series-plan.js';
import {seriesMilestones,retainSeriesTargets,evaluatePlanningDependencies} from '../../packages/domain/src/series-plan.js';
import {minimumInitialCustomerDate} from '../../packages/contracts/src/digital-production.js';

describe('one plan anchor and natural-day AB template',()=>{
 it('reproduces the approved nonleap example and the expected leap-year shift',()=>{
  const dates=(p:string,r:'A'|'B')=>Object.fromEntries(seriesMilestones(p,r).map(m=>[m.key,m.targetDate]));
  expect(dates('2027-03-15','A')).toMatchObject({design_handover:'2026-12-10',material_investment:'2026-12-10',fabric_receipt:'2027-01-20',client_sample_approval:'2027-01-30',color_confirmation:'2027-02-01',accessories_ready:'2027-02-10',style_label_ready:'2027-02-10',processing_dispatch:'2027-02-15'});
  expect(dates('2027-03-15','B')).toMatchObject({design_handover:'2027-01-10',material_investment:'2027-01-10',fabric_receipt:'2027-02-10'});
  expect(dates('2027-03-15','B').color_confirmation).toBeUndefined();
  expect(dates('2028-03-15','A')).toMatchObject({design_handover:'2027-12-11',fabric_receipt:'2028-01-21',client_sample_approval:'2028-01-31',color_confirmation:'2028-02-02',processing_dispatch:'2028-02-16'});
 });
 it('roundtrips every milestone in72series/route combinations with exact natural-day intervals',()=>{
  let checked=0;
  for(const year of [2026,2027,2028])for(let month=1;month<=12;month++)for(const route of ['A','B'] as const){
   const p=seriesCalendarDate(year,month,-2,15);for(const m of seriesMilestones(p,route)){expect(addCalendarDays(m.targetDate!,m.offsetDays)).toBe(p);expect(calendarDaysBetween(m.targetDate!,p)).toBe(m.offsetDays);}
   checked++;
  }expect(checked).toBe(72);
 });
 it('separates calendar-month shift from subtracting days; rejects overflow instead of fixing it silently',()=>{
  expect(seriesCalendarDate(2027,1,-2,15)).toBe('2026-11-15');
  expect(seriesCalendarDate(2027,2,-2,15)).toBe('2026-12-15');
  expect(addCalendarDays('2028-03-28',-28)).toBe('2028-02-29');
  expect(addCalendarDays('2027-03-28',-28)).toBe('2027-02-28');
  for(const d of ['2027-02-29','2028-02-30','2027-13-01','2027-00-10'])expect(()=>addCalendarDays(d,1)).toThrow();
  expect(()=>seriesCalendarDate(2027,4,-2,31)).toThrow('没有所选日号');
  expect(minimumInitialCustomerDate(new Date('2027-01-31T03:00:00Z'))).toBe('2027-03-02');
  expect(minimumInitialCustomerDate(new Date('2028-01-31T03:00:00Z'))).toBe('2028-03-01');
  expect(minimumInitialCustomerDate(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-31');
 });
 it('retains completed/running targets and does not manufacture a historical target for a newly adopted old node',()=>{
  const old=seriesMilestones('2027-03-15','A'),next=seriesMilestones('2027-03-20','A');
  const fact=(key:'fabric_receipt'|'client_sample_approval',completed:boolean)=>({key,scopeRef:'whole',completed,started:true,sourceDomain:'bulk-preparation',sourceRecordId:'11111111-1111-4111-8111-111111111111',sourceVersion:1,occurredAt:null,occurredDate:null,precision:'unknown' as const,reason:'实际日期未知'});
  const facts=[fact('fabric_receipt',true),fact('client_sample_approval',false)];
  const result=retainSeriesTargets(next,old,facts,null,2);
  expect(result.milestones.find(m=>m.key==='fabric_receipt')).toMatchObject({targetDate:'2027-01-20',retainedFromRevision:2});
  expect(result.milestones.find(m=>m.key==='client_sample_approval')!.targetDate).toBe('2027-01-30');
  expect(result.milestones.find(m=>m.key==='processing_dispatch')!.targetDate).toBe('2027-02-20');
  expect(retainSeriesTargets(next,[],facts,null,0).milestones.find(m=>m.key==='fabric_receipt')!.targetDate).toBeNull();
  expect(()=>retainSeriesTargets(next,old,facts,['fabric_receipt:whole'],2)).toThrow('已运行或完成');
 });
 it('does not accept a recorded audit timestamp as a missing actual occurrence',()=>{
  const input={eventId:'11111111-1111-4111-8111-111111111111',orderId:'22222222-2222-4222-8222-222222222222',key:'fabric_receipt',scopeRef:'whole',sourceDomain:'bulk-preparation',sourceRecordId:'33333333-3333-4333-8333-333333333333',sourceVersion:1,precision:'unknown',occurredAt:null,occurredDate:null,supersedesEventId:null,reason:'实际时间尚未核实'};
  expect(SeriesSourceEventSchema.safeParse(input).success).toBe(true);
  expect(SeriesSourceEventSchema.safeParse({...input,recordedAt:'2027-02-10T02:00:00Z'}).success).toBe(false);
  expect(SeriesSourceEventSchema.safeParse({...input,occurredAt:'2027-02-10T02:00:00Z'}).success).toBe(false);
 });
 it('takes max at parallel merges, preserves batch independence and detects the five-day/default-eight-day conflict',()=>{
  const p=evaluatePlanningDependencies([
   {id:'label:b1',label:'款号唛备齐',scopeRef:'b1',anchorDate:'2027-02-10',durationMinutes:0,dependsOn:[],basis:'confirmed'},
   {id:'paper',label:'已安排技术准备',scopeRef:'whole',anchorDate:'2027-02-01',durationMinutes:2880,dependsOn:[],basis:'estimate'},
   {id:'cut:b1',label:'本批开裁',scopeRef:'b1',anchorDate:null,durationMinutes:1440,dependsOn:['label:b1','paper'],basis:'estimate'},
   {id:'craft:b1',label:'本批印花',scopeRef:'b1',anchorDate:null,durationMinutes:5760,dependsOn:['cut:b1'],basis:'estimate'},
   {id:'check:b1',label:'裁后总查',scopeRef:'b1',anchorDate:null,durationMinutes:2880,dependsOn:['craft:b1'],basis:'estimate'},
   {id:'send:b1',label:'本批发加工',scopeRef:'b1',anchorDate:null,durationMinutes:1440,dependsOn:['check:b1'],targetDate:'2027-02-15',basis:'estimate'},
   {id:'b2',label:'另一批独立准备',scopeRef:'b2',anchorDate:'2027-02-01',durationMinutes:1440,dependsOn:[],basis:'confirmed'},
  ]);
  expect(p.find(n=>n.id==='send:b1')).toMatchObject({lateMinutes:4320,basis:'estimate'});
  expect(p.find(n=>n.id==='b2')!.endAt).toBe('2027-02-02T16:00:00.000Z');
  expect(()=>evaluatePlanningDependencies([{id:'x',label:'x',scopeRef:'whole',anchorDate:null,durationMinutes:1,dependsOn:['x'],basis:'estimate'}])).toThrow('循环');
  const unknown=evaluatePlanningDependencies([{id:'x',label:'待定工艺',scopeRef:'whole',anchorDate:null,durationMinutes:null,dependsOn:[],basis:'unknown'}])[0]!;
  expect(unknown.endAt).toBeNull();expect(unknown.basis).toBe('unknown');
 });
});
