import {describe,it,expect} from 'vitest';
import {intervalUnionSeconds,taskAnalysis,summarizeAnalysis,type AnalysisTask,type AnalysisEvent} from '../../apps/api/src/production-platform/reporting-metrics.js';
const at=(h:number)=>new Date(Date.UTC(2026,9,4,h)).toISOString();
const event=(kind:string,h:number):AnalysisEvent=>({id:`${kind}-${h}`,kind,at:at(h),recordedAt:at(h),quality:'现场登记',actorId:'worker',correctsId:null,payload:{}});
const task=(extra:Partial<AnalysisTask>={}):AnalysisTask=>({taskId:'t1',sourceId:'s1',orderId:'o1',styleNo:'TEST',customer:'PD',category:'上衣',requiredRole:'pattern_room_worker',assigneeId:'u1',assigneeName:'TEST',nodeKey:'development_sewing',label:'车板',round:1,sourceRound:1,instructionVersion:null,state:'completed',createdAt:at(0),enteredAt:at(0),completedAt:at(4),enteredQuality:'现场登记',completedQuality:'现场登记',dueAt:at(5),policyVersion:1,sourceCreatedAt:at(0),sourcePublished:true,pendingConditions:[],events:[],...extra});
describe('P16 auditable truth set',()=>{
 it('counts independent sources once, separates SLA eligibility and excludes unverified precise durations',()=>{
  const rows=[task(),task({taskId:'t2',dueAt:null}),task({taskId:'t3',completedQuality:'补报未核实'}),task({taskId:'t4',state:'cancelled',completedAt:null}),task({taskId:'t5',sourceId:'s2',completedAt:null,completedQuality:'缺失'})].map(t=>taskAnalysis(t,at(12)));
  expect(summarizeAnalysis(rows,at(0),at(24))).toMatchObject({newStyles:2,tasks:4,cancelled:1,completed:4,slaDenominator:1,onTime:1,measurable:2,missingTime:1,unverifiedTime:1});
  expect(rows[1]).toMatchObject({slaIncluded:false,exclusion:'无 SLA',handlingSeconds:14400});
  expect(rows[2]!.handlingSeconds).toBeNull();expect(rows[4]!.handlingSeconds).toBeNull();
 });
 it('unions parallel waiting per source and carries unknown interval counts',()=>{
  const first=taskAnalysis(task({events:[event('blocked',1),event('unblocked',3)]}),at(12));
  const second=taskAnalysis(task({taskId:'t2',events:[event('blocked',2),event('unblocked',4)]}),at(12));
  expect(summarizeAnalysis([first,second],at(0),at(24)).waitingSeconds).toBe(10800);
  expect(intervalUnionSeconds([[0,1000],[500,2000],[4000,5000]])).toBe(3);
  expect(taskAnalysis(task({state:'pending',enteredAt:null,completedAt:null,pendingConditions:['materials_ready']}),at(12))).toMatchObject({unknownWaiting:1,missingTime:false});
 });
 it('uses verified corrections without discarding original evidence or extending completed waiting with today',()=>{
  const completion=event('completed',4),correction={...event('time_corrected',5),correctsId:completion.id,quality:'已核实'};
  const source=task({completedAt:at(5),completedQuality:'已核实',events:[event('blocked',1),completion,correction]});
  const before=taskAnalysis(source,at(12)),later=taskAnalysis(source,at(23));
  expect(before.waitingSeconds).toBe(14400);expect(later.waitingSeconds).toBe(before.waitingSeconds);expect(before.events).toHaveLength(3);
  expect(summarizeAnalysis([before],at(0),at(24)).correctedTasks).toBe(1);
 });
 it('retains condition-driven waiting as unknown after restoration without double-counting simultaneous prerequisites',()=>{
  const condition=(h:number,key:string,satisfied:boolean):AnalysisEvent=>({...event('condition',h),quality:'补报未核实',payload:{condition:key,satisfied}});
  const events=[condition(-1,'materials_ready',false),event('ready',0),condition(1,'materials_ready',false),condition(2,'handover_received',false),condition(3,'materials_ready',true),condition(3,'handover_received',true),event('unblocked',3),event('completed',4)];
  const row=taskAnalysis(task({events}),at(12));expect(row.waitingSeconds).toBe(0);expect(row.unknownWaiting).toBe(1);expect(row.pendingConditions).toEqual([]);
  expect(taskAnalysis(task({events:[...events.slice(0,-1),condition(3.5,'materials_ready',false),event('completed',4)]}),at(12)).unknownWaiting).toBe(2);
 });
 it('does not turn inverted or invalid times into zero-hour precise work',()=>{
  for(const extra of [{enteredAt:at(5),completedAt:at(4)},{enteredAt:'invalid',completedAt:at(4)},{dueAt:'invalid'}]){
   const row=taskAnalysis(task(extra),at(12));expect(row.slaIncluded).toBe(false);if(extra.enteredAt)expect(row.handlingSeconds).toBeNull();
  }
 });

});
