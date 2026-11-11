import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {CustomerMerchandiserQuerySchema,CustomerMerchandiserSelectionSchema,CustomerMerchandisersSaveSchema,type CustomerMerchandiserDefault} from '@dx-rework/contracts/digital-customer-merchandisers';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalProductionAccessPolicy,digitalForbidden,isDigitalManagementReader} from './access-policy.js';
import {lockEligibleMerchandiser} from './merchandiser-eligibility.js';
const fail=(message:string):never=>{throw new ApplicationError('CUSTOMER_MERCHANDISER_CONFLICT',message,409);};
type Row={code:string;name:string;default_merchandiser_version:number;default_merchandiser_id:string|null;primary_name:string|null;secondary:Array<{id:string;name:string|null}>|null};
const selectedSql=`SELECT c.code,c.name,c.default_merchandiser_version,c.default_merchandiser_id,u.display_name AS primary_name,
 (SELECT jsonb_agg(jsonb_build_object('id',s.user_id,'name',p.display_name) ORDER BY s.position,s.user_id)
  FROM digital_customer_secondary_merchandisers s JOIN app_users p ON p.id=s.user_id WHERE s.customer_code=c.code) AS secondary
 FROM digital_production_customers c LEFT JOIN app_users u ON u.id=c.default_merchandiser_id`;
const rowValue=(r:Row):CustomerMerchandiserDefault=>({code:r.code,name:r.name,version:r.default_merchandiser_version,primary:r.default_merchandiser_id?{id:r.default_merchandiser_id,name:r.primary_name}:null,secondary:r.secondary??[]});
/** Defaults apply only when a new order is created. They never call an order
 * handover, mutate an existing case or restart an approval responsibility.
 */
export class CustomerMerchandiserDefaultsService{
 constructor(private readonly database:Pool){}
 private async transaction<T>(write:boolean,actor:TrustedActorContext,work:(db:PoolClient)=>Promise<T>){
  const db=await this.database.connect();try{await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const root=isRootActor(actor),policy=new DigitalProductionAccessPolicy(db);
   if(write){if(!root&&!(actor.actorRoles.includes('production_management')&&await policy.lockActiveRole(actor.actorId,'production_management')))digitalForbidden();await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('member-module-owner-bindings',0))");}
   else if(!root){let allowed=false;if(isDigitalManagementReader(actor))for(const role of actor.actorRoles.filter(r=>['production_management','owner_group','pmc'].includes(r)))if(await policy.activeRole(actor.actorId,role)){allowed=true;break;}if(!allowed)digitalForbidden();}
   const result=await work(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 list(actor:TrustedActorContext,raw:unknown){const query=CustomerMerchandiserQuerySchema.parse(raw);return this.transaction(false,actor,async db=>{
  const where="c.enabled AND ($1='' OR position(lower($1) IN lower(c.code||' '||c.name))>0)",parameters=[query.q];
  const totalCount=Number((await db.query('SELECT count(*) AS count FROM digital_production_customers c WHERE '+where,parameters)).rows[0].count);
  const rows=(await db.query<Row>(selectedSql+' WHERE '+where+' ORDER BY c.code LIMIT 15 OFFSET $2',[...parameters,(query.page-1)*15])).rows;
  return {items:rows.map(rowValue),page:query.page,pageSize:15 as const,totalCount};
 });}
 selected(actor:TrustedActorContext,raw:unknown){const {codes}=CustomerMerchandiserSelectionSchema.parse(raw);return this.transaction(false,actor,async db=>({items:(await db.query<Row>(selectedSql+' WHERE c.code=ANY($1::text[]) ORDER BY c.code',[[...new Set(codes)]])).rows.map(rowValue)}));}
 save(actor:TrustedActorContext,raw:unknown,key:string){const input=CustomerMerchandisersSaveSchema.parse(raw);z.string().trim().min(1).max(200).parse(key);return this.transaction(true,actor,async db=>{
  const command='digital-customer-merchandisers',hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[command+':'+actor.actorId+':'+key]);
  const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
  if(prior){if(prior.payload_hash!==hash)fail('上次操作标识不能用于不同客户或安排');return prior.response;}
  for(const id of [...new Set([input.primaryMerchandiserId,...input.secondaryMerchandiserIds])].sort())if(!await lockEligibleMerchandiser(db,id,id!==input.primaryMerchandiserId))fail(id===input.primaryMerchandiserId?'主跟单必须是当前在职有效的订单跟单':'副跟单必须是当前在职有效且可读取和回传合同的订单跟单');
  const codes=input.customers.map(c=>c.code).sort();
  const locked=(await db.query<{code:string;default_merchandiser_version:number}>('SELECT code,default_merchandiser_version FROM digital_production_customers WHERE enabled AND code=ANY($1::text[]) ORDER BY code FOR UPDATE',[codes])).rows;
  if(locked.length!==codes.length)fail('所选客户已停用或不存在，请刷新后核对');
  for(const row of locked)if(row.default_merchandiser_version!==input.customers.find(c=>c.code===row.code)!.expectedVersion)fail('客户'+row.code+'的跟单设置已更新，本次填写已保留，请刷新后核对');
  const before=(await db.query<Row>(selectedSql+' WHERE c.code=ANY($1::text[]) ORDER BY c.code',[codes])).rows.map(rowValue);
  if(input.mode==='append')for(const id of [...new Set(before.flatMap(row=>row.secondary.map(person=>person.id)))].sort()){
   if(id!==input.primaryMerchandiserId&&!input.secondaryMerchandiserIds.includes(id)&&!await lockEligibleMerchandiser(db,id,true))fail('原副跟单已失效，请选择替换并移除失效人员后保存');
  }
  for(const old of before){const secondary=[...new Set([...(input.mode==='append'?old.secondary.map(p=>p.id):[]),...input.secondaryMerchandiserIds])].filter(id=>id!==input.primaryMerchandiserId);
   if(secondary.length>200)fail('副跟单过多，请分清实际办理人员后重试');
   await db.query('UPDATE digital_production_customers SET default_merchandiser_id=$2,default_merchandiser_version=default_merchandiser_version+1 WHERE code=$1',[old.code,input.primaryMerchandiserId]);
   await db.query('DELETE FROM digital_customer_secondary_merchandisers WHERE customer_code=$1',[old.code]);
   for(const [position,id]of secondary.entries())await db.query('INSERT INTO digital_customer_secondary_merchandisers(customer_code,user_id,position) VALUES($1,$2,$3)',[old.code,id,position+1]);
  }
  const items=(await db.query<Row>(selectedSql+' WHERE c.code=ANY($1::text[]) ORDER BY c.code',[codes])).rows.map(rowValue),result={items,existingOrdersChanged:0,changedCustomerCount:items.length};
  await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state) VALUES($1,$2,$3,'digital_customer_merchandisers_saved','digital_access',$4,$5,$6)",[randomUUID(),actor.requestId,actor.actorId,codes.join(','),JSON.stringify(before),JSON.stringify(items)]);
  await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
 });}
}
