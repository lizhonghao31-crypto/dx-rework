import {afterEach,expect,it,vi} from 'vitest';
import {DevelopmentCustomerSampleSchema,DevelopmentRouteActionSchema} from '@dx-rework/contracts/digital-development-execution';
import {developmentOccurrence,developmentRecordedTime} from '../../apps/api/src/production-platform/development-occurrence.js';
import {developmentTimeFromForm} from '../../apps/web/src/development-occurrence-input.js';
import {journeyActualPoint} from '../../apps/api/src/production-platform/journey-progress-dates.js';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';

const now='2026-11-10T09:57:06.914Z',started='2026-11-09T00:00:00.000Z';
afterEach(()=>vi.useRealTimers());
it('uses the supplied trusted order clock for now, independently of browser or wall time',()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2099-01-01T00:00:00Z');
 const form=new FormData();form.set('actualTimeMode','current');form.set('actualAt','2000-01-01T00:00');
 expect(developmentTimeFromForm(form)).toBeUndefined();
 expect(developmentOccurrence(undefined,new Date(now))).toEqual({actualCompletedAt:now,actualCompletedDate:null,timeQuality:'现场登记'});
});
it('preserves a reported instant and only the precision actually supplied',()=>{
 const form=new FormData();form.set('actualTimeMode','instant');form.set('actualAt','2026-11-09T17:57:06.914');
 const input=developmentTimeFromForm(form);
 expect(input).toEqual({precision:'instant',at:'2026-11-09T09:57:06.914Z'});
 const payload=developmentOccurrence(input,new Date(now),started);
 expect(payload).toEqual({actualCompletedAt:'2026-11-09T09:57:06.914Z',actualCompletedDate:null,timeQuality:'补报未核实'});
 expect(developmentRecordedTime(payload,now)).toEqual({at:'2026-11-09T09:57:06.914Z',date:null,quality:'unverified'});
});
it('keeps date-only, explicitly unknown and historical note-only facts separate',()=>{
 const payload=developmentOccurrence({precision:'date',date:'2026-11-09'},new Date(now),started),actual=developmentRecordedTime(payload,now)!;
 expect(actual).toEqual({at:null,date:'2026-11-09',quality:'unverified'});
 expect(journeyActualPoint({state:'completed',enteredAt:started,actualAt:actual.at,actualDate:actual.date,actualQuality:actual.quality} as JourneyNode,now)).toEqual({at:'2026-11-09',precision:'date',quality:'recorded'});
 const unknown=developmentOccurrence({precision:'unknown'},new Date(now));
 expect(unknown).toEqual({actualCompletedAt:null,actualCompletedDate:null,timeQuality:'缺失'});
 for(const value of [unknown,{note:'已确认',recordedAt:now},{actualCompletedAt:now},null])expect(developmentRecordedTime(value,now)).toBeNull();
});
it('rejects future and before-start occurrences without truncating milliseconds or date boundaries',()=>{
 for(const input of [{precision:'instant',at:'2026-11-10T09:57:06.915Z'},{precision:'instant',at:'2026-11-08T23:59:59.999Z'},{precision:'date',date:'2026-11-11'},{precision:'date',date:'2026-11-08'}] as const)
  expect(()=>developmentOccurrence(input,new Date(now),started)).toThrow('实际发生时间');
 expect(developmentOccurrence({precision:'instant',at:now},new Date(now),started).actualCompletedAt).toBe(now);
 expect(developmentRecordedTime({actualCompletedAt:'2026-11-11T00:00:00Z',timeQuality:'已核实'},now)).toBeNull();
});
it('keeps legacy inputs compatible and does not let the client assert a verification quality',()=>{
 const input={routeVersion:1,note:'TEST customer decision'};
 expect(DevelopmentCustomerSampleSchema.parse(input)).toEqual(input);
 expect(DevelopmentCustomerSampleSchema.safeParse({...input,actualTime:{precision:'date',date:'2026-11-09'}}).success).toBe(true);
 for(const actualTime of [{precision:'date',date:'2026-02-30'},{precision:'instant',at:now,quality:'已核实'},{precision:'unknown',at:now}])expect(DevelopmentCustomerSampleSchema.safeParse({...input,actualTime}).success).toBe(false);
 expect(DevelopmentRouteActionSchema.safeParse({taskId:'00000000-0000-4000-8000-000000000001',note:'',craftExecution:null,result:'通过',nextAssigneeId:null,sentDate:null,trackingNo:null}).success).toBe(true);
});
