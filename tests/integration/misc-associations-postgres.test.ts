import { resolveMiscAssociation } from "../../apps/api/src/pattern-room/misc-associations.js";
import {PatternRoomPriceService,PATTERN_HOURLY_PRICE_ID} from "../../apps/api/src/pattern-room/price-service.js";
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import Fastify from 'fastify';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PATTERN_ORDER_ROLES} from '@dx-rework/contracts/pattern-orders';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {registerPatternRoomOrderRoutes} from '../../apps/api/src/pattern-room/order-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';
const databaseUrl=process.env.TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('misc stable references and closed standalone creation',()=>{
 const schema=ownedPostgresSchema('misc_association'),admin=new pg.Pool({connectionString:databaseUrl}),db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
 const root=randomUUID(),designer=randomUUID(),other=randomUUID(),merch=randomUUID(),worker=randomUUID(),supervisor=randomUUID(),caps=Object.keys(PATTERN_ORDER_ROLES);
 const actor=(id=designer,roles=['sample_designer']):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:'pattern_room:misc:create',authorizationCapabilities:caps,requestId:'TEST-MISC-ASSOCIATION'});
 const service=new PatternRoomOrderService(db,new TodoProjectionService(new TodoService(db)),{ordersEnabled:true}),identity=new DigitalProductionIdentityService(db,true,undefined,()=>new Date('2026-09-01T00:00:00Z'));
 let sourceId:string,poId:string,orderId:string,hourlyVersion=1;
 const input=(taskName:string,association?:{kind:'source'|'po';id:string},styleNo='')=>({taskName,priceVersion:hourlyVersion,styleNo,...(association?{association}:{})});
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8')),serverVersion=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64),applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)');
  for(const migration of manifest.migrations){const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),'utf8');await db.query(migrationExecutionSql({...migration,sql},serverVersion));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
  for(const [id,role]of [[root,'owner_group'],[designer,'sample_designer'],[other,'sample_designer'],[merch,'order_merchandiser'],[worker,'pattern_room_worker'],[supervisor,'pattern_room_supervisor']]){
   await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,`TEST ${role}`]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','TEST',$2::uuid::text,$2::uuid::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST misc fixture')",[randomUUID(),id,role,root]);
  }
  await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'production_management',$3,'TEST mixed creator/read authority')",[randomUUID(),designer,root]);
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$1::uuid::text,'TEST')",[root]);
  await db.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','TEST') ON CONFLICT(policy_key) DO UPDATE SET dingtalk_corp_id='TEST'");
  hourlyVersion=(await new PatternRoomPriceService(db).change(actor(root,["root_superuser"]),"hourly",PATTERN_HOURLY_PRICE_ID,{version:1,amount:"12.000",enabled:true,reason:"TEST misc price fixture"},randomUUID())).version;
  sourceId=(await identity.createSource(actor(),{developmentType:'头版',designStyleNo:'TEST-MISC-SOURCE',temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;
  const order=await identity.createOrder(actor(),DigitalOrderCreateSchema.parse({designStyleNo:'TEST-MISC-MOTHER',temporaryStyleNo:null,customerCode:'PD',productGroup:'男装',orderDate:'2026-09-01',lines:[{poNumber:'PO-MISC-1',color:'蓝',sizes:[{size:'M',quantity:10}],deliveryDate:'2026-12-01'}]}),randomUUID());orderId=order.productionOrderId;poId=order.lines[0]!.lineId;
 },120000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('rejects standalone new pattern for Root/designer/other roles and the old POST, while advertising no create action',async()=>{
  for(const context of [actor(),actor(root,['root_superuser']),actor(merch,['order_merchandiser']),actor(worker,['pattern_room_worker']),actor(supervisor,['pattern_room_supervisor'])])await expect(service.create(context,{},randomUUID())).rejects.toMatchObject({statusCode:403});
  const app=Fastify();app.setErrorHandler((error,_req,reply)=>reply.code((error as ApplicationError).statusCode??500).send({error:{message:error.message}}));
  registerPatternRoomOrderRoutes(app,{service,attachments:{} as AttachmentService,authenticate:async()=>({id:designer,businessRoles:['sample_designer'],capabilities:caps})});
  try{const response=await app.inject({method:'POST',url:'/pattern-room/orders',payload:{},headers:{cookie:'dx_rework_session=TEST','idempotency-key':randomUUID()}});expect(response.statusCode).toBe(403);expect(response.json().error.message).toContain('开发单发布');}finally{await app.close();}
  expect((await service.list(actor(),{page:1,limit:15})).canCreate).toBe(false);
 });
 it('allows empty association, saves authorized source/PO IDs and canonical snapshots and replays without duplicates',async()=>{
  const foreign=(await identity.createSource(actor(other),{developmentType:'头版',designStyleNo:'TEST-MISC-FOREIGN',temporaryStyleNo:null,customerCode:'FL'},randomUUID())).sourceId;
  const options=await service.miscAssociations(actor(),'TEST-MISC');expect(options.map(item=>item.id)).toContain(foreign);expect(options.map(item=>item.id)).toEqual(expect.arrayContaining([sourceId,poId]));
  expect((await service.miscAssociations(actor(other),'TEST-MISC')).map(item=>item.id)).toEqual([foreign]);await expect(service.miscAssociations(actor(worker,['pattern_room_worker']),'')).rejects.toMatchObject({statusCode:403});
  const empty=await service.createMisc(actor(),input('TEST no association'),randomUUID());expect(empty.association).toBeNull();
  const source=options.find(item=>item.id===sourceId)!,po=options.find(item=>item.id===poId)!,key=randomUUID(),request=input('TEST stable source',{kind:'source',id:sourceId},source.styleNo);
  const rootSaved=await service.createMisc(actor(root,['root_superuser']),input('TEST Root authorized association',{kind:'source',id:sourceId},source.styleNo),randomUUID());expect(rootSaved.association?.id).toBe(sourceId);
  const saved=await service.createMisc(actor(),request,key);expect(saved.association).toEqual(source);expect((await service.createMisc(actor(),request,key)).orderId).toBe(saved.orderId);
  const selected=await service.createMisc(actor(),input('TEST stable PO',{kind:'po',id:poId},po.styleNo),randomUUID());expect(selected.association).toEqual(po);expect(selected.association?.label).toContain('PO-MISC-1');
  expect((await db.query('SELECT count(*)::int n FROM pattern_room_orders WHERE task_name=$1',[request.taskName])).rows[0].n).toBe(1);
  expect((await service.list(actor(),{page:1,limit:15,kind:'misc'})).items.every(item=>item.kind==='misc')).toBe(true);
 });
 it('rejects free text, mismatched selection, tampered or unauthorized IDs and a concurrently removed source',async()=>{
  const source=(await service.miscAssociations(actor(),'TEST-MISC-SOURCE'))[0]!;
  for(const request of [input('TEST free text',undefined,'does-not-exist'),input('TEST edited choice',{kind:'source',id:sourceId},'OTHER'),input('TEST bad ID',{kind:'source',id:randomUUID()},source.styleNo)])await expect(service.createMisc(actor(),request,randomUUID())).rejects.toMatchObject({statusCode:400});
  await expect(service.createMisc(actor(other),input('TEST unauthorized',{kind:'source',id:sourceId},source.styleNo),randomUUID())).rejects.toMatchObject({statusCode:400});
  await expect(service.createMisc(actor(merch,['order_merchandiser']),input('TEST unauthorized PO',{kind:'po',id:poId},'TEST-MISC-MOTHER'),randomUUID())).rejects.toMatchObject({statusCode:400});
  // Source/root identities cannot be deleted by design. Exercise a removable,
  // not-yet-adopted PO fixture instead; never relax those identity guards.
  const removed=randomUUID();await db.query("INSERT INTO digital_production_po_lines(line_id,production_order_id,position,formal_style_no,po_number,color) VALUES($1,$2,2,'TEST-MISC-DELETED','TEST-MISC-DELETED','白')",[removed,orderId]);
  const deleter=await db.connect();let committed=false;
  try{await deleter.query('BEGIN');await deleter.query('DELETE FROM digital_production_po_lines WHERE line_id=$1',[removed]);const pending=service.createMisc(actor(),input('TEST concurrent deletion',{kind:'po',id:removed},'TEST-MISC-DELETED'),randomUUID());await deleter.query('COMMIT');committed=true;await expect(pending).rejects.toMatchObject({statusCode:400});}finally{if(!committed)await deleter.query('ROLLBACK');deleter.release();}
  expect((await db.query("SELECT count(*)::int n FROM pattern_room_orders WHERE task_name='TEST concurrent deletion'")).rows[0].n).toBe(0);
 });
 it('keeps old strings unchanged without inferring IDs, permits a valid replacement, and filters/paginates 15/16/31',async()=>{
  let legacy=await service.createMisc(actor(),input('TEST legacy'),randomUUID());await db.query("UPDATE pattern_room_orders SET style_no='HISTORICAL-TEXT' WHERE order_id=$1",[legacy.orderId]);
  legacy=await service.updateMiscMaterials(actor(),legacy.orderId,{version:legacy.version,roundId:legacy.currentRoundId,taskName:'TEST legacy',styleNo:'HISTORICAL-TEXT',reason:'TEST keep historical'},randomUUID());expect(legacy.styleNo).toBe('HISTORICAL-TEXT');expect(legacy.association).toBeNull();
  await expect(service.updateMiscMaterials(actor(),legacy.orderId,{version:legacy.version,roundId:legacy.currentRoundId,taskName:'TEST legacy',styleNo:'CHANGED-TEXT',reason:'TEST tamper'},randomUUID())).rejects.toMatchObject({statusCode:400});
  const source=(await service.miscAssociations(actor(),'TEST-MISC-SOURCE'))[0]!;legacy=await service.updateMiscMaterials(actor(),legacy.orderId,{version:legacy.version,roundId:legacy.currentRoundId,taskName:'TEST legacy',styleNo:source.styleNo,association:{kind:'source',id:source.id},reason:'TEST choose authorized'},randomUUID());expect(legacy.association).toEqual(source);
  await db.query('UPDATE digital_production_orders SET primary_merchandiser_id=$2 WHERE production_order_id=$1',[orderId,merch]);expect((await service.miscAssociations(actor(merch,['order_merchandiser']),'PO-MISC')).map(item=>item.id)).toContain(poId);
  for(let i=0;i<31;i++)await service.createMisc(actor(),input(`TEST-PAGE-${i}`),randomUUID());
  for(const [page,count]of [[1,15],[2,15],[3,1],[4,0]]){const result=await service.list(actor(),{page,limit:15,q:'TEST-PAGE-',kind:'misc'});expect(result).toMatchObject({totalCount:31,pageSize:15,totalPages:3});expect(result.items).toHaveLength(count);}
 });
 it('refreshes a stable PO snapshot after real identity corrections while keeping tampered replacement text rejected',async()=>{
  const old=(await service.miscAssociations(actor(),'PO-MISC-1')).find(item=>item.id===poId)!;
  let misc=await service.createMisc(actor(),input('TEST renamed PO',{kind:'po',id:poId},old.styleNo),randomUUID());
  let order=await identity.read(actor(),orderId);
  order=await identity.correctNumbers(actor(),orderId,poId,{expectedVersion:order.version,formalPoNo:'PO-MISC-RENAMED',poNumber:null,formalStyleNo:null},randomUUID());
  const request={version:misc.version,roundId:misc.currentRoundId,taskName:'TEST renamed PO',styleNo:old.styleNo,association:{kind:'po' as const,id:poId},note:'TEST unrelated note survives',reason:'TEST refresh existing ID'};
  const editKey=randomUUID();misc=await service.updateMiscMaterials(actor(),misc.orderId,request,editKey);
  expect((await service.updateMiscMaterials(actor(),misc.orderId,request,editKey)).version).toBe(misc.version);
  expect(misc.styleNo).toBe('PO-MISC-RENAMED');expect(misc.note).toBe(request.note);
  expect(misc.association).toMatchObject({kind:'po',id:poId,styleNo:'PO-MISC-RENAMED'});expect(misc.association?.label).toContain('PO-MISC-RENAMED');
  await expect(service.updateMiscMaterials(actor(),misc.orderId,{...request,version:misc.version,styleNo:'INVENTED-NUMBER'},randomUUID())).rejects.toMatchObject({statusCode:400});
  await identity.correctNumbers(actor(),orderId,poId,{expectedVersion:order.version,formalPoNo:'PO-MISC-RENAMED-2',poNumber:null,formalStyleNo:null},randomUUID());
  misc=await service.updateMiscMaterials(actor(),misc.orderId,{version:misc.version,roundId:misc.currentRoundId,taskName:'TEST renamed PO',styleNo:misc.styleNo,reason:'TEST omitted association uses persisted stable ID'},randomUUID());
  expect(misc.styleNo).toBe('PO-MISC-RENAMED-2');expect(misc.association?.styleNo).toBe(misc.styleNo);
  const historical=(await db.query("SELECT after_state->'value'->>'styleNo' AS style_no FROM operation_events WHERE entity_id=$1 AND action='pattern_room.misc.submitted'",[misc.orderId])).rows[0];expect(historical.style_no).toBe(old.styleNo);
 });
 it('rejects an elevated role revoked after authorization and serializes a later revocation until the association commits',async()=>{
  const foreign=(await identity.createSource(actor(other),{developmentType:'头版',designStyleNo:'TEST-MISC-ROLE-RACE',temporaryStyleNo:null,customerCode:'FL'},randomUUID())).sourceId;
  const revoke=async(existing?:pg.PoolClient)=>{
   const client=existing??await db.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('dx_rework.role_revoke_event_id',$1,true),set_config('dx_rework.role_revoke_request_id','TEST-MISC-role-race',true)",[randomUUID()]);const result=await client.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason='TEST mixed role concurrent revocation' WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[designer,root]);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{if(!existing)client.release();}
  };
  const restore=async()=>{const client=await db.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('dx_rework.role_assign_event_id',$1,true),set_config('dx_rework.role_assign_request_id','TEST-MISC-role-restore',true)",[randomUUID()]);await client.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) SELECT $1,$2,'production_management',$3,'TEST restore mixed role' WHERE NOT EXISTS(SELECT 1 FROM user_role_assignments WHERE user_id=$2 AND role_code='production_management' AND revoked_at IS NULL)",[randomUUID(),designer,root]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const client=await db.connect();let resume!:()=>void,seen!:()=>void;
  const paused=new Promise<void>(resolve=>{resume=resolve;}),observed=new Promise<void>(resolve=>{seen=resolve;});let held=false;
  const query=client.query.bind(client);
  const gated=new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(query,client,args);if(!held&&typeof args[0]==='string'&&args[0].includes('pattern_room_authorized_order_roles')){held=true;seen();await paused;}return result;};return Reflect.get(target,key);}});
  let pending:Promise<{error?:unknown;value?:unknown}>|undefined;
  try{
   await client.query('BEGIN');
   const scoped=new PatternRoomOrderService(db,new TodoProjectionService(new TodoService(db)),{ordersEnabled:true,transactionClient:gated});
   pending=scoped.createMisc(actor(),input('TEST role revoked before choice',{kind:'source',id:foreign},'TEST-MISC-ROLE-RACE'),randomUUID()).then(value=>({value}),error=>({error}));
   await observed;await revoke();resume();
   expect((await pending).error).toMatchObject({statusCode:400});
  }finally{resume();await pending;await client.query('ROLLBACK');client.release();await restore();}
  expect((await db.query("SELECT count(*)::int n FROM pattern_room_orders WHERE task_name='TEST role revoked before choice'")).rows[0].n).toBe(0);
  const holder=await db.connect(),revoker=await db.connect();let committed=false,revocation:ReturnType<typeof revoke>|undefined;
  try{
   await holder.query('BEGIN');
   await resolveMiscAssociation(holder,actor(designer,['sample_designer','production_management']),{styleNo:'TEST-MISC-ROLE-RACE',association:{kind:'source',id:foreign}});
   const pid=(await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   revocation=revoke(revoker);
   let waiting=false;const until=Date.now()+5000;
   while(Date.now()<until){waiting=(await db.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);
   await holder.query('COMMIT');committed=true;expect((await revocation).rowCount).toBe(1);
  }finally{if(!committed)await holder.query('ROLLBACK');await revocation;holder.release();revoker.release();await restore();}
 });

});
