import {expect,it} from 'vitest';
import {developmentResponsibilityWindow} from '../../apps/api/src/production-platform/development-responsibility-window.js';
const at='2026-11-15T22:53:30.123Z',synthetic='2026-11-15T22:54:18.382Z';
const task={task_id:'own',entered_at:at,entered_quality:'补报未核实'};
it('rejects an old synthetic window but preserves a separately verified original handover',()=>{
 expect(developmentResponsibilityWindow(task,synthetic,{enteredAt:synthetic,basis:['order-time:TEST captured']})).toEqual({at:null,quality:'补报未核实'});
 expect(developmentResponsibilityWindow({...task,entered_quality:'已核实'},at,{enteredAt:at})).toEqual({at,quality:'已核实'});
});
it('validates the captured predecessor instead of treating lack of a separate handover as universally unknown',()=>{
 const proof={task_id:'washing',entered_at:null,completed_at:at,completed_quality:'已核实',state:'completed'};
 expect(developmentResponsibilityWindow(task,at,{basis:['task:washing:completed']},[proof]).at).toBe(at);
 for(const changed of [{...proof,completed_quality:'补报未核实'},{...proof,returned:true},{...proof,rejected:true},{...proof,task_id:'other'},{...proof,completed_at:synthetic}])expect(developmentResponsibilityWindow(task,at,{basis:['task:washing:completed']},[changed]).at).toBeNull();
});
it('keeps explicit corrected unknown and a verified millisecond recovery authoritative over old captured metadata',()=>{
 for(const restored of [null,at])expect(developmentResponsibilityWindow({...task,ready_correction:{at:restored,eventId:'correction'}},synthetic,{enteredAt:synthetic,timeQuality:'现场登记'})).toEqual({at:restored,quality:restored?'已核实':'缺失'});
 expect(developmentResponsibilityWindow({...task,entered_quality:'已核实'},synthetic,{enteredAt:null})).toEqual({at:null,quality:'缺失'});
});
it('retains the independently captured organizational start while activation/handover still waits',()=>{
 const pending={...task,entered_at:null,entered_quality:'缺失',native_readiness:{eventId:'own captured event',reference:'readiness:own captured event',at,quality:'现场登记'}};
 expect(developmentResponsibilityWindow(pending,at,{enteredAt:at,basis:['readiness:own captured event']})).toEqual({at,quality:'现场登记'});
 expect(developmentResponsibilityWindow({...pending,native_readiness:{...pending.native_readiness,quality:'补报未核实'}},at,{enteredAt:at,basis:['readiness:own captured event']}).at).toBeNull();
 expect(developmentResponsibilityWindow(pending,at,{enteredAt:at,basis:['readiness:other event']}).at).toBeNull();
 expect(developmentResponsibilityWindow({...pending,native_readiness:{...pending.native_readiness,reference:'craft-step:own'}},at,{enteredAt:at,basis:['craft-step:own']}).at).toBe(at);
 expect(developmentResponsibilityWindow({...pending,native_readiness:{...pending.native_readiness,reference:'craft-step:other'}},at,{enteredAt:at,basis:['craft-step:own']}).at).toBeNull();
});
