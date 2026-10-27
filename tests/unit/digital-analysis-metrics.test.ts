import {isAnalysisOverdue,workspaceAnalysisRows,analysisWorkspaceOverview} from '../../apps/api/src/production-platform/analysis-workspace-metrics.js';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
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

describe('analysis consumers use each original business observation',()=>{
 for(const offset of [-7,0,7])it(`uses its own ${offset}-day scenario clock for waiting, overdue filters and KPIs while keeping real audit stamps`,()=>{
  const wall=at(12),now=new Date(Date.parse(wall)+offset*86400000).toISOString(),point=(hours:number)=>new Date(Date.parse(now)+hours*3600000).toISOString();
  const original=task({state:'ready',enteredAt:point(-2),completedAt:null,dueAt:point(2),events:[{...event('blocked',0),at:point(-1),recordedAt:wall}],businessTime:{now,scenarioId:'TEST-native-original',revision:1}}),before=structuredClone(original);
  const row=taskAnalysis(original,wall);
  expect(row.waitingSeconds).toBe(3600);expect(row.registrationDelaySeconds).toBeNull();expect(isAnalysisOverdue(row,wall)).toBe(false);expect(original).toEqual(before);
  const overdue=taskAnalysis({...original,taskId:'TEST-late',dueAt:point(-1)},wall);
  const selected=workspaceAnalysisRows([row,overdue],[],DigitalAnalysisFilterSchema.parse({from:'2026-01-01',to:'2027-12-31',scope:'snapshot',metric:'overdue'}),'2026-01-01','2028-01-01',wall);
  expect(selected.map(r=>r.taskId)).toEqual(['TEST-late']);expect(analysisWorkspaceOverview([row,overdue],'2026-01-01','2028-01-01',wall).snapshot.overdue).toBe(1);
 });
 it('retains ordinary real-time registration delay and excludes a future actual completion from precision/on-time denominators',()=>{
  const ordinary=taskAnalysis(task({businessTime:{now:at(12),scenarioId:null,revision:0},events:[{...event('completed',4),recordedAt:at(6)}]}),at(12));expect(ordinary.registrationDelaySeconds).toBe(7200);expect(ordinary.slaIncluded).toBe(true);
  const invalid=taskAnalysis(task({businessTime:{now:at(3),scenarioId:'TEST-scene',revision:1}}),at(12));expect(invalid.slaIncluded).toBe(false);expect(invalid.handlingSeconds).toBeNull();expect(invalid.state).toBe('completed');
 });
 it.each([-1,0,1])('keeps date-target day-end %+i ms independent of a duration start',offset=>{
  const due='2026-10-26T16:00:00.000Z',now=new Date(Date.parse(due)+offset).toISOString();
  const row=taskAnalysis(task({deadlineMode:'date_target',state:'ready',enteredAt:null,completedAt:null,dueAt:due,businessTime:{now,scenarioId:'TEST-scene',revision:1}}),at(12));
  expect(isAnalysisOverdue(row,at(12))).toBe(offset>=0);expect(row.missingTime).toBe(false);expect(row.slaIncluded).toBe(false);expect(row.exclusion).toContain('日期目标');
 });
});
