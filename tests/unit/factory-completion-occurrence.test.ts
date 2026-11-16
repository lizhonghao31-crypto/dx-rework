import {expect,it} from 'vitest';
import {factoryCompletionOccurrence} from '../../apps/api/src/production-platform/factory-completion-occurrence.js';
const at='2026-11-15T19:39:00.123Z';
const task={task_id:'TEST-task',task_kind:'warehouse_dispatch',route_instance_id:'TEST-prep',completed_at:'2026-11-15T19:41:46.479Z'};
const factory={preparationId:'TEST-prep',craftKey:null,facts:{warehouse_dispatch:{businessCompleted:true,batchCoverageComplete:true}},windows:[{kind:'warehouse_dispatch',stepRef:null,lineIds:['TEST-po1'],complete:true,completedAt:'2026-11-15T18:00:00.000Z'},{kind:'warehouse_dispatch',stepRef:null,lineIds:['TEST-po2'],complete:true,completedAt:at}]};
it('uses the last real complete dispatch in its original scope, never a generic administration timestamp',()=>{
 const before=structuredClone(factory);
 expect(factoryCompletionOccurrence(task,factory)).toEqual({kind:'known',at});
 expect(factory).toEqual(before);
});
it('cannot complete a physical scope with missing quantity, missing actual time or a different route',()=>{
 for(const change of [{...factory,facts:{warehouse_dispatch:{businessCompleted:false,batchCoverageComplete:false}}},{...factory,windows:factory.windows.map((w,i)=>i?{...w,completedAt:null}:w)},{...factory,windows:[]}])expect(factoryCompletionOccurrence(task,change)).toEqual({kind:'unknown'});
 expect(factoryCompletionOccurrence({...task,route_instance_id:'TEST-other'},factory)).toEqual({kind:'not_applicable'});
});
