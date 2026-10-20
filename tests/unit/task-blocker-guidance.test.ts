import {describe,it,expect} from 'vitest';
import type {Pool} from 'pg';
import {digitalConditionGuidance} from '@dx-rework/contracts/digital-production-tasks';
import {developmentTaskBlockers} from '../../apps/api/src/production-platform/development-task-blockers.js';
import {DIGITAL_CONDITION_KEYS} from '../../apps/api/src/production-platform/task-service.js';
const task={task_id:'TEST-task',source_id:null,route_version:1,task_kind:'bulk_cutting',state:'pending',assignee_id:null,required_role:'cutting_worker'};
function database(conditions:string[],predecessors:unknown[]=[]){return {query:async(sql:string)=>({rowCount:1,rows:sql.includes('to_regclass')?[]:sql.includes('task_conditions')?conditions.map(condition_key=>({condition_key})):sql.includes('task_dependencies')?predecessors:[{}]})} as unknown as Pick<Pool,'query'>;}
describe('existing task blockers explain the next authorized workflow',()=>{
 it('keeps every simultaneous blocker and gives an existing responsible role and entry',async()=>{
  const blocks=await developmentTaskBlockers(database(['owner_approved','pattern_ready','preshrink_ready'],[{label:'大货纸样',state:'pending',required_role:'pattern_room_worker'}]),task,false);
  expect(blocks.map(row=>row.condition)).toEqual(['assignee','owner_approved','pattern_ready','preshrink_ready','predecessor']);
  expect(blocks.every(row=>row.missing&&row.responsibleRole&&row.action)).toBe(true);
  expect(blocks.find(row=>row.condition==='owner_approved')).toMatchObject({responsibleRole:'owner_group'});
  expect(blocks.at(-1)?.action).toContain('我的待办');
 });
 it('does not invent causes for unknown conditions or expose internal keys',async()=>{
  const key='private_internal_condition_123';
  const blocks=await developmentTaskBlockers(database([key]),{...task,assignee_id:'TEST-person'},false);
  expect(blocks[0]?.missing).toContain('尚未提供');expect(blocks[0]?.action).toContain('任务链接');
  expect(JSON.stringify({...blocks[0],condition:undefined})).not.toContain(key);
 });
 it('reports cancelled predecessors without claiming they can be completed',async()=>{
  const blocks=await developmentTaskBlockers(database([],[{label:'预缩',state:'cancelled',required_role:'warehouse_receiver'}]),{...task,assignee_id:'TEST-person'},false);
  expect(blocks[0]?.missing).toContain('已取消');expect(blocks[0]?.action).toContain('核对当前轮次');
  expect(await developmentTaskBlockers(database(['owner_approved']),{...task,state:'completed'},false)).toEqual([]);
 });
 it('covers every existing condition and keeps normal first-round arrangement separate from rework pricing',()=>{
  for(const key of DIGITAL_CONDITION_KEYS)expect(digitalConditionGuidance(key,'pattern_room_worker').name).not.toBe('条件待核实');
  expect(digitalConditionGuidance('washing_finished','pattern_room_tail_inspector').responsibleRole).toBe('development_clerk');
  expect(digitalConditionGuidance('qc_approved','warehouse_receiver').responsibleRole).toBe('quality_control');
  expect(digitalConditionGuidance('pattern_assignment_ready','pattern_room_worker').action).toContain('正常首轮');
  expect(digitalConditionGuidance('pattern_assignment_ready','pattern_room_worker').action).toContain('返工金额');
 });
});
