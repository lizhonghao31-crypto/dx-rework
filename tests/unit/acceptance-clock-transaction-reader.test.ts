import {describe,it,expect,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {acceptanceIncludesNative,assertBusinessClocksUnchanged,businessScopeKey,ContextBusinessClock,installAcceptanceClockReader,withAcceptanceBusinessTime} from '../../apps/api/src/acceptance-clock/business-time.js';
describe('original scene isolation with an owned read transaction',()=>{
 it('uses one exact transaction batch, deduplicates scopes and keeps trusted null-scenario times without evaluating fallback',async()=>{
  const pool={} as Pool,transaction={} as PoolClient,scope={kind:'order' as const,id:'TEST order'},trusted={now:'2026-12-01T12:00:00.000Z',scenarioId:null,revision:0},calls:Array<unknown>=[];
  installAcceptanceClockReader(pool,{read:async()=>{throw Error('single reads must not run');},readMany:async(scopes,connection)=>{calls.push([scopes,connection]);return new Map([[businessScopeKey(scope),trusted]]);},nativeScenario:async()=>null});
  expect(await new ContextBusinessClock(pool,transaction).readMany([scope,scope],()=>{throw Error('fallback must not run');})).toEqual(new Map([[businessScopeKey(scope),trusted]]));
  expect(calls).toEqual([[[scope],transaction]]);
 });
 it('uses the captured ordinary snapshot only for missing scoped rows and preserves older custom singleton readers',async()=>{
  const pool={} as Pool,transaction={} as PoolClient,ordinary={kind:'order' as const,id:'TEST ordinary'},scoped={kind:'source' as const,id:'TEST scenario'},at='2026-10-01T12:00:00.000Z',trusted={now:'2026-09-01T00:00:00.000Z',scenarioId:'TEST scene',revision:2},calls:string[]=[];
  installAcceptanceClockReader(pool,{read:async(scope,connection)=>{expect(connection).toBe(transaction);calls.push(scope.id);return scope.id===scoped.id?trusted:null;},nativeScenario:async()=>null});
  const result=await new ContextBusinessClock(pool,transaction).readMany([ordinary,scoped],()=>new Date(at));
  expect(result.get(businessScopeKey(ordinary))).toEqual({now:at,scenarioId:null,revision:0});expect(result.get(businessScopeKey(scoped))).toEqual(trusted);expect(calls).toEqual([ordinary.id,scoped.id]);
 });
 it('checks every guarded scope and rejects a foreign object before returning any partial batch',async()=>{
  const own={kind:'order' as const,id:'TEST own'},foreign={kind:'source' as const,id:'TEST foreign'},seen:string[]=[],pool={} as Pool;
  installAcceptanceClockReader(pool,{read:async()=>{throw Error('native reader must not run');},readMany:async()=>{throw Error('native batch must not run');},nativeScenario:async()=>null});
  const context={time:{now:'2026-11-01T00:00:00Z',scenarioId:'TEST scene',revision:1},configurationId:'TEST configuration',scenarioId:'TEST scene',assertScope:async(scope:typeof own|typeof foreign)=>{seen.push(scope.id);if(scope.id===foreign.id)throw Error('TEST foreign scope denied');},acceptsActor:async()=>true,registerCreated:async()=>{}};
  await expect(withAcceptanceBusinessTime(context,()=>new ContextBusinessClock(pool).readMany([own,foreign]))).rejects.toThrow('TEST foreign scope denied');expect(seen).toEqual([own.id,foreign.id]);
  const result=await withAcceptanceBusinessTime(context,()=>new ContextBusinessClock(pool).readMany([own],()=>{throw Error('fallback must not run');}));expect(result.get(businessScopeKey(own))).toEqual(context.time);
 });
 it('postchecks guarded scenario identity, revision and time in one batch while ordinary observations need no recheck',async()=>{
  const pool={} as Pool,scope={kind:'order' as const,id:'TEST scoped'},time={now:'2026-11-01T00:00:00.000Z',scenarioId:'TEST scene',revision:1};let current={...time},calls=0;
  installAcceptanceClockReader(pool,{read:async()=>{throw Error('singleton postcheck must not run');},readMany:async(scopes)=>{calls++;expect(scopes).toEqual([scope]);return new Map([[businessScopeKey(scope),current]]);},nativeScenario:async()=>null});
  const clock=new ContextBusinessClock(pool),observed=[{scope,time},{scope:{kind:'source' as const,id:'TEST ordinary'},time:{...time,scenarioId:null}}];
  await expect(assertBusinessClocksUnchanged(clock,observed)).resolves.toBeUndefined();
  for(const changed of [{...time,revision:2},{...time,scenarioId:'TEST other'},{...time,now:'2026-11-02T00:00:00.000Z'}]){current=changed;await expect(assertBusinessClocksUnchanged(clock,observed)).rejects.toMatchObject({code:'CONFLICT'});}
  expect(calls).toBe(4);
  await expect(assertBusinessClocksUnchanged(clock,[observed[1]!])).resolves.toBeUndefined();expect(calls).toBe(4);
 });
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

 it('proves live only for the selected ordinary clock fallback and never for a null-scenario reader',async()=>{
  const pool={} as Pool,transaction={} as PoolClient,scope={kind:'order' as const,id:'TEST live proof'},at='2026-12-01T12:00:00.000Z',time={now:at,scenarioId:null,revision:0};
  const clock=new ContextBusinessClock(pool,transaction),fallback={now:()=>new Date(at),mode:'live' as const};
  expect(await clock.readObservation(scope,fallback)).toEqual({time,mode:'live'});
  installAcceptanceClockReader(pool,{read:async(_scope,db)=>{expect(db).toBe(transaction);return null;},nativeScenario:async()=>null});
  expect(await clock.readObservation(scope,fallback)).toEqual({time,mode:'live'});
  installAcceptanceClockReader(pool,{read:async()=>time,nativeScenario:async()=>null});
  expect(await clock.readObservation(scope,{now:()=>{throw Error('trusted reader must win');},mode:'live'})).toEqual({time,mode:'fixed'});
  expect(await clock.read(scope,()=>{throw Error('fallback must not run');})).toEqual(time);
  expect(await new ContextBusinessClock().readObservation(scope,{now:()=>new Date(at),mode:'fixed'})).toEqual({time,mode:'fixed'});
 });
 it('keeps batched observation provenance without a query per object or treating a null-scenario supplied clock as live',async()=>{
  const pool={} as Pool,transaction={} as PoolClient,ordinary={kind:'order' as const,id:'TEST ordinary'},fixed={kind:'source' as const,id:'TEST fixed-null'},at='2026-12-01T12:00:00.000Z';
  const readMany=vi.fn(async()=>new Map([[businessScopeKey(fixed),{now:at,scenarioId:null,revision:0}]]));
  installAcceptanceClockReader(pool,{read:async()=>{throw Error('must use one batch');},readMany,nativeScenario:async()=>null});
  const rows=await new ContextBusinessClock(pool,transaction).readManyObservations([ordinary,fixed,ordinary],{now:()=>new Date(at),mode:'live'});
  expect(readMany).toHaveBeenCalledTimes(1);expect(readMany).toHaveBeenCalledWith([ordinary,fixed],transaction);
  expect(rows.get(businessScopeKey(ordinary))).toEqual({time:{now:at,scenarioId:null,revision:0},mode:'live'});
  expect(rows.get(businessScopeKey(fixed))).toEqual({time:{now:at,scenarioId:null,revision:0},mode:'fixed'});
 });
