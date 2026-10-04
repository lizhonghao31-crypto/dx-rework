import {expect,it} from 'vitest';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {taskTimeProgress} from '../../apps/web/src/digital-cockpit-page.js';
it('keeps missing entry unknown even when no SLA is configured',()=>{
 const task={state:'ready',enteredAt:null,dueAt:null,slaHours:null} as DigitalTask;
 expect(taskTimeProgress(task,new Date())).toEqual({label:'时间待确认',percent:null});
 expect(taskTimeProgress({...task,state:'pending'},new Date()).label).toBe('条件未齐，未计时');
});

it('does not emit non-finite or invented progress for invalid duration',()=>{
 const task={state:'ready',enteredAt:'2026-10-04T00:00:00Z',dueAt:'2026-10-04T00:00:00Z',slaHours:0} as DigitalTask;
 expect(taskTimeProgress(task,new Date('2026-10-04T01:00:00Z')).percent).toBeNull();
});
