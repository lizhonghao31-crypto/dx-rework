import {expect,it} from 'vitest';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {taskTimeProgress} from '../../apps/web/src/digital-cockpit-page.js';
it('keeps missing entry unknown even when no SLA is configured',()=>{
 const task={state:'ready',enteredAt:null,dueAt:null,slaHours:null} as DigitalTask;
 expect(taskTimeProgress(task,new Date())).toEqual({label:'时间待确认',percent:null});
 expect(taskTimeProgress({...task,state:'pending'},new Date()).label).toBe('条件未齐，未计时');
});
