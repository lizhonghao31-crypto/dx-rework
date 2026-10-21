import {describe,it,expect} from 'vitest';
import {SampleBorrowRequestSchema,SampleReturnBatchSchema,SampleDisposalRequestSchema} from '@dx-rework/contracts';
import {sampleInput,sampleWorkflowStateLabel} from '../../apps/api/src/samples/sample-workflow-service.js';
describe('sample input guidance describes fields without echoing values',()=>{
 it('reports missing borrower form fields together',()=>{
  expect(()=>sampleInput(SampleBorrowRequestSchema,{version:0,purpose:''})).toThrow(/页面版本.*借用用途/);
 });
 it('identifies a failed nested return field without exposing identifiers',()=>{
  expect(()=>sampleInput(SampleReturnBatchSchema,{items:[{version:1,sampleId:'private-invalid-id',photoAttachmentIds:[]}]})).toThrow(/归还照片.*样衣记录/);
  try{sampleInput(SampleReturnBatchSchema,{items:[{version:1,sampleId:'private-invalid-id',photoAttachmentIds:[]}]});}catch(error){expect(String(error)).not.toContain('private-invalid-id');}
 });
 it('does not echo invalid financial or recipient values',()=>{
  try{sampleInput(SampleDisposalRequestSchema,{version:1,type:'sale',recipient:'',amount:'secret-invalid-amount',proofAttachmentIds:[]});throw Error('expected rejection');}catch(error){expect(String(error)).toMatch(/接收方.*申请金额.*证明附件/);expect(String(error)).not.toContain('secret-invalid-amount');}
 });
 it('keeps unfamiliar states unknown instead of inferring stock or loss',()=>{
  expect(sampleWorkflowStateLabel('borrow_pending')).toBe('借出待确认');
  expect(sampleWorkflowStateLabel('private-new-state')).toBe('状态待核对');
 });
});
