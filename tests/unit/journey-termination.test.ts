import {describe,it,expect,vi} from 'vitest';
import {journeyTermination} from '../../apps/api/src/production-platform/journey-termination.js';
import {reuseJourneySnapshotReads} from '../../apps/api/src/production-platform/journey-snapshot-reads.js';
import type {PoolClient} from 'pg';
const order={kind:'order' as const,id:'TEST-order'};
const db=(lifecycle:unknown[],events:unknown[]=[],closures:unknown[]=[])=>({query:vi.fn(async(sql:string)=>({rows:sql.includes('resource_lifecycle')?lifecycle:sql.includes('task_events')?events:closures}))});
describe('original business termination evidence',()=>{
 it('reuses the original lifecycle lookup only inside one read snapshot and sees later cancellation in the next snapshot',async()=>{
  let state='active';const query=vi.fn(async(sql:string)=>({command:'SELECT',rowCount:1,oid:0,fields:[],rows:sql.includes('resource_lifecycle')?[{state}]:[{event_id:'TEST-new-cancel',occurred_at:'2026-11-08T03:04:05.123Z',time_quality:'现场登记'}]}));
  const client={query} as unknown as PoolClient,snapshot=reuseJourneySnapshotReads(client),source={kind:'source' as const,id:'TEST-source'};
  await snapshot.query('SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2',[source.kind,source.id]);
  expect(await journeyTermination(snapshot,source,'2026-11-20T00:00:00Z')).toBeNull();expect(query).toHaveBeenCalledTimes(1);
  state='cancelled';expect(await journeyTermination(reuseJourneySnapshotReads(client),source,'2026-11-20T00:00:00Z')).toMatchObject({kind:'cancelled',at:'2026-11-08T03:04:05.123Z'});
  expect(query).toHaveBeenCalledTimes(3);
 });
 it('uses cancellation occurrence with millisecond precision and keeps the original event reference',async()=>{
  const store=db([{state:'cancelled',changed_at:'2026-11-20T00:00:00Z'}],[{event_id:'TEST-cancel',occurred_at:new Date('2026-11-08T03:04:05.123Z'),time_quality:'现场登记'}]);
  const value=await journeyTermination(store,order,'2026-11-20T00:00:00Z');
  expect(value).toEqual({kind:'cancelled',at:'2026-11-08T03:04:05.123Z',precision:'instant',originEventRef:'digital_production_task_events:TEST-cancel',scopeRef:'order:TEST-order'});
  expect(await journeyTermination(store,order,'2026-12-20T00:00:00Z')).toEqual(value);
 });
 it.each([[],[{event_id:'TEST-unknown',occurred_at:null,time_quality:'缺失'}],[{event_id:'TEST-unverified',occurred_at:'2026-11-08T00:00:00Z',time_quality:'补报未核实'}]])('preserves termination with unknown time instead of using changed_at or observation',async(events)=>{
  const value=await journeyTermination(db([{state:'cancelled',changed_at:'2026-11-08T00:00:00Z'}],events),order,'2026-11-20T00:00:00Z');
  expect(value).toMatchObject({kind:'cancelled',at:null,precision:'unknown'});
 });
 it('does not use a future cancellation as an earlier actual time',async()=>{
  expect(await journeyTermination(db([{state:'cancelled'}],[{event_id:'TEST-future',occurred_at:'2026-11-21T00:00:00Z',time_quality:'现场登记'}]),order,'2026-11-20T00:00:00Z')).toMatchObject({kind:'cancelled',at:null,precision:'unknown'});
 });
 it('uses the original special-closure record without changing it into delivery completion',async()=>{
  const value=await journeyTermination(db([],[],[{closed_at:new Date('2026-11-08T09:00:00.987Z')}]),order,'2026-11-20T00:00:00Z');
  expect(value).toEqual({kind:'special_closure',at:'2026-11-08T09:00:00.987Z',precision:'instant',originEventRef:'digital_order_closures:TEST-order',scopeRef:'order:TEST-order'});
  expect(value).not.toHaveProperty('completedAt');
 });
 it('does not terminate paused or active work and never queries an order closure for a source',async()=>{
  for(const state of ['active','paused'])expect(await journeyTermination(db([{state}]),order,'2026-11-20T00:00:00Z')).toBeNull();
  const source=db([]);expect(await journeyTermination(source,{kind:'source',id:'TEST-source'},'2026-11-20T00:00:00Z')).toBeNull();expect(source.query).toHaveBeenCalledTimes(1);
 });
});
