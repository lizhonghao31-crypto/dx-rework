import {describe,it,expect} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {acceptanceIncludesNative,installAcceptanceClockReader,withAcceptanceBusinessTime} from '../../apps/api/src/acceptance-clock/business-time.js';
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
});
