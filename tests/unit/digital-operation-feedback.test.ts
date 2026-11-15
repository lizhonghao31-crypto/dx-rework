import {describe,expect,it} from 'vitest';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {developmentActionReceipt,instructionActionReceipt,taskAuxiliaryReceipt,taskWorkbenchFeedback} from '../../apps/web/src/digital-operation-feedback.js';
const task=(patch:Partial<DigitalTask>={})=>({taskId:'paper',label:'纸样',routeVersion:2,state:'ready',canExecute:true,assigneeName:'TEST 师傅',...patch} as DigitalTask);
describe('write receipts follow persisted facts',()=>{
 it('restores completion after reopening without an in-memory success receipt',()=>expect(taskWorkbenchFeedback(task({state:'completed'}),{busy:false,dirty:false,notice:'',pendingFiles:false})).toContain('本任务已完成'));
 it('retains an unready attachment after another result commits without claiming that failed file was uploaded',()=>{
  expect(taskWorkbenchFeedback(task({state:'completed'}),{busy:false,dirty:false,notice:'已保存',pendingFiles:true,unreadyFiles:true})).toBe('仍有附件尚未就绪，请核对上传状态');
 });
 it('gives new edits and uploaded pending references priority over an older success receipt',()=>{
  expect(taskWorkbenchFeedback(task(),{busy:false,dirty:true,notice:'已保存',pendingFiles:false})).toContain('尚未提交');
  expect(taskWorkbenchFeedback(task(),{busy:false,dirty:true,notice:'已完成',pendingFiles:true})).toBe('附件已上传，尚未随本次办理提交');
 });
 it('does not claim completion from a successful write without a returned completed task',()=>{
  expect(developmentActionReceipt('complete',{},task(),[task()])).not.toContain('已完成');
  expect(developmentActionReceipt('complete',{},task(),[task({state:'completed'})])).toContain('纸样已完成');
 });
 it('does not describe other rounds or non-executable ready tasks as current work',()=>{
  const text=developmentActionReceipt('complete',{},task(),[task({state:'completed'}),task({taskId:'old',label:'旧轮裁板',routeVersion:1}),task({taskId:'other',label:'他人办理',canExecute:false})]);
  expect(text).not.toContain('旧轮裁板');expect(text).not.toContain('他人办理');expect(text).toContain('没有其他可见');
 });
 it('does not infer a new clock from pending state or turn a return into successful production',()=>{
  expect(developmentActionReceipt('route',{},task(),[task({taskId:'next',state:'pending',enteredAt:'2026-10-17T00:00:00Z'})])).toContain('等待前置或岗位安排');
  expect(developmentActionReceipt('route',{result:'退回'},task(),[task({state:'completed'})])).toBe('纸样退回已记录。');
 });
 it('keeps material reports, supply, customer confirmation and preassignment separate from task completion',()=>{
  for(const path of ['dispatch','fabric-reports','fabric-decisions','resubmit','customer-sample','supplement-check','send-washing','pattern-order'])expect(developmentActionReceipt(path,{},task(),[task({state:'completed'})])).not.toContain('已完成');
  expect(taskAuxiliaryReceipt('handover')).toBe('实际接收已登记');
  expect(taskAuxiliaryReceipt('feedback',{blocked:true})).toBe('问题已记录');
  expect(taskAuxiliaryReceipt('feedback',{blocked:false})).toBe('恢复办理已提交');
 });
 it('keeps instruction draft persistence, publication and source adoption separate',()=>{
  expect(instructionActionReceipt('','PUT',{version:3,publishedVersion:2})).toContain('当前草稿尚未发布');
  expect(instructionActionReceipt('/publish','POST',{version:3,publishedVersion:3})).toBe('有效制单版本 3 已发布。');
  expect(instructionActionReceipt('/publish','POST',{version:3,publishedVersion:null})).not.toContain('已发布');
  expect(instructionActionReceipt('/publish','POST',{version:3,publishedVersion:2})).not.toContain('已发布');
  expect(instructionActionReceipt('/source-review','POST',{version:3,publishedVersion:2})).toContain('已核对并保存');
 });
});
