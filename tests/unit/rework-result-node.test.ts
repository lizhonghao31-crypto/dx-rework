import {describe,it,expect} from 'vitest';
import {reworkResultNode} from '../../apps/web/src/rework-result-node.js';
import {publishReworkNodeRefresh} from '../../apps/web/src/rework-initiation-access.js';
describe('legal result destination',()=>{
 it('finishing completion selects IE result before publishing and migrates old settlement links',()=>{
  let selected='work_reporting';const value={status:'completed',reworkKind:'inhouse_finishing'};
  const target=reworkResultNode(value.status,value.reworkKind,'settlement_followup');
  publishReworkNodeRefresh(value,target,n=>{selected=n;},()=>expect(selected).toBe('final_quantity_ie_review'));
  expect(reworkResultNode(value.status,value.reworkKind,undefined)).toBe('final_quantity_ie_review');
  expect(reworkResultNode(value.status,value.reworkKind,'whole_order_review')).toBe('whole_order_review');
 });
 it('QC responsibility settlement and unfinished requests preserve their original node',()=>{
  expect(reworkResultNode('completed','qc_rework','settlement_followup')).toBe('settlement_followup');
  expect(reworkResultNode('pending_final_quantity_ie_review','inhouse_finishing','final_quantity_ie_review')).toBe('final_quantity_ie_review');
 });
});
