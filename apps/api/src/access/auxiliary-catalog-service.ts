import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {AUXILIARY_CATALOG_ROLES,CreateAuxiliarySchema,RenameAuxiliarySchema,DisableAuxiliarySchema,MergeAuxiliarySchema,AuxiliaryQuerySchema,type AuxiliaryItem,type AuxiliaryQuery} from '@dx-rework/contracts/auxiliary-catalog';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {ApplicationError} from '../platform/errors.js';
import {IdempotencyService,OperationEventRepository,type TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy} from '../production-platform/access-policy.js';
import {isRootActor} from './business-authority.js';
import type {RootAuthority} from './root-authority.js';
const fail=(message:string,status=409):never=>{throw new ApplicationError(status===403?'FORBIDDEN':'AUXILIARY_CATALOG_CONFLICT',message,status);};
const parse=<T>(schema:{parse(value:unknown):T},value:unknown):T=>schema.parse(value);
const normalize=(value:string)=>value.trim().toLocaleLowerCase('zh-CN');
const same=(a:string,b:string)=>normalize(a)===normalize(b);
type Row={auxiliary_id:string;version:number;name:string;specification:string;supplier:string;auxiliary_kind:AuxiliaryItem['auxiliaryKind'];active:boolean;merged_into:string|null;changed_at:Date};
const item=(row:Row):AuxiliaryItem=>({id:row.auxiliary_id,version:row.version,name:row.name,specification:row.specification,supplier:row.supplier,auxiliaryKind:row.auxiliary_kind,active:row.active,mergedInto:row.merged_into,changedAt:row.changed_at.toISOString()});
export class AuxiliaryCatalogService{
 private readonly idem=new IdempotencyService();private readonly events=new OperationEventRepository();
 constructor(private readonly database:Pool,private readonly root:Pick<RootAuthority,'isRootUser'>){}
 private async authorize(db:PoolClient,actor:TrustedActorContext,write:boolean,lock=write){
  if(isRootActor(actor)&&await this.root.isRootUser(actor.actorId,db,lock))return;
  const capability=`auxiliary_catalog:${write?'write':'read'}`,caps=actor.authorizationCapabilities??[actor.authorizationCapability];
  if(!caps.includes(capability))fail('当前账号无共享辅料目录权限，请由设计师、订单跟单、供应链总监或老板处理',403);
  const policy=new DigitalProductionAccessPolicy(db);
  for(const role of AUXILIARY_CATALOG_ROLES){
   if(!actor.actorRoles.includes(role)||!await(lock?policy.lockActiveRole(actor.actorId,role):policy.activeRole(actor.actorId,role)))continue;
   if((await db.query(`SELECT 1 FROM role_capabilities WHERE role_code=$1 AND capability=$2 ${lock?'FOR SHARE':''}`,[role,capability])).rowCount)return;
  }
  fail('当前岗位已失效或没有共享辅料目录权限，请保留输入并联系有权岗位',403);
 }
 async list(actor:TrustedActorContext,input:AuxiliaryQuery){
  const query=AuxiliaryQuerySchema.parse({...input,includeInactive:String(input.includeInactive)}),db=await this.database.connect();
  try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.authorize(db,actor,false);
   const params=[query.includeInactive,query.q],where=`($1 OR (i.active AND i.merged_into IS NULL)) AND ($2='' OR strpos(lower(i.name||' '||i.specification||' '||i.supplier),lower($2))>0 OR EXISTS(SELECT 1 FROM auxiliary_catalog_versions v WHERE v.auxiliary_id=i.auxiliary_id AND strpos(lower(v.name),lower($2))>0) OR EXISTS(WITH RECURSIVE aliases(id) AS (SELECT i.auxiliary_id UNION ALL SELECT s.auxiliary_id FROM auxiliary_catalog_items s JOIN aliases a ON s.merged_into=a.id) SELECT 1 FROM aliases a JOIN auxiliary_catalog_versions v ON v.auxiliary_id=a.id WHERE strpos(lower(v.name),lower($2))>0))`;
   const total=Number((await db.query(`SELECT count(*) n FROM auxiliary_catalog_items i WHERE ${where}`,params)).rows[0].n);
   const rows=(await db.query<Row>(`SELECT i.* FROM auxiliary_catalog_items i WHERE ${where} ORDER BY i.name,i.auxiliary_id LIMIT 15 OFFSET $3`,[...params,(query.page-1)*15])).rows;
   let canManage=false;try{await this.authorize(db,actor,true,false);canManage=true;}catch(error){if(!(error instanceof ApplicationError)||error.statusCode!==403)throw error;}
   await db.query('COMMIT');return{items:rows.map(item),total,page:query.page,pageSize:15,canManage};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async receipt(actor:TrustedActorContext,action:string,key:string){
  if(!['create','rename','disable','merge'].includes(action)||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效原操作标识',400);
  const db=await this.database.connect();try{await this.authorize(db,actor,false);const found=(await db.query("SELECT response FROM idempotency_records WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3 AND status='completed'",[`auxiliary-catalog:${action}`,actor.actorId,key])).rows[0];return{receipt:found?.response??null};}finally{db.release();}
 }
 private async command(actor:TrustedActorContext,action:string,key:string,input:unknown,work:(db:PoolClient)=>Promise<AuxiliaryItem>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少本次目录操作标识，请保留输入',400);
  const db=await this.database.connect();try{await db.query('BEGIN');await this.authorize(db,actor,true);
   // All four directory operations use one short lock, then stable item locks.
   // Selection and order writes never take this lock or mutate order snapshots.
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-auxiliary-catalog-v1',0))");
   const result=await this.idem.execute(db,{scope:`auxiliary-catalog:${action}`,actorKey:actor.actorId,key,requestHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),expiresAt:new Date(Date.now()+7*86400000)},async()=>({statusCode:200,response:await work(db)}));
   await db.query('COMMIT');return result.response;
  }catch(error){await db.query('ROLLBACK');if(error instanceof ApplicationError&&error.code==='IDEMPOTENCY_CONFLICT')throw new ApplicationError(error.code,'原目录操作标识对应的内容不同，请先核对原结果，不要换内容重复提交',409);throw error;}finally{db.release();}
 }
 private async current(db:PoolClient,id:string,version:number){const row=(await db.query<Row>('SELECT * FROM auxiliary_catalog_items WHERE auxiliary_id=$1 FOR UPDATE',[id])).rows[0];if(!row) return fail('该辅料已不存在，请重新搜索',404);if(row.version!==version)fail('该辅料已被修改，本次未保存；请重新读取并核对');if(row.merged_into)fail('该辅料已合并，请在搜索结果选择目标条目');return row;}
 private async duplicate(db:PoolClient,name:string,specification:string,supplier:string,except?:string){
  const found=(await db.query('SELECT name,active FROM auxiliary_catalog_items WHERE lower(btrim(name))=lower(btrim($1)) AND lower(btrim(specification))=lower(btrim($2)) AND lower(btrim(supplier))=lower(btrim($3)) AND merged_into IS NULL AND ($4::uuid IS NULL OR auxiliary_id<>$4)',[name,specification,supplier,except??null])).rows[0];
  if(found)fail(`相同品名、规格与供应方的辅料“${found.name}”${found.active?'已存在，请复用已有项':'已停用，请核实旧条目；本操作不恢复启用'}`);
 }
 private async record(db:PoolClient,actor:TrustedActorContext,row:Row,before:Row|null,action:string,reason:string){
  const result=item(row),event=await this.events.append(db,{...actor,authorizationCapability:'auxiliary_catalog:write'},{action:`auxiliary_catalog.${action}`,entityType:'auxiliary_catalog',entityId:row.auxiliary_id,...(before?{before:item(before)}:{}),after:result,reason});
  await db.query(`INSERT INTO auxiliary_catalog_versions(auxiliary_id,version,name,specification,supplier,auxiliary_kind,active,merged_into,reason,changed_by,operation_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[row.auxiliary_id,row.version,row.name,row.specification,row.supplier,row.auxiliary_kind,row.active,row.merged_into,reason,actor.actorId,event]);return{result,event};
 }
 async create(actor:TrustedActorContext,input:unknown,key:string){const value=parse(CreateAuxiliarySchema,input);return this.command(actor,'create',key,value,async db=>{
  await this.duplicate(db,value.name,value.specification,value.supplier);const row=(await db.query<Row>(`INSERT INTO auxiliary_catalog_items(auxiliary_id,version,name,specification,supplier,auxiliary_kind,active) VALUES($1,1,$2,$3,$4,$5,true) RETURNING *`,[randomUUID(),value.name,value.specification,value.supplier,value.auxiliaryKind])).rows[0]!;return(await this.record(db,actor,row,null,'create','业务页直接新增共享辅料')).result;
 });}
 async rename(actor:TrustedActorContext,id:string,input:unknown,key:string){const value=parse(RenameAuxiliarySchema,input);return this.command(actor,'rename',key,{id,...value},async db=>{
  const before=await this.current(db,id,value.expectedVersion);await this.duplicate(db,value.name,before.specification,before.supplier,id);
  const row=(await db.query<Row>('UPDATE auxiliary_catalog_items SET version=version+1,name=$2,changed_at=CURRENT_TIMESTAMP WHERE auxiliary_id=$1 RETURNING *',[id,value.name])).rows[0]!;return(await this.record(db,actor,row,before,'rename',value.reason)).result;
 });}
 async disable(actor:TrustedActorContext,id:string,input:unknown,key:string){const value=parse(DisableAuxiliarySchema,input);return this.command(actor,'disable',key,{id,...value},async db=>{
  const before=await this.current(db,id,value.expectedVersion);if(!before.active)fail('该辅料已停用，无需重复操作');const row=(await db.query<Row>('UPDATE auxiliary_catalog_items SET version=version+1,active=false,changed_at=CURRENT_TIMESTAMP WHERE auxiliary_id=$1 RETURNING *',[id])).rows[0]!;return(await this.record(db,actor,row,before,'disable',value.reason)).result;
 });}
 async merge(actor:TrustedActorContext,id:string,input:unknown,key:string){const value=parse(MergeAuxiliarySchema,input);return this.command(actor,'merge',key,{id,...value},async db=>{
  if(id===value.targetId)fail('不能将辅料合并到自身');await db.query('SELECT auxiliary_id FROM auxiliary_catalog_items WHERE auxiliary_id=ANY($1::uuid[]) ORDER BY auxiliary_id FOR UPDATE',[[id,value.targetId]]);
  const before=await this.current(db,id,value.expectedVersion),target=await this.current(db,value.targetId,value.expectedTargetVersion);
  if(!target.active)fail('保留目标须为当前有效辅料，停用的原条目不会恢复启用');
  if(before.auxiliary_kind!==target.auxiliary_kind||!same(before.specification,target.specification)||!same(before.supplier,target.supplier))fail('分类、规格或供应方不同，无法确认为重复项；本次未合并');
  // Keep the immutable merge chain; recursive search resolves every prior name.
  const row=(await db.query<Row>('UPDATE auxiliary_catalog_items SET version=version+1,active=false,merged_into=$2,changed_at=CURRENT_TIMESTAMP WHERE auxiliary_id=$1 RETURNING *',[id,value.targetId])).rows[0]!;
  const recorded=await this.record(db,actor,row,before,'merge',value.reason);
  await db.query('INSERT INTO auxiliary_catalog_merges(source_id,target_id,source_version,target_version,operation_event_id) VALUES($1,$2,$3,$4,$5)',[id,value.targetId,row.version,target.version,recorded.event]);
  return recorded.result;
 });}
}

/** Snapshot references are provenance; no catalog operation rewrites an order. */
export async function validateAuxiliaryReferences(db:PoolClient,document:DevelopmentDocument,previous?:DevelopmentDocument){
 for(const material of document.materials){const reference=material.auxiliaryCatalog;if(!reference)continue;
  const row=(await db.query<Row>('SELECT v.*,i.active AS current_active,i.version AS current_version,i.merged_into AS current_merge FROM auxiliary_catalog_versions v JOIN auxiliary_catalog_items i USING(auxiliary_id) WHERE v.auxiliary_id=$1 AND v.version=$2 FOR SHARE OF i',[reference.id,reference.version])).rows[0] as (Row&{current_active:boolean;current_version:number;current_merge:string|null})|undefined;
  if(!row||material.category!=='辅料'||material.name!==row.name||material.specification!==row.specification||material.supplier!==row.supplier||(material.auxiliaryKind??'普通辅料')!==row.auxiliary_kind)return fail('辅料目录引用与本行资料不一致，请重新选择；手工修改品名、规格或供应方时应解除目录引用');
  const old=previous?.materials.find(m=>m.materialId===material.materialId)?.auxiliaryCatalog;
  if((old?.id!==reference.id||old.version!==reference.version)&&(!row.current_active||row.current_merge||row.current_version!==reference.version))fail('所选辅料已改名、合并或停用，请重新搜索选择；原有订单快照保留');
 }
}
