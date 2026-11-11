import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {CustomerMerchandiserDefaultsService} from '../../apps/api/src/production-platform/customer-merchandiser-defaults.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {EmployeeAccessService} from '../../apps/api/src/access/employee-access-service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {OfficialDingTalkProvider} from '../../apps/api/src/auth/provider.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 customer batch defaults and all secondary relationships',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,defaults:CustomerMerchandiserDefaultsService,a:Awaited<ReturnType<typeof r5RoleFixture>>,b:Awaited<ReturnType<typeof r5RoleFixture>>,other:Awaited<ReturnType<typeof r5RoleFixture>>;
 const current=async(code='PD')=>(await defaults.selected(f.root,{codes:[code]})).items[0]!;
 const save=async(ids:string[],mode:'append'|'replace'='replace',code='PD')=>{const before=await current(code);return defaults.save(f.root,{customers:[{code,expectedVersion:before.version}],primaryMerchandiserId:f.people.merchandiser!.actorId,secondaryMerchandiserIds:ids,mode},randomUUID());};
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);defaults=new CustomerMerchandiserDefaultsService(f.db);a=await r5RoleFixture(f.db,f.access,f.root,'order_merchandiser');b=await r5RoleFixture(f.db,f.access,f.root,'order_merchandiser');other=await r5RoleFixture(f.db,f.access,f.root,'order_merchandiser');
  for(let i=1;i<=31;i++)await f.db.query("INSERT INTO digital_production_customers(code,name,product_groups,enabled) VALUES($1,$2,ARRAY['男装'],true)",['TEST-R5-'+String(i).padStart(3,'0'),'TEST R5 customer '+i]);
 });
 afterAll(async()=>{await f?.dispose();});
 it('counts/searches the complete matching set and reads selected IDs independently of the current15 rows',async()=>{
  const first=await defaults.list(f.root,{q:'TEST-R5-',page:1}),last=await defaults.list(f.root,{q:'TEST-R5-',page:3});
  expect(first).toMatchObject({page:1,pageSize:15,totalCount:31});expect(first.items).toHaveLength(15);expect(last.items).toHaveLength(1);
  const selected=await defaults.selected(f.root,{codes:[first.items[0]!.code,last.items[0]!.code]});expect(selected.items.map(row=>row.code)).toEqual(['TEST-R5-001','TEST-R5-031']);
 });
 it('saves both secondary people once across pages and preserves append versus replace',async()=>{
  const customers=(await defaults.selected(f.root,{codes:['TEST-R5-001','TEST-R5-031']})).items,key=randomUUID(),body={customers:customers.map(row=>({code:row.code,expectedVersion:row.version})),primaryMerchandiserId:f.people.merchandiser!.actorId,secondaryMerchandiserIds:[a.actor.actorId,b.actor.actorId],mode:'replace'};
  const first=await defaults.save(f.root,body,key);expect(first.existingOrdersChanged).toBe(0);expect(first.items.every(row=>row.secondary.map(p=>p.id).join(',')===[a.actor.actorId,b.actor.actorId].join(','))).toBe(true);
  expect(await defaults.save(f.root,body,key)).toEqual(first);expect((await current('TEST-R5-001')).version).toBe(1);
  await save([other.actor.actorId],'append','TEST-R5-001');expect((await current('TEST-R5-001')).secondary.map(p=>p.id)).toEqual([a.actor.actorId,b.actor.actorId,other.actor.actorId]);
  await save([b.actor.actorId],'replace','TEST-R5-001');expect((await current('TEST-R5-001')).secondary.map(p=>p.id)).toEqual([b.actor.actorId]);
 });
 it('rejects duplicate primary/secondary and stale batch contents atomically without overwriting the other customer',async()=>{
  const old=await current('TEST-R5-001'),untouched=await current('TEST-R5-031'),primary=f.people.merchandiser!.actorId;
  await save([a.actor.actorId],'append','TEST-R5-001');
  await expect(defaults.save(f.root,{customers:[{code:old.code,expectedVersion:old.version},{code:untouched.code,expectedVersion:untouched.version}],primaryMerchandiserId:primary,secondaryMerchandiserIds:[],mode:'replace'},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect(await current('TEST-R5-031')).toEqual(untouched);
  expect(()=>defaults.save(f.root,{customers:[{code:'PD',expectedVersion:0}],primaryMerchandiserId:primary,secondaryMerchandiserIds:[primary],mode:'replace'},randomUUID())).toThrow('主副跟单');
 });
 it('copies every secondary to a new native order once and leaves earlier orders unchanged after defaults change',async()=>{
  await save([a.actor.actorId,b.actor.actorId]);const identity=new DigitalProductionIdentityService(f.db,true),designer=f.people['sample-designer']!;
  const create=async()=>{const style='TEST-R5-SECONDARY-'+randomUUID();return identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:beijingCalendarDate(businessNow()),lines:[{formalPoNo:style,color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:1}]}]}),randomUUID());};
  const first=await create(),read=async(id:string)=>(await f.db.query('SELECT user_id FROM digital_order_secondary_merchandisers WHERE production_order_id=$1 ORDER BY position',[id])).rows.map(row=>row.user_id);
  expect((await identity.slaPlan(f.root,first.productionOrderId)).status).toBe('planned');
  expect(await read(first.productionOrderId)).toEqual([a.actor.actorId,b.actor.actorId]);await save([b.actor.actorId]);const second=await create();expect(await read(second.productionOrderId)).toEqual([b.actor.actorId]);expect(await read(first.productionOrderId)).toEqual([a.actor.actorId,b.actor.actorId]);
 });
 it('inherits all secondary users into the real external case, named contract todos and original return permission without main editing rights',async()=>{
  await save([a.actor.actorId,b.actor.actorId]);const todos=new TodoService(f.db),projection=new TodoProjectionService(todos),sourcing=new SourcingService(f.db,undefined,undefined,projection,f.contracts),scene=await f.scene('2026-11-01T00:00:00Z');
  await f.runtime.run(scene,f.root,async()=>{
   const ready=await f.bulkReady('无',undefined,1,sourcing),ids=(await f.db.query('SELECT sourcing_additional_merchandiser_ids($1) AS ids',[ready.caseId])).rows[0].ids;
   expect(ids).toEqual([a.actor.actorId,b.actor.actorId]);
   const recipients=(await f.db.query("SELECT DISTINCT recipient_user_id FROM rework_todos WHERE entity_id=$1 AND category='sourcing_contract_return'",[ready.caseId])).rows.map(row=>row.recipient_user_id);
   expect(new Set(recipients)).toEqual(new Set([f.people.merchandiser!.actorId,a.actor.actorId,b.actor.actorId]));
   const returns=new SourcingContractReturnService(f.db,undefined,projection),actor=(person:TrustedActorContext)=>({...person,authorizationCapability:'sourcing:view'});
   expect((await returns.get(actor(a.actor),ready.caseId)).canUpload).toBe(true);expect((await returns.get(actor(b.actor),ready.caseId)).canUpload).toBe(true);expect((await returns.get(actor(other.actor),ready.caseId)).canUpload).toBe(false);
   for(const person of [a.actor,b.actor]){expect((await f.contracts.getCurrent({...person,authorizationCapability:'supplier_contract_data:read'},ready.caseId)).item).not.toBeNull();const image=await f.image(person);await expect(sourcing.supplementImages({...person,authorizationCapability:'sourcing:attachments:supplement'},ready.caseId,{attachmentIds:[image]},randomUUID())).rejects.toMatchObject({statusCode:403});}
   const firstFile=await f.image(a.actor),secondFile=await f.image(b.actor),first=await returns.submit({...a.actor,authorizationCapability:'sourcing:contract:record'},ready.caseId,[firstFile],randomUUID()),second=await returns.submit({...b.actor,authorizationCapability:'sourcing:contract:record'},ready.caseId,[secondFile],randomUUID());
   expect(second.contractReturnedAt).toEqual(first.contractReturnedAt);expect(second.uploadedFileCount).toBe(2);
  });
 });
 it('keeps Root/director-only default writes, requires primary and rechecks withdrawn or disabled staff',async()=>{
  const before=await current(),body={customers:[{code:'PD',expectedVersion:before.version}],primaryMerchandiserId:f.people.merchandiser!.actorId,secondaryMerchandiserIds:[],mode:'replace'};
  await expect(defaults.save(f.people.owner!,body,randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(new DigitalProductionAccessService(f.db).setCustomerDefault(f.root,'PD',null)).rejects.toMatchObject({statusCode:409});
  await f.access.revokeRole(f.root,a.assignmentId,'TEST revoke dedicated secondary');
  await expect(save([a.actor.actorId])).rejects.toMatchObject({statusCode:409});
  await expect(save([other.actor.actorId],'append')).rejects.toMatchObject({statusCode:409});
  const corp=(await f.db.query("SELECT dingtalk_corp_id FROM access_security_policy WHERE policy_key='primary'")).rows[0].dingtalk_corp_id;
  const provider=new OfficialDingTalkProvider({corpId:corp,h5AppKey:'TEST',h5AppSecret:'TEST',webClientId:'TEST',webClientSecret:'TEST',qrRedirectUri:'https://test.invalid'},async()=>{throw Error('This native disable command must not contact the external directory');});
  await new EmployeeAccessService(f.db,corp,f.access,new PostgresAuthStore(f.db,corp),provider,{enabled:false,dingtalkUserId:undefined,secret:undefined},undefined).disableAccess(f.root,b.actor.actorId,'TEST disable dedicated secondary');await expect(save([b.actor.actorId])).rejects.toMatchObject({statusCode:409});
  expect(await current()).toEqual(before);
 });
});
