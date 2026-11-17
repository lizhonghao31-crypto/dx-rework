import {expect,it} from 'vitest';
import {developmentCapturedWindow} from '../../apps/api/src/production-platform/development-captured-window.js';
const start='2026-11-21T04:00:00.000Z',due='2026-11-25T04:00:00.000Z',warning='2026-11-24T06:24:00.000Z';
it('retains current native D and warning independently from the legacy completed revision and current company values',()=>{
 const row={entered_at:'2026-11-20T00:00:00Z',due_at:'2026-11-24T00:00:00Z',sla_basis:{seconds:3600},instance_entered_at:start,instance_due_at:due,instance_warning_at:warning,instance_sla_basis:{seconds:259200,calendarRef:'beijing_sunday_excluded',warningRatio:0.7}};
 expect(developmentCapturedWindow(row,start,'task:TEST-pattern:round:2')).toEqual({startedAt:start,deadline:{at:due,exclusive:false,reasons:[]},warningAt:warning,calendar:'beijing_sunday_excluded',sourceRef:'task:TEST-pattern:round:2'});
 expect(developmentCapturedWindow(row,null,'task:TEST-pattern')).toBeUndefined();
 expect(developmentCapturedWindow({...row,instance_due_at:null,instance_warning_at:null},start,'task:TEST-pattern')).toMatchObject({deadline:{at:null},warningAt:null});
});
it('preserves missing historical calendar and an explicit strict boundary without guessing a company rule',()=>{
 const row={entered_at:start,due_at:due,warning_at:null,sla_basis:{seconds:259200,exclusive:true}};
 expect(developmentCapturedWindow(row,start,'task:TEST historical')).toMatchObject({calendar:null,deadline:{at:due,exclusive:true},warningAt:null});
});
