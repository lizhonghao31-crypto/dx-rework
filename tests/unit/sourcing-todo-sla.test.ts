import {describe,it,expect,vi} from "vitest";
import type {PoolClient} from "pg";
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from "../../packages/contracts/src/digital-sla.js";
import {sourcingTodoSla} from "../../apps/api/src/production-platform/sourcing-todo-sla.js";
const input={category:"sourcing_ie_quote",entityType:"sourcing_case",entityId:"case-fixture",sourceEventId:"event-fixture"};
const fixture=(minutes=120,transition=true,enrolled=true)=>{
 const values=digitalSlaDefaults();for(const key of ['sourcing_ie','sourcing_selection','sourcing_approval'])values[key]={kind:'duration',minutes};
 const frozen=resolveDigitalSlaSnapshot({version:1,values});
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:'digital_sla_order_snapshots'}]:sql.includes('digital_production_child_links')?(enrolled?[{rule_version:frozen.ruleVersion,parameters_json:frozen.parameters,snapshot_id:'snapshot-fixture',production_order_id:'order-fixture'}]:[]):sql.includes('sourcing_case_transitions')?(transition?[{transitioned_at:'2026-10-23T00:00:00Z'}]:[]):[]}));
 return {client:{query} as unknown as Pick<PoolClient,'query'>,query};
};
describe('original sourcing todo frozen SLA adapter',()=>{
 it.each(['sourcing_ie_quote','sourcing_management_decision','sourcing_owner_approval'])('uses the original event plus frozen two-hour standard for %s',async(category)=>{
  const {client,query}=fixture();expect(await sourcingTodoSla(client,{...input,category})).toEqual({dueAt:new Date('2026-10-23T02:00:00Z'),snapshotId:'snapshot-fixture'});
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('operation_event_id=$2'),['case-fixture','event-fixture']);
 });
 it('uses the order snapshot rather than the current global default',async()=>{
  expect((await sourcingTodoSla(fixture(180).client,input))?.dueAt).toEqual(new Date('2026-10-23T03:00:00Z'));
 });
 it('preserves unknown actual start and leaves unenrolled or unrelated todos on their original path',async()=>{
  expect((await sourcingTodoSla(fixture(120,false).client,input))?.dueAt).toBeNull();
  expect(await sourcingTodoSla(fixture(120,true,false).client,input)).toBeUndefined();
  const {client,query}=fixture();expect(await sourcingTodoSla(client,{...input,category:'sourcing_finance_reconcile'})).toBeUndefined();expect(query).not.toHaveBeenCalled();
 });
 it.each([
  {due_at:'2026-10-22T02:00:00Z',snapshot_id:'original-snapshot'},
  {due_at:null,snapshot_id:'original-snapshot'},
  {due_at:'2026-10-22T02:00:00Z',snapshot_id:null},
  {due_at:null,snapshot_id:null},
 ])('retains historical deadline and original or unknown basis: %j',async(previous)=>{
  const base=fixture(180),original=base.query.getMockImplementation()!;
  base.query.mockImplementation(async(sql:string)=>sql.includes('FROM rework_todos')?{rows:[previous]} as never:original(sql));
  expect(await sourcingTodoSla(base.client,input)).toEqual({dueAt:previous.due_at?new Date(previous.due_at):null,snapshotId:previous.snapshot_id});
  expect(base.query).toHaveBeenLastCalledWith(expect.stringContaining('original.production_order_id=$3'),['case-fixture','sourcing_ie_quote','order-fixture']);
  expect(base.query.mock.calls.some(([sql])=>sql.includes('sourcing_case_transitions'))).toBe(false);
 });
});
