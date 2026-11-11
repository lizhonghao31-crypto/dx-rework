import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient} from 'pg';
import type {BusinessClock,BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {ApplicationError} from '../platform/errors.js';

/** Set only by the guarded Acceptance runtime; never populated from a request date. */
export type AcceptanceBusinessContext=Readonly<{
 time:BusinessTime;configurationId:string;scenarioId:string;
 assertScope:(scope:BusinessTimeScope)=>Promise<void>;
 acceptsActor:(userId:string)=>Promise<boolean>;
 registerCreated:(db:PoolClient,scope:BusinessTimeScope,actorId:string,auditEventId:string)=>Promise<void>;
}>;
const contexts=new AsyncLocalStorage<AcceptanceBusinessContext>();
type ClockReader=Readonly<{
 read:(scope:BusinessTimeScope,transaction?:PoolClient)=>Promise<BusinessTime|null>;
 readMany?:(scopes:readonly BusinessTimeScope[],transaction?:PoolClient)=>Promise<ReadonlyMap<string,BusinessTime>>;
 nativeScenario:(id:string,transaction?:PoolClient)=>Promise<string|null>;
}>;
export const businessScopeKey=(scope:BusinessTimeScope)=>`${scope.kind}:${scope.id}`;
const readers=new WeakMap<object,ClockReader>();
/** Called once by the boot-verified runtime, not by a public configuration endpoint. */
export function installAcceptanceClockReader(database:Pool,reader:ClockReader){readers.set(database,reader);}
export const acceptanceClockReaderEnabled=(database:object)=>readers.has(database);
export async function acceptanceNativeScenario(database:object,id:string,transaction?:PoolClient){return readers.get(database)?.nativeScenario(id,transaction)??null;}
/** Schedulers must never process another scene using the current scene's time. */
export async function acceptanceIncludesNative(database:object,id:string,transaction?:PoolClient):Promise<boolean>{
 if(!readers.has(database))return true;
 const scene=await acceptanceNativeScenario(database,id,transaction),current=contexts.getStore();
 return current?scene===current.scenarioId:scene===null;
}
export const acceptanceBusinessContext=()=>contexts.getStore();
export function withAcceptanceBusinessTime<T>(context:AcceptanceBusinessContext,action:()=>T):T{
 return contexts.run(context,action);
}
/** Business occurrence/validation only. Security, audits and timeouts use real time. */
export function businessNow(fallback:()=>Date=()=>new Date(Date.now())):Date{
 const context=contexts.getStore();return context?new Date(context.time.now):fallback();
}
export function observedBusinessTime(fallback:()=>Date=()=>new Date()):BusinessTime{
 const context=contexts.getStore();return context?{...context.time}:{now:fallback().toISOString(),scenarioId:null,revision:0};
}
export class ContextBusinessClock implements BusinessClock{
 /** Pass only the caller's existing transaction from this same guarded pool. */
 constructor(private readonly database?:Pool,private readonly transaction?:PoolClient){}
 withTransaction(transaction:PoolClient){return new ContextBusinessClock(this.database,transaction);}
 async read(scope:BusinessTimeScope,fallback?:()=>Date):Promise<BusinessTime>{
  return (await this.readObservation(scope,fallback?{now:fallback,mode:'fixed'}:undefined)).time;
 }
 /** Only the selected ordinary fallback can prove a live observation. A
  * trusted reader or guarded context may freeze time with a null scenario ID. */
 async readObservation(scope:BusinessTimeScope,fallback?:Readonly<{now:()=>Date;mode:'live'|'fixed'}>):Promise<{time:BusinessTime;mode:'live'|'fixed'}>{
  const context=contexts.getStore();
  if(context){await context.assertScope(scope);return {time:observedBusinessTime(),mode:'fixed'};}
  const trusted=this.database?await readers.get(this.database)?.read(scope,this.transaction):null;
  if(trusted)return {time:trusted,mode:'fixed'};
  return {time:observedBusinessTime(fallback?.now),mode:fallback?.mode??'live'};
 }
 /** The same guarded clock contract for a lightweight candidate batch. It
  * neither grants scope nor replaces a custom reader returning scenarioId=null.
  * Ordinary missing rows share one caller-captured snapshot fallback. */
 async readMany(scopes:readonly BusinessTimeScope[],fallback?:()=>Date):Promise<ReadonlyMap<string,BusinessTime>>{
  const observations=await this.readManyObservations(scopes,fallback?{now:fallback,mode:'fixed'}:undefined);
  return new Map([...observations].map(([key,value])=>[key,value.time]));
 }
 /** Same batched clock evidence, retaining whether time really advances.
  * A null scenario supplied by a trusted reader is still a fixed clock. */
 async readManyObservations(scopes:readonly BusinessTimeScope[],fallback?:Readonly<{now:()=>Date;mode:'live'|'fixed'}>):Promise<ReadonlyMap<string,{time:BusinessTime;mode:'live'|'fixed'}>>{
  const unique=new Map(scopes.map(scope=>[businessScopeKey(scope),scope]));
  if(!unique.size)return new Map();
  const context=contexts.getStore(),result=new Map<string,{time:BusinessTime;mode:'live'|'fixed'}>();
  if(context){for(const [key,scope] of unique){await context.assertScope(scope);result.set(key,{time:observedBusinessTime(),mode:'fixed'});}return result;}
  let ordinary:{time:BusinessTime;mode:'live'|'fixed'}|undefined;
  const ordinaryTime=()=>ordinary??(ordinary={time:observedBusinessTime(fallback?.now),mode:fallback?.mode??'live'}),reader=this.database?readers.get(this.database):undefined;
  if(reader?.readMany){
   const batch=await reader.readMany([...unique.values()],this.transaction);
   for(const [key] of unique){const time=batch.get(key);result.set(key,time?{time,mode:'fixed'}:ordinaryTime());}
  }else for(const [key,scope] of unique){const time=await reader?.read(scope,this.transaction);result.set(key,time?{time,mode:'fixed'}:ordinaryTime());}
  return result;
 }
}
export async function registerAcceptanceCreated(db:PoolClient,scope:BusinessTimeScope,actorId:string,eventId:string){
 const context=contexts.getStore();if(context)await context.registerCreated(db,scope,actorId,eventId);
}
export async function assertAcceptanceAssignee(userId:string|null|undefined){
 const context=contexts.getStore();if(context&&userId&&!await context.acceptsActor(userId))throw new ApplicationError('ACCEPTANCE_ISOLATION','测试场景只能选择既有有效UAT身份，不能影响真实员工',403);
}

/** Call only after releasing an owned read transaction: a repeatable snapshot cannot see a newer clock version. */
export async function assertBusinessClockUnchanged(clock:BusinessClock,scope:BusinessTimeScope,observed:BusinessTime){
 if(!observed.scenarioId)return;
 const current=await clock.read(scope);
 if(current.scenarioId!==observed.scenarioId||current.revision!==observed.revision||current.now!==observed.now)
  throw new ApplicationError('CONFLICT','测试时钟在读取期间已变化，请刷新原页面',409);
}

/** Post-transaction check of only the actually observed guarded clocks. */
export async function assertBusinessClocksUnchanged(clock:ContextBusinessClock,observations:Iterable<{scope:BusinessTimeScope;time:BusinessTime}>){
 const observed=[...observations].filter(value=>value.time.scenarioId);
 if(!observed.length)return;
 const current=await clock.readMany(observed.map(value=>value.scope));
 for(const {scope,time}of observed){const actual=current.get(businessScopeKey(scope));
  if(!actual||actual.scenarioId!==time.scenarioId||actual.revision!==time.revision||actual.now!==time.now)
   throw new ApplicationError('CONFLICT','测试时钟在读取期间已变化，请刷新原页面',409);
 }
}
