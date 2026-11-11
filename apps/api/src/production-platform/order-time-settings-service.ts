import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {OrderTimeStandardSchema} from '@dx-rework/contracts/order-time-plan';
import {OrderTimeConfigurationSchema,OrderTimeSettingsSaveSchema,OrderTimeSettingsUseSchema,orderTimeConfigurationFromLegacy,type OrderTimeStandardRecord,type OrderTimeSettingsRead,type OrderTimeConfiguration} from '@dx-rework/contracts/order-time-settings';
import {DevelopmentCycleValuesSchema} from '@dx-rework/contracts/digital-development-technical';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {acceptanceBusinessContext,businessNow} from '../acceptance-clock/business-time.js';
import {assertSlaSettingsActor,assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {SlaConfigurationRepository} from './sla-configuration-repository.js';
import {latestSettingsSet} from './sla-settings-set-repository.js';
import {ORDER_TIME_MODEL_ENABLED} from './order-time-activation.js';
import {orderTimeHistoryEntry,orderTimeHistoryPage} from './order-time-settings-history.js';

const conflict=(message:string):never=>{throw new ApplicationError('ORDER_TIME_SETTINGS_CONFLICT',message,409);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row={standard_id:string;version:number;standard_json:unknown;recorded_at:Date|string;source_standard_id:string|null};
const record=(row:Row):OrderTimeStandardRecord=>({id:row.standard_id,version:row.version,standard:OrderTimeStandardSchema.parse(row.standard_json),recordedAt:new Date(row.recorded_at).toISOString(),sourceId:row.source_standard_id});
/** Original authorization, transaction and idempotency owners. No order writes,
 * global backfill or personal-draft publication steps are needed here.
 */
export class OrderTimeSettingsService{
 constructor(private readonly database:Pool,private readonly enabled=ORDER_TIME_MODEL_ENABLED){}
 private async transaction<T>(write:boolean,actor:TrustedActorContext,work:(db:PoolClient)=>Promise<T>){
  const db=await this.database.connect();try{
   await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(write){await assertSlaSettingsActor(db,actor,true);if(!this.enabled)conflict('新版时效与订单采用一起启用，当前设置未改变');if(acceptanceBusinessContext())conflict('测试时钟场景不能修改公司设置');await db.query('LOCK TABLE digital_order_time_standards IN SHARE ROW EXCLUSIVE MODE');}
   else await assertSlaSettingsReadActor(db,actor);
   const result=await work(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async latest(db:PoolClient){const row=(await db.query<Row>('SELECT * FROM digital_order_time_standards ORDER BY version DESC LIMIT 1')).rows[0];return row?record(row):null;}
 private async state(db:PoolClient):Promise<OrderTimeSettingsRead>{
  const referenceTime=businessNow().toISOString(),current=await this.latest(db);if(current)return {enabled:this.enabled,version:current.version,referenceTime,current:{nodes:current.standard.nodes,stageBufferMinutes:current.standard.stageBufferMinutes},record:current};
  const repo=new SlaConfigurationRepository(db),unified=await repo.current(),development=(await db.query('SELECT values_json FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0],set=await latestSettingsSet(db);
  if(!development)throw new ApplicationError('NOT_FOUND','开发周期设置尚未安装',404);
  return {enabled:this.enabled,version:0,referenceTime,current:orderTimeConfigurationFromLegacy({unified:unified?.values??await repo.bootstrapValues(),development:DevelopmentCycleValuesSchema.parse(development.values_json),planning:set?.planning??{}}),record:null};
 }
 read(actor:TrustedActorContext){return this.transaction(false,actor,db=>this.state(db));}
 private async receipt<T>(db:PoolClient,actor:TrustedActorContext,action:string,key:string,input:unknown,work:()=>Promise<T>):Promise<T>{
  z.string().trim().min(1).max(200).parse(key);const command='order-time-settings:'+action,digest=hash(input),prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
  if(prior){if(prior.payload_hash!==digest)conflict('原操作标识不能用于不同内容');return prior.response as T;}
  const result=await work();await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,digest,JSON.stringify(result)]);return result;
 }
 private async append(db:PoolClient,actor:TrustedActorContext,expected:number,values:OrderTimeConfiguration,key:string,sourceId:string|null,sourceReference:string|null=null){
  const current=await this.latest(db);if((current?.version??0)!==expected)conflict('设置已更新，本次填写已保留，请刷新后核对');
  const configuration=OrderTimeConfigurationSchema.parse(values),id=randomUUID(),version=expected+1;
  const standard=OrderTimeStandardSchema.parse({version:'order-time-standard-v1',reference:'order-time-company:'+id,revision:version,...configuration});
  const row=(await db.query<Row>('INSERT INTO digital_order_time_standards(standard_id,version,standard_json,source_standard_id,created_by,request_key,source_reference) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,version,JSON.stringify(standard),sourceId,actor.actorId,key,sourceReference])).rows[0];
  if(!row)throw Error('新设置未保存');
  return {record:record(row),existingOrdersChanged:0 as const};
 }
 save(actor:TrustedActorContext,raw:unknown,key:string){const input=OrderTimeSettingsSaveSchema.parse(raw);return this.transaction(true,actor,db=>this.receipt(db,actor,'save',key,input,async()=>{
  if(input.sourceId&&!(await db.query('SELECT 1 FROM digital_order_time_standards WHERE standard_id=$1',[input.sourceId])).rowCount)throw new ApplicationError('NOT_FOUND','原历史设置不存在',404);
  return this.append(db,actor,input.expectedVersion,input.values,key,input.sourceId);
 }));}
 history(actor:TrustedActorContext,page=1){z.number().int().min(1).max(100000).parse(page);return this.transaction(false,actor,db=>orderTimeHistoryPage(db,page));}
 use(actor:TrustedActorContext,raw:unknown,key:string){const input=OrderTimeSettingsUseSchema.parse(raw);return this.transaction(true,actor,db=>this.receipt(db,actor,'use',key,input,async()=>{
  const source=await orderTimeHistoryEntry(db,input.kind,input.id);
  if(source.partial)conflict('历史记录不完整，缺少'+source.missing.join('、')+'，不能直接使用');
  return this.append(db,actor,input.expectedVersion,{nodes:source.standard.nodes,stageBufferMinutes:source.standard.stageBufferMinutes},key,source.kind==='order_time'?source.id:null,source.kind+':'+source.id);
 }));}
 remove(actor:TrustedActorContext,raw:unknown,key:string){const input=OrderTimeSettingsUseSchema.parse(raw);return this.transaction(true,actor,db=>this.receipt(db,actor,'remove',key,input,async()=>{
  const current=await this.latest(db);if((current?.version??0)!==input.expectedVersion)conflict('设置已更新，请刷新后核对');if(input.kind==='order_time'&&current?.id===input.id)conflict('正在使用的设置不能删除');
  await orderTimeHistoryEntry(db,input.kind,input.id);
  await db.query('INSERT INTO digital_order_time_history_events(event_id,entry_kind,entry_id,created_by,request_key) VALUES($1,$2,$3,$4,$5)',[randomUUID(),input.kind,input.id,actor.actorId,key]);return {id:input.id,deleted:true as const};
 }));}
}
