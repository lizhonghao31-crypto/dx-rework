import {expect,it} from 'vitest';
import {DigitalTaskCompletionSchema} from '@dx-rework/contracts/digital-production-tasks';
import {taskCompletionOccurrence} from '../../apps/api/src/production-platform/task-completion-occurrence.js';
const now='2026-11-10T09:57:06.914Z',at='2026-11-09T09:57:06.850Z';
const task={task_id:'TEST-task',source_id:'TEST-source',route_version:2,task_kind:'development_shipping',state:'completed',completed_at:null as string|null,completed_quality:'缺失'};
const recorded={fact_id:'TEST-fact',payload:{actualCompletedDate:'2026-11-09',timeQuality:'补报未核实'},corrected:false};
it('retains a date without midnight and keeps its trust separate from responsibility quality',()=>{
 const actual=taskCompletionOccurrence(task,now,recorded);expect(actual).toEqual({precision:'date',at:null,date:'2026-11-09',quality:'unverified',sourceRef:'development-route-fact:TEST-fact'});expect(DigitalTaskCompletionSchema.parse(actual)).toEqual(actual);
 expect(taskCompletionOccurrence(task,now,{...recorded,payload:{sentDate:'2026-11-09'}})).toEqual(actual);
});
it('lets the exact native completed correction supersede an older date even when corrected to unknown',()=>{
 expect(taskCompletionOccurrence(task,now,{...recorded,corrected:true})).toMatchObject({precision:'unknown',at:null,date:null,quality:'missing'});
 const actual=taskCompletionOccurrence({...task,completed_at:at,completed_quality:'已核实'},now,{...recorded,corrected:true});
 expect(actual).toMatchObject({precision:'instant',at,date:null,quality:'verified'});expect(DigitalTaskCompletionSchema.parse(actual)).toEqual(actual);
});
it('preserves verified and unverified instants and rejects future or unrecorded evidence',()=>{
 for(const quality of ['现场登记','已核实','补报未核实'])expect(taskCompletionOccurrence({...task,completed_at:at,completed_quality:quality},now)).toMatchObject({precision:'instant',at,quality:quality==='补报未核实'?'unverified':'verified'});
 for(const other of [{...task,completed_at:'2099-01-01T00:00:00Z',completed_quality:'已核实'},{...task,state:'ready',completed_at:at,completed_quality:'已核实'},task])expect(taskCompletionOccurrence(other,now)).toMatchObject({precision:'unknown',at:null,date:null});
 for(const payload of [{note:'done',recordedAt:at},null])expect(taskCompletionOccurrence(task,now,{...recorded,payload})).toMatchObject({precision:'unknown'});
 expect(taskCompletionOccurrence({...task,completed_at:at,completed_quality:'已核实'},now,{...recorded,payload:null})).toMatchObject({precision:'instant',at,quality:'verified'});
});
