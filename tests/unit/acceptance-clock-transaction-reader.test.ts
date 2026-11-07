import {describe,it,expect} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {acceptanceIncludesNative,ContextBusinessClock,installAcceptanceClockReader,withAcceptanceBusinessTime} from '../../apps/api/src/acceptance-clock/business-time.js';
describe('original scene isolation with an owned read transaction',()=>{
 it('forwards the owned connection without weakening ordinary or cross-scene isolation',async()=>{
  const pool={} as Pool,transaction={} as PoolClient,seen:Array<PoolClient|undefined>=[];
  installAcceptanceClockReader(pool,{read:async()=>null,nativeScenario:async(id,connection)=>{seen.push(connection);return id==='ordinary'?null:'TEST scene';}});
  expect(await acceptanceIncludesNative(pool,'ordinary',transaction)).toBe(true);
  expect(await acceptanceIncludesNative(pool,'scoped',transaction)).toBe(false);
  const context={time:{now:'2026-11-01T00:00:00Z',scenarioId:'TEST scene',revision:1},configurationId:'TEST configuration',scenarioId:'TEST scene',assertScope:async()=>{},acceptsActor:async()=>true,registerCreated:async()=>{}};
  expect(await withAcceptanceBusinessTime(context,()=>acceptanceIncludesNative(pool,'scoped',transaction))).toBe(true);
  expect(await withAcceptanceBusinessTime({...context,scenarioId:'TEST other'},()=>acceptanceIncludesNative(pool,'scoped',transaction))).toBe(false);
  expect(seen).toEqual([transaction,transaction,transaction,transaction]);
 });
 it('uses the supplied snapshot only when the installed reader has no scoped time',async()=>{
  const pool={} as Pool,transaction={} as PoolClient,seen:Array<PoolClient|undefined>=[],at='2026-10-01T12:00:00.000Z';
  installAcceptanceClockReader(pool,{read:async(_scope,connection)=>{seen.push(connection);return null;},nativeScenario:async()=>null});
  const result=await new ContextBusinessClock(pool,transaction).read({kind:'order',id:'TEST ordinary'},()=>new Date(at));
  expect(result).toEqual({now:at,scenarioId:null,revision:0});expect(seen).toEqual([transaction]);
  expect(await new ContextBusinessClock().read({kind:'source',id:'TEST ordinary'},()=>new Date(at))).toEqual(result);
 });
 it('keeps an explicit trusted reader time even without a scenario ID and never uses its fallback',async()=>{
  const pool={} as Pool,time={now:'2026-12-01T12:00:00.000Z',scenarioId:null,revision:0};
  installAcceptanceClockReader(pool,{read:async()=>time,nativeScenario:async()=>null});
  expect(await new ContextBusinessClock(pool).read({kind:'order',id:'TEST trusted'},()=>{throw Error('fallback must not run');})).toEqual(time);
 });
 it('keeps guarded context scope validation ahead of any snapshot fallback',async()=>{
  const context={time:{now:'2026-11-01T00:00:00Z',scenarioId:'TEST scene',revision:1},configurationId:'TEST configuration',scenarioId:'TEST scene',assertScope:async()=>{throw Error('TEST scope rejected');},acceptsActor:async()=>true,registerCreated:async()=>{}};
  await expect(withAcceptanceBusinessTime(context,()=>new ContextBusinessClock().read({kind:'order',id:'TEST foreign'},()=>new Date('2026-01-01T00:00:00Z')))).rejects.toThrow('TEST scope rejected');
 });
});
