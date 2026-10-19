import {describe,expect,it} from 'vitest';
import {digitalTaskDisplayStatus,digitalTaskObjectLabel} from '../../apps/web/src/digital-workspace-copy.js';
describe('existing task facts in current handling identity',()=>{
 it('shows a resource pause without turning it into a persisted task state',()=>{
  const task={state:'ready' as const,paused:true};expect(digitalTaskDisplayStatus(task)).toBe('已暂停');expect(task.state).toBe('ready');
 });
 it('keeps completed and cancelled history truthful even when the resource is paused',()=>{
  expect(digitalTaskDisplayStatus({state:'completed',paused:true})).toBe('已完成');expect(digitalTaskDisplayStatus({state:'cancelled',paused:true})).toBe('已取消');
 });
 it('keeps original pending,ready,blocked states without claiming a new legal action',()=>{
  expect(digitalTaskDisplayStatus({state:'pending',paused:false})).toBe('等待前置');expect(digitalTaskDisplayStatus({state:'ready',paused:false})).toBe('可办理');expect(digitalTaskDisplayStatus({state:'blocked',paused:false})).toBe('暂时办不了');
 });
 it('does not advertise handling when the original view is explicitly readonly',()=>{expect(digitalTaskDisplayStatus({state:'ready',paused:false},true)).toBe('待办理 · 只读');expect(digitalTaskDisplayStatus({state:'completed',paused:false},true)).toBe('已完成');});
 it('identifies the actual source/order and leaves an unknown association generic',()=>{
  expect(digitalTaskObjectLabel({sourceId:'source',orderId:null})).toBe('开发任务');expect(digitalTaskObjectLabel({sourceId:'source',orderId:'order'})).toBe('大货任务');expect(digitalTaskObjectLabel({sourceId:null,orderId:null})).toBe('数字生产任务');
 });
});
