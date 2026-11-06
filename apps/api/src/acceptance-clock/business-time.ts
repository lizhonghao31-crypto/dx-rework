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
type ClockReader=Readonly<{read:(scope:BusinessTimeScope,transaction?:PoolClient)=>Promise<BusinessTime|null>;nativeScenario:(id:string,transaction?:PoolClient)=>Promise<string|null>}>;
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
 async read(scope:BusinessTimeScope):Promise<BusinessTime>{
  const context=contexts.getStore();
  if(context){await context.assertScope(scope);return observedBusinessTime();}
  return this.database?await readers.get(this.database)?.read(scope,this.transaction)??observedBusinessTime():observedBusinessTime();
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
