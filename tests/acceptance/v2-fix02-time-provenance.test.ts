import {describe,it,expect} from 'vitest';
import {taskAnalysis,type AnalysisTask} from '../../apps/api/src/production-platform/reporting-metrics.js';
describe('FIX-02 trusted time provenance',()=>{
 it('retains trusted live timing when the transaction timestamp precedes the action, and excludes a manual backreport',()=>{
  const task:AnalysisTask={taskId:'TEST',sourceId:'TEST',orderId:null,styleNo:'TEST',customer:'PD',category:'上衣',requiredRole:'pattern_room_worker',assigneeId:'TEST',assigneeName:'TEST',nodeKey:'development_pattern',label:'纸样',round:1,state:'completed',createdAt:'2026-10-06T07:00:00Z',enteredAt:'2026-10-06T07:00:00Z',completedAt:'2026-10-06T07:01:00Z',enteredQuality:'现场登记',completedQuality:'现场登记',dueAt:'2026-10-08T07:00:00Z',policyVersion:1,pendingConditions:[],sourceCreatedAt:'2026-10-06T07:00:00Z',sourcePublished:true,events:[{id:'TEST',kind:'ready',at:'2026-10-06T07:00:00Z',recordedAt:'2026-10-06T06:59:59.957Z',quality:'现场登记',actorId:'TEST',correctsId:null,payload:{}}]};
  expect(taskAnalysis(task,'2026-10-06T07:01:00Z')).toMatchObject({handlingSeconds:60,slaIncluded:true,unverifiedTime:false});
  expect(taskAnalysis({...task,enteredQuality:'补报未核实'},'2026-10-06T07:01:00Z')).toMatchObject({handlingSeconds:null,slaIncluded:false,unverifiedTime:true});
 });
});
