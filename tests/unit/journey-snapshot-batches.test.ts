import type {PoolClient} from 'pg';
import {describe,it,expect,vi} from 'vitest';
import {reuseJourneySnapshotReads,prepareJourneySnapshotBatches} from '../../apps/api/src/production-platform/journey-snapshot-reads.js';
const ids=Array.from({length:70},(_,i)=>'11111111-1111-4111-8111-'+String(i).padStart(12,'0')),sql='SELECT * FROM digital_production_orders WHERE production_order_id=$1';
const result=(rows:unknown[])=>({command:'SELECT',rowCount:rows.length,oid:0,fields:[{name:'production_order_id'},{name:'created_at'},{name:'nested'}],rows});
const fixture=()=>{let changed=false;const query=vi.fn(async(text:string,values:unknown[]=[])=>{
 if(text==='SET ROLE changed'){changed=true;return result([]);}
 if(text.startsWith('SELECT requested.ordinal'))return {...result((values[0] as string[]).filter(id=>id!==ids[1]).map((id,index)=>({__dx_journey_batch_index:(values[0] as string[]).indexOf(id)+1,__dx_journey_row_index:index+1,production_order_id:id,created_at:new Date('2026-11-06T00:00:00Z'),nested:{changed}}))),fields:[{name:'__dx_journey_batch_index'},{name:'production_order_id'},{name:'created_at'},{name:'nested'},{name:'__dx_journey_row_index'}]};
 return result([{production_order_id:values[0],created_at:new Date('2026-11-06T00:00:00Z'),nested:{changed}}]);
 });const client={query} as unknown as PoolClient,db=reuseJourneySnapshotReads(client);prepareJourneySnapshotBatches(db,ids);return {query,client,db};};
describe('Journey original per-order reads use bounded same-snapshot batches',()=>{
 it('invalidates both caches when the native driver throws synchronously before returning a query promise',async()=>{
  const {query,db}=fixture();await db.query(sql,[ids[0]]);query.mockImplementationOnce(()=>{throw Error('TEST synchronous native query failure');});expect(()=>db.query(sql,[ids[32]])).toThrow('synchronous native query failure');await db.query(sql,[ids[0]]);expect(query.mock.calls.at(-1)![0]).toBe(sql);
 });
 it('preserves original query issue order when a later session-context change is queued without awaiting the first read',async()=>{
  const {query,db}=fixture(),pending=db.query(sql,[ids[0]]),changed=db.query('SET ROLE changed');expect(query.mock.calls[0]![0]).toMatch(/^SELECT requested.ordinal/);expect(query.mock.calls[1]![0]).toBe('SET ROLE changed');await changed;expect((await pending).rows[0].nested.changed).toBe(false);expect((await db.query(sql,[ids[2]])).rows[0].nested.changed).toBe(true);expect(query.mock.calls.at(-1)![0]).toBe(sql);
 });
 it('does not retain an oversized grouped result and returns every original object without truncating business rows',async()=>{
  const payload='x'.repeat(140000),query=vi.fn(async(text:string,values:unknown[]=[])=>text.startsWith('SELECT requested.ordinal')?{...result((values[0] as string[]).map((id,index)=>({__dx_journey_batch_index:index+1,__dx_journey_row_index:1,production_order_id:id,payload}))),fields:[{name:'__dx_journey_batch_index'},{name:'__dx_journey_row_index'},{name:'production_order_id'},{name:'payload'}]}:result([{production_order_id:values[0],payload}]));const db=reuseJourneySnapshotReads({query} as unknown as PoolClient);prepareJourneySnapshotBatches(db,ids);
  const first=await db.query(sql,[ids[0]]);expect(first.rows[0].payload.length).toBe(140000);expect(query).toHaveBeenCalledTimes(1);const second=await db.query(sql,[ids[1]]);expect(second.rows[0].production_order_id).toBe(ids[1]);expect(second.rows[0].payload).toBe(payload);expect(query.mock.calls.at(-1)![0]).toBe(sql);expect(query).toHaveBeenCalledTimes(2);
 });
 it('evicts the oldest grouped snapshot after128 groups without returning sibling facts',async()=>{
  const {query,db}=fixture(),scope=Array.from({length:5000},(_,i)=>'33333333-3333-4333-8333-'+String(i).padStart(12,'0'));prepareJourneySnapshotBatches(db,scope);
  for(let group=0;group<129;group++)await db.query(sql,[scope[group*32]]);expect(query).toHaveBeenCalledTimes(129);const value=await db.query(sql,[scope[1]]);expect(value.rows[0].production_order_id).toBe(scope[1]);expect(query).toHaveBeenCalledTimes(130);expect(query.mock.calls.at(-1)![1]![0]).toEqual(scope.slice(0,32));
 });
 it('preserves Dates, independent row copies, empty objects and public pg metadata with no rows from sibling scopes',async()=>{
  const {query,db}=fixture(),a=await db.query(sql,[ids[0]]);expect(a.rows).toHaveLength(1);expect(a.rows[0].production_order_id).toBe(ids[0]);expect(a.rows[0].created_at).toBeInstanceOf(Date);expect(a.fields.map(f=>f.name)).toEqual(['production_order_id','created_at','nested']);expect(a.rowCount).toBe(1);a.rows[0].nested.changed='local mutation';
  expect((await db.query(sql,[ids[1]])).rows).toEqual([]);expect((await db.query(sql,[ids[2]])).rows[0].production_order_id).toBe(ids[2]);expect((await db.query(sql,[ids[0]])).rows[0].nested.changed).toBe(false);expect(query).toHaveBeenCalledTimes(1);
 });
 it('loads at most32 original IDs per batch and passes unknown shapes or unauthorized IDs directly to pg',async()=>{
  const {query,db}=fixture();for(const index of [0,31,32,63,64,69])await db.query(sql,[ids[index]]);expect(query).toHaveBeenCalledTimes(3);expect(query.mock.calls.map(call=>(call[1]![0] as string[]).length)).toEqual([32,32,6]);
  await db.query(sql,['22222222-2222-4222-8222-222222222222']);await db.query('SELECT other FROM digital_production_orders WHERE production_order_id=$1',[ids[0]]);expect(query.mock.calls.at(-2)![0]).toBe(sql);expect(query.mock.calls.at(-1)![0]).toBe('SELECT other FROM digital_production_orders WHERE production_order_id=$1');
 });
 it('does not carry scopes or cached facts into another request and disables batches after a session-context change',async()=>{
  const {query,db,client}=fixture();await db.query(sql,[ids[0]]);await db.query('SET ROLE changed');expect((await db.query(sql,[ids[2]])).rows[0].nested.changed).toBe(true);expect(query.mock.calls.at(-1)![0]).toBe(sql);await reuseJourneySnapshotReads(client).query(sql,[ids[3]]);expect(query.mock.calls.at(-1)![0]).toBe(sql);
 });
 it('propagates a failed batch and lets no prior hit hide an aborted transaction',async()=>{
  const {query,db}=fixture();await db.query(sql,[ids[0]]);query.mockRejectedValueOnce(Error('TEST native transaction aborted'));await expect(db.query(sql,[ids[32]])).rejects.toThrow('native transaction aborted');await db.query(sql,[ids[0]]);expect(query.mock.calls.at(-1)![0]).toBe(sql);
 });
 it('keeps unusual native Buffer values on the original driver path rather than changing their type through structuredClone',async()=>{
  const query=vi.fn(async(text:string,values:unknown[]=[])=>text.startsWith('SELECT requested.ordinal')?result([{__dx_journey_batch_index:1,__dx_journey_row_index:1,payload:Buffer.from('TEST')}]) :result([{payload:Buffer.from('TEST'),id:values[0]}]));const db=reuseJourneySnapshotReads({query} as unknown as PoolClient);prepareJourneySnapshotBatches(db,[ids[0]!]);const value=await db.query(sql,[ids[0]]);expect(Buffer.isBuffer(value.rows[0].payload)).toBe(true);expect(query).toHaveBeenCalledTimes(2);expect(query.mock.calls[1]![0]).toBe(sql);
 });
 it('falls back if an original result gains a column that collides with a private grouping marker',async()=>{
  const query=vi.fn(async(text:string)=>text.startsWith('SELECT requested.ordinal')?{...result([{__dx_journey_batch_index:'TEST original overwritten marker',__dx_journey_row_index:1}]),fields:[{name:'__dx_journey_batch_index'},{name:'__dx_journey_batch_index'},{name:'__dx_journey_row_index'}]}:result([{__dx_journey_batch_index:'TEST original business field'}]));const db=reuseJourneySnapshotReads({query} as unknown as PoolClient);prepareJourneySnapshotBatches(db,[ids[0]!]);expect((await db.query(sql,[ids[0]])).rows[0].__dx_journey_batch_index).toBe('TEST original business field');expect(query).toHaveBeenCalledTimes(2);
 });

 it('keeps original native custom BigInt values when encoded cache sizing is unsupported',async()=>{
  const query=vi.fn(async(text:string)=>text.startsWith('SELECT requested.ordinal')?{...result([{__dx_journey_batch_index:1,__dx_journey_row_index:1,quantity:1n}]),fields:[{name:'__dx_journey_batch_index'},{name:'quantity'},{name:'__dx_journey_row_index'}]}:result([{quantity:1n}]));const db=reuseJourneySnapshotReads({query} as unknown as PoolClient);prepareJourneySnapshotBatches(db,[ids[0]!]);expect((await db.query(sql,[ids[0]])).rows[0].quantity).toBe(1n);expect(query).toHaveBeenCalledTimes(2);
 });

});
