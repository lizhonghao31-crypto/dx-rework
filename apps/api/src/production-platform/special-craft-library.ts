import {SPECIAL_CRAFT_ADOPTION_ENABLED} from './special-craft-activation.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {isRootActor} from '../access/business-authority.js';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {SpecialCraftSaveSchema,SpecialCraftDefinitionSchema,type SpecialCraftVersion,type CraftStepChoice,adoptSpecialCraft} from '@dx-rework/contracts/digital-craft';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {assertSlaSettingsActor,assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';

type Row={craft_id:string;version:number;definition:unknown;recorded_at:Date|string};
const dto=(row:Row):SpecialCraftVersion=>({id:row.craft_id,version:row.version,definition:SpecialCraftDefinitionSchema.parse(row.definition),recordedAt:new Date(row.recorded_at).toISOString()});
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR','请检查工艺名称、版本、用时和提醒设置',400);return result.data;};
const conflict=(message:string):never=>{throw new ApplicationError('SPECIAL_CRAFT_CONFLICT',message,409);};
/** Settings administration only. Order selection must authorize its own original
 * source/order and freeze exact library versions; it never grants settings rights. */
export class SpecialCraftLibraryService{
 constructor(private readonly database:Pool){}
 private async transaction<T>(actor:TrustedActorContext,write:boolean,work:(db:PoolClient)=>Promise<T>){
  const db=await this.database.connect();try{
   await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(write){await assertSlaSettingsActor(db,actor,true);if(acceptanceBusinessContext())conflict('测试时钟场景不能修改公司设置');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('special-craft-library-v1',0))");}
   else await assertSlaSettingsReadActor(db,actor);
   const result=await work(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async choices(actor:TrustedActorContext){
  const db=await this.database.connect();try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(!isRootActor(actor)){
    const policy=new DigitalProductionAccessPolicy(db);let allowed=false;
    for(const role of ['sample_designer','order_merchandiser','development_clerk','production_management','owner_group'])if(actor.actorRoles.includes(role)&&await policy.activeRole(actor.actorId,role)){allowed=true;break;}
    if(!allowed)digitalForbidden();
   }
   const items=SPECIAL_CRAFT_ADOPTION_ENABLED?(await db.query<Row>(`SELECT v.* FROM digital_special_craft_heads h JOIN digital_special_craft_versions v ON v.craft_id=h.craft_id AND v.version=h.current_version WHERE v.definition->>'enabled'='true' ORDER BY v.definition->>'name',v.craft_id`)).rows.map(dto):[];
   await db.query('COMMIT');return {enabled:SPECIAL_CRAFT_ADOPTION_ENABLED,items};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 list(actor:TrustedActorContext){return this.transaction(actor,false,async db=>({items:(await db.query<Row>(`SELECT v.* FROM digital_special_craft_heads h JOIN digital_special_craft_versions v ON v.craft_id=h.craft_id AND v.version=h.current_version ORDER BY v.definition->>'name',v.craft_id`)).rows.map(dto)}));}
 history(actor:TrustedActorContext,id:string){id=parse(z.string().uuid(),id);return this.transaction(actor,false,async db=>({items:(await db.query<Row>('SELECT * FROM digital_special_craft_versions WHERE craft_id=$1 ORDER BY version DESC',[id])).rows.map(dto)}));}
 save(actor:TrustedActorContext,raw:unknown,key:string){
  const input=parse(SpecialCraftSaveSchema,raw);if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少本次操作标识，请保留输入');
  return this.transaction(actor,true,async db=>{
   const command='special-craft-library:save',hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)conflict('原操作标识不能用于不同内容');return prior.response as SpecialCraftVersion;}
   const current=input.id?(await db.query('SELECT current_version FROM digital_special_craft_heads WHERE craft_id=$1 FOR UPDATE',[input.id])).rows[0]:null;
   if(input.id&&!current)throw new ApplicationError('NOT_FOUND','特殊工艺不存在',404);
   if((current?.current_version??0)!==input.expectedVersion)conflict('特殊工艺已更新，请保留输入并刷新核对');
   const id=input.id??randomUUID(),version=input.expectedVersion+1;
   const row=(await db.query<Row>('INSERT INTO digital_special_craft_versions(craft_id,version,definition,created_by) VALUES($1,$2,$3,$4) RETURNING *',[id,version,JSON.stringify(input.definition),actor.actorId])).rows[0]!;
   await db.query('INSERT INTO digital_special_craft_heads(craft_id,current_version) VALUES($1,$2) ON CONFLICT(craft_id) DO UPDATE SET current_version=EXCLUDED.current_version',[id,version]);
   const result=dto(row);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'special_craft_saved','special_craft',$4,$5)",[randomUUID(),actor.requestId,actor.actorId,id,JSON.stringify({version,enabled:input.definition.enabled})]);
   return result;
  });
 }
}

/** Called under the source/order lifecycle lock, after its original authority
 * check. Unchanged selected versions survive library edits and disable. */
export async function validateSpecialCraftChoices(db:Pick<PoolClient,'query'>,choices:readonly CraftStepChoice[],previous:readonly CraftStepChoice[],stage:'development'|'bulk',enabled=SPECIAL_CRAFT_ADOPTION_ENABLED){
 for(const choice of choices){
  if(choice.craftKind!=='special')continue;
  const selected=choice.specialCraft;if(!selected)conflict('请选择具体特殊工艺');
  const prior=previous.find(step=>step.craftKind==='special'&&isDeepStrictEqual(step.specialCraft,selected))?.specialCraft;
  const row=(await db.query<Row>('SELECT * FROM digital_special_craft_versions WHERE craft_id=$1 AND version=$2',[selected!.id,selected!.version])).rows[0];
  if(!row||!isDeepStrictEqual(dto(row),selected))conflict('工艺库版本依据不一致，请重新读取');
  if(!prior||!isDeepStrictEqual(prior,selected)){
   if(!enabled)conflict('特殊工艺将在完整时间方案启用后开放，原订单保持不变');
   const current=(await db.query<Row>('SELECT v.* FROM digital_special_craft_heads h JOIN digital_special_craft_versions v ON v.craft_id=h.craft_id AND v.version=h.current_version WHERE h.craft_id=$1 FOR SHARE OF h',[selected!.id])).rows[0];
   if(!current||current.version!==selected!.version)conflict('特殊工艺设置已更新，请重新选择');
   adoptSpecialCraft(dto(current!),stage);
  }else{
   // Retained frozen versions remain valid after a library item is disabled.
   const standard=selected!.definition[stage];if(standard.minutes===null||standard.calendar===null)conflict('本单适用工艺的用时和计时日历尚未设置');
  }
 }
}
