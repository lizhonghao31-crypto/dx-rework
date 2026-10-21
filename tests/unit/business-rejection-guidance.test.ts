import {describe,it,expect} from 'vitest';
import {reworkTransitionRejection,workflowStateLabel,workflowStateRejection} from '../../apps/api/src/platform/business-rejection-guidance.js';
import {transitionReworkOrder} from '@dx-rework/domain';
import {SourcingCaseStatusSchema} from '@dx-rework/contracts';
describe('commercial rejection guidance uses existing safe state facts',()=>{
 it('explains a real denied rework transition without changing its guard',()=>{
  try{transitionReworkOrder('completed','draft');throw Error('expected denial');}catch(error){
   const message=reworkTransitionRejection((error as Error).message);expect(message).toContain('订单已完成');expect(message).toContain('草稿');expect(message).toContain('我的待办');expect(message).not.toContain('Cannot transition');
  }
 });
 it('never echoes unknown domain errors, identifiers or amounts',()=>{
  const message=reworkTransitionRejection('internal SQL account PRIVATE-ID amount 93821');expect(message).toContain('未提供');expect(message).not.toMatch(/PRIVATE|93821|SQL/);
  expect(workflowStateLabel('private_state')).toBe('状态待核实');
 });
 it('covers all existing sourcing states and shows current versus expected',()=>{
  for(const state of SourcingCaseStatusSchema.options)expect(workflowStateLabel(state)).not.toBe('状态待核实');
  const text=workflowStateRejection('外发订单','pending_owner_approval',['pending_merchandiser_correction'],'本单报价选厂办理页');
  expect(text).toContain('待老板审批');expect(text).toContain('待跟单修改');expect(text).toContain('本单报价选厂办理页');
 });
 it('keeps deduction follow-up separate from payables approval without exposing money',()=>{
  const text=workflowStateRejection('外部责任台账','pending_payables_confirmation',['deduction_follow_up'],'本单外部责任台账办理页');
  expect(text).toContain('待应付确认');expect(text).toContain('扣款跟进中');expect(text).not.toContain('pending_');
 });
});
