import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AcceptanceClockView} from '@dx-rework/contracts/acceptance-clock';
import {ApplicationError} from '../platform/errors.js';
import {SlaConfigurationRepository} from '../production-platform/sla-configuration-repository.js';

export const clockConflict=(message:string):never=>{throw new ApplicationError('ACCEPTANCE_CLOCK_CONFLICT',message,409);};
export const clockHash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export type ClockRow={scenario_id:string;name:string;corporation_id:string;initial_time:Date;business_now:Date;version:number;business_revision:string;configuration_id:string;created_by:string;request_key:string;copied_from:string|null;created_at:Date};
const lockBudgets=new WeakMap<Pool,{active:number;queue:(()=>void)[]}>();
async function reserveLock(database:Pool){
 // Waiting requests must not exhaust the same pool that business transactions need.
 // Existing server pool is 10; reserve at least two action connections per held lock.
 if((database.options.max??10)<3)throw new Error('Acceptance clock requires a pool of at least three connections');
 let state=lockBudgets.get(database);if(!state){state={active:0,queue:[]};lockBudgets.set(database,state);}
 const budget=state,limit=Math.max(1,Math.floor((database.options.max??10)/3));
 if(budget.active>=limit)await new Promise<void>(resolve=>budget.queue.push(resolve));else budget.active++;
 return ()=>{const next=budget.queue.shift();if(next)next();else budget.active--;};
}
export class AcceptanceClockRepository{
 constructor(readonly pool:Pool){}
 async transaction<T>(action:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();try{await db.query('BEGIN');const result=await action(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async withLock<T>(id:string,action:()=>Promise<T>):Promise<T>{
  const releaseBudget=await reserveLock(this.pool),key=`acceptance-sla-clock:${id}`;
  try{
   const db=await this.pool.connect();
   try{await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);return await action();}
   finally{try{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}finally{db.release();}}
  }finally{releaseBudget();}
 }
 async row(id:string,db:Pick<Pool|PoolClient,'query'>=this.pool,lock=false):Promise<ClockRow>{
  const value=(await db.query(`SELECT * FROM acceptance_sla_clock_scenarios WHERE scenario_id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];
  if(!value)throw new ApplicationError('NOT_FOUND','测试场景不存在',404);return value;
 }
 async create(actorId:string,corporationId:string,input:{name:string;requestKey:string;copyScenarioId?:string|undefined}):Promise<ClockRow>{
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`acceptance-clock-create:${input.requestKey}`]);
   const prior=(await db.query('SELECT * FROM acceptance_sla_clock_scenarios WHERE request_key=$1',[input.requestKey])).rows[0];
   if(prior){if(prior.created_by!==actorId||prior.corporation_id!==corporationId||prior.name!==input.name||prior.copied_from!==(input.copyScenarioId??null))clockConflict('场景操作标识已用于不同内容');return prior;}
   const copied=input.copyScenarioId?await this.row(input.copyScenarioId,db):null;
   const config=copied?{configurationId:copied.configuration_id}:await new SlaConfigurationRepository(db).initialStandard(actorId),time=copied?.initial_time??new Date();
   return (await db.query(`INSERT INTO acceptance_sla_clock_scenarios(scenario_id,name,corporation_id,initial_time,business_now,configuration_id,created_by,request_key,copied_from)
    VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),input.name,corporationId,time,config.configurationId,actorId,input.requestKey,input.copyScenarioId??null])).rows[0];
  });
 }
 async view(id:string):Promise<AcceptanceClockView>{
  const row=await this.row(id),config=(await this.pool.query('SELECT version FROM digital_sla_configurations WHERE configuration_id=$1',[row.configuration_id])).rows[0];
  const roots=(await this.pool.query('SELECT resource_kind,resource_id FROM acceptance_sla_clock_resources WHERE scenario_id=$1 ORDER BY created_at,resource_id',[id])).rows;
  const scan=(await this.pool.query('SELECT status,error_message,started_at,finished_at FROM acceptance_sla_clock_scans WHERE scenario_id=$1 ORDER BY started_at DESC,scan_id DESC LIMIT 1',[id])).rows[0];
  return {scenarioId:id,name:row.name,now:row.business_now.toISOString(),version:row.version,configurationId:row.configuration_id,configurationVersion:config.version,
   sourceIds:roots.filter(r=>r.resource_kind==='source').map(r=>r.resource_id),orderIds:roots.filter(r=>r.resource_kind==='order').map(r=>r.resource_id),recordedAt:row.created_at.toISOString(),
   lastScan:scan?{status:scan.status,recordedAt:(scan.finished_at??scan.started_at).toISOString(),message:scan.error_message}:null};
 }
 async change(id:string,actorId:string,input:{expectedVersion:number;requestKey:string;at?:string;configurationId?:string},verify?:(db:PoolClient,row:ClockRow)=>Promise<void>){
  return this.transaction(async db=>{
   const row=await this.row(id,db,true),kind=input.configurationId?'configuration':'advance',hash=clockHash({kind,...input});
   const prior=(await db.query('SELECT * FROM acceptance_sla_clock_events WHERE scenario_id=$1 AND request_key=$2',[id,input.requestKey])).rows[0];
   if(prior){if(prior.actor_id!==actorId||prior.payload_hash!==hash)clockConflict('同一时钟操作标识不能用于不同内容');return {replayed:true,effect:prior.response_json};}
   if(row.version!==input.expectedVersion)clockConflict('测试时间或标准已更新，请刷新后重新预览');
   if(verify)await verify(db,row);
   const at=input.at?new Date(input.at):row.business_now;
   if(!Number.isFinite(at.getTime())||at.getUTCFullYear()>9999||input.at&&at<=row.business_now)clockConflict('测试时钟只能向前；重测请新建场景');
   const configurationId=input.configurationId??row.configuration_id;
   if(!(await db.query('SELECT 1 FROM digital_sla_configurations WHERE configuration_id=$1',[configurationId])).rowCount)clockConflict('请选择既有已发布的时效标准');
   const updated=(await db.query('UPDATE acceptance_sla_clock_scenarios SET business_now=$2,configuration_id=$3,version=version+1 WHERE scenario_id=$1 RETURNING *',[id,at.toISOString(),configurationId])).rows[0] as ClockRow;
   const effect={now:updated.business_now.toISOString(),version:updated.version,configurationId};
   await db.query(`INSERT INTO acceptance_sla_clock_events(event_id,scenario_id,request_key,kind,payload_hash,actor_id,before_time,after_time,version,response_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),id,input.requestKey,kind,hash,actorId,row.business_now,updated.business_now,updated.version,JSON.stringify(effect)]);
   await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
    VALUES($1,$2,$3,$4,'acceptance_sla_clock',$5,$6,$7)`,[randomUUID(),`acceptance-clock:${input.requestKey}`,actorId,`acceptance.clock.${kind}`,id,JSON.stringify({now:row.business_now.toISOString(),version:row.version}),JSON.stringify(effect)]);
   return {replayed:false,effect};
  });
 }
 async markBusinessMutation(id:string){await this.pool.query('UPDATE acceptance_sla_clock_scenarios SET business_revision=business_revision+1 WHERE scenario_id=$1',[id]);}
}
