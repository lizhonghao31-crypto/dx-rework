import {expect,it} from 'vitest';
import type {PoolClient} from 'pg';
import {slaNotificationDue,slaNotificationPreferences,type NotificationTask} from '../../apps/api/src/production-platform/sla-notification-preferences.js';

const order='00000000-0000-4000-8000-000000000001',source='00000000-0000-4000-8000-000000000002',snapshot='00000000-0000-4000-8000-000000000003';
const task=(patch:Partial<NotificationTask>={}):NotificationTask=>({task_id:'TEST-task',production_order_id:order,source_id:source,task_kind:'bulk_ship_sample',due_at:'2026-11-10T16:00:00Z',...patch});
it('selects only an enabled unsent PO notification date without changing the original whole-task deadline',()=>{
 const value=task({sla_basis:{targets:[{sent:false,dueAt:'2026-11-10T16:00:00Z',notificationEnabled:false},{sent:false,dueAt:'2026-11-12T16:00:00Z',notificationEnabled:true}]}}),before=structuredClone(value);
 expect(slaNotificationDue(value,{warning:true,shipSample:true})).toBe('2026-11-12T16:00:00Z');expect(value).toEqual(before);
});
it('retains legacy notifications while an explicitly muted sample has no notification date',()=>{expect(slaNotificationDue(task())).toBe(task().due_at);expect(slaNotificationDue(task(),{warning:true,shipSample:false})).toBeNull();});
it('does not notify completed, invalid or unknown sample targets and permits a separately enabled sibling',()=>{
 const value=task({sla_basis:{targets:[null,{sent:true,dueAt:'2026-11-10T16:00:00Z',notificationEnabled:true},{sent:false,dueAt:null},{sent:false,dueAt:'invalid'},{sent:false,dueAt:'2026-11-12T16:00:00Z',notificationEnabled:true}]}});expect(slaNotificationDue(value,{warning:true,shipSample:false})).toBe('2026-11-12T16:00:00Z');
});
it('never applies a foreign-order adopted snapshot and batches shared source reads once',async()=>{
 const queries:Array<{sql:string;values:unknown}>=[],db={query:async(sql:string,values:unknown)=>{queries.push({sql,values});return {rows:sql.includes('to_regclass')?[{snapshots:'present',sources:'present'}]:sql.includes('FROM digital_sla_order_snapshots')?[{snapshot_id:'original',production_order_id:order,source_id:source,revision:1,parameters_json:{warning_ratio:{value:{notificationEnabled:true}}}},{snapshot_id:snapshot,production_order_id:'00000000-0000-4000-8000-000000000099',source_id:'foreign',revision:2,parameters_json:{warning_ratio:{value:{notificationEnabled:false}}}}]:[{source_id:source,parameters_json:{}}]};}} as unknown as Pick<PoolClient,'query'>;
 const tasks=Array.from({length:20},(_,index)=>task({task_id:'TEST-'+index,sla_basis:{snapshotId:snapshot}})),result=await slaNotificationPreferences(db,tasks);expect(result.size).toBe(20);expect([...result.values()].every(value=>value.warning)).toBe(true);expect(queries).toHaveLength(3);expect(queries[1]!.values).toEqual([[order],[snapshot]]);
});
it('falls back to original enabled semantics on old schemas without querying nonexistent snapshots',async()=>{
 let calls=0;const db={query:async()=>{calls++;return {rows:[{snapshots:null,sources:null}]};}} as unknown as Pick<PoolClient,'query'>;expect((await slaNotificationPreferences(db,[task()])).get('TEST-task')).toEqual({warning:true,shipSample:true});expect(calls).toBe(1);
});
