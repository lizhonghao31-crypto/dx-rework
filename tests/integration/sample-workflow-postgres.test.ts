import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {SampleCreateService} from '../../apps/api/src/samples/sample-create-service.js';
import {SampleWorkflowService} from '../../apps/api/src/samples/sample-workflow-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {RootAwareTodoProjectionService} from '../../apps/api/src/todos/root-aware-projection-service.js';
import {SampleCapabilitySchema} from '../../packages/contracts/src/samples.js';

const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)('sample handoff and real global todo lifecycle',()=>{
 const schema=`sample_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const root=randomUUID(),designer=randomUUID(),other=randomUUID(),administrative=randomUUID(),peer=randomUUID(),finance=randomUUID();
 const actor=(role:string,id:string)=>({actorId:id,actorRoles:[role],authorizationCapability:'sample:view_basic',authorizationCapabilities:[...SampleCapabilitySchema.options,'todo:view'],requestId:`sample-test-${randomUUID()}`});
 const owner=()=>actor('root_superuser',root),user=()=>actor('sample_designer',designer),clerk=()=>actor('sample_administrative',administrative);
 const todos=new TodoService(db),projection=new RootAwareTodoProjectionService(todos),creation=new SampleCreateService(db,'sample-handoff-corp');
 let token='';
 const service=new SampleWorkflowService(db,'sample-handoff-corp','https://example.test/platform/',projection,undefined,undefined,async text=>{token=new URL(text).hash.slice(1);return '<svg xmlns="http://www.w3.org/2000/svg"/>';});
 const attachment=async(by:string)=>{const id=randomUUID();await db.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
  VALUES($1,$2,'test.png','image/png',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,[id,`sample-test/${id}`,'a'.repeat(64),by]);return id;};
 const sample=async()=>{const result=await creation.create(actor('sample_finance',finance),{items:[{brand:'测试',styleName:'样衣',color:'蓝',department:'设计',purchaseDate:'2020-01-01',purchasePrice:'80.00',purchaserUserId:designer,receiptAttachmentIds:[await attachment(finance)]}]},randomUUID(),false);return result.items[0]!.sampleId;};
 const photo=()=>attachment(designer);
 const row=async(id:string)=>(await db.query('SELECT * FROM sample_items WHERE sample_id=$1',[id])).rows[0];
 const issue=async(id:string,version:number)=>{await service.issueQr(user(),id,{version},randomUUID());return token;};
 const indicator=async(id:string)=>(await todos.countIndicatorForActor({...actor('sample_administrative',id),authorizationCapability:'todo:view'})).pendingCount;
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const folder=new URL('../../apps/api/migrations/',import.meta.url);
  for(const name of (await readdir(folder)).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort()){
   const sql=await readFile(new URL(name,folder),'utf8');await db.query('BEGIN');await db.query(sql);
   await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[name.slice(0,-4),createHash('sha256').update(sql).digest('hex')]);await db.query('COMMIT');
  }
  for(const id of [root,designer,other,administrative,peer,finance]){
   await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'同名测试员工',true)",[id]);
   await db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
    VALUES($1,$2,'dingtalk','sample-handoff-corp',$3,$3,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),id,`sample-${id}`]);
  }
  // Controlled fixture assignments before organization policy activation, as in platform access tests.
  for(const [id,role] of [[designer,'sample_designer'],[other,'sample_designer'],[administrative,'sample_administrative'],[peer,'sample_administrative'],[finance,'sample_finance']] as const){
   await db.query('INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,\'fixture\')',[randomUUID(),id,role,root]);
  }
  await db.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','sample-handoff-corp')");
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'sample-handoff-corp')",[root,`sample-${root}`]);
  await db.query("UPDATE sample_write_control SET enabled=true,changed_by=$1,changed_at=CURRENT_TIMESTAMP,reason='isolated fixture'",[root]);
 },60000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('keeps holder responsible until matching QR, location and real administrative handoff',async()=>{
  const id=await sample();const req=await service.returnRequest(user(),id,{version:1,photoAttachmentIds:[await photo()]},randomUUID());
  expect((await row(id)).holder_user_id).toBe(designer);expect((await row(id)).status).toBe('return_pending');
  expect(await indicator(administrative)).toBe(1);expect(await indicator(peer)).toBe(1);expect(await indicator(root)).toBe(0);
  const pending=await todos.listForActor({...clerk(),authorizationCapability:'todo:view'},{module:'samples'});expect(pending.moduleCounts.samples).toBe(1);expect(pending.todos[0]!.route.routeName).toBe('sample_detail');
  const qr=await issue(id,req.version);
  expect((await service.lookupQr(clerk(),qr)).requestId).toBe(req.requestId);
  await expect(service.confirm(clerk(),id,{version:2,token:qr},randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(service.confirm(actor('sample_finance',finance),id,{version:2,token:qr,storageLocation:'A01'},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  const key=randomUUID(),done=await service.confirm(clerk(),id,{version:2,token:qr,storageLocation:'A01'},key);
  expect(done.status).toBe('in_stock');expect(await service.confirm(clerk(),id,{version:2,token:qr,storageLocation:'A01'},key)).toEqual(done);
  expect(await row(id)).toMatchObject({holder_user_id:null,storage_location:'A01'});expect(await indicator(administrative)).toBe(0);expect(await indicator(peer)).toBe(0);
  await expect(service.lookupQr(clerk(),qr)).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
  expect(Number((await db.query('SELECT count(*) FROM sample_custody_records WHERE sample_id=$1 AND returned_at IS NULL',[id])).rows[0].count)).toBe(0);
  const borrowed=await service.borrow(user(),id,{version:3,purpose:'开发试版',borrowerUserId:other},randomUUID());
  await expect(service.issueQr(actor('sample_designer',other),id,{version:4},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  const borrowQr=await issue(id,borrowed.version);await service.confirm(clerk(),id,{version:4,token:borrowQr},randomUUID());
  expect(await row(id)).toMatchObject({status:'borrowed',holder_user_id:other,storage_location:null,purpose:'开发试版'});
  expect(Number((await db.query('SELECT count(*) FROM sample_custody_records WHERE sample_id=$1',[id])).rows[0].count)).toBe(2);
 });
 it('rejects wrong holders, stale versions, arbitrary tokens and QR from another same-name request',async()=>{
  const a=await sample(),b=await sample();
  await expect(service.returnRequest(actor('sample_designer',other),a,{version:1,photoAttachmentIds:[await attachment(other)]},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(service.borrow(user(),a,{version:1,purpose:'借用'},randomUUID())).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
  await service.returnRequest(user(),a,{version:1,photoAttachmentIds:[await photo()]},randomUUID());await service.returnRequest(user(),b,{version:1,photoAttachmentIds:[await photo()]},randomUUID());
  const qr=await issue(a,2);
  await expect(service.confirm(clerk(),b,{version:2,token:qr,storageLocation:'B01'},randomUUID())).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
  await expect(service.confirm(clerk(),a,{version:1,token:qr,storageLocation:'B01'},randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await db.query("UPDATE sample_handoff_challenges SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE request_id=(SELECT request_id FROM sample_workflow_requests WHERE sample_id=$1 AND status='pending')",[a]);
  await expect(service.confirm(clerk(),a,{version:2,token:qr,storageLocation:'B01'},randomUUID())).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
  await service.cancel(user(),a,{version:2,reason:'暂不归还'},randomUUID());await service.cancel(clerk(),b,{version:2,reason:'实物暂未收到'},randomUUID());
  expect((await row(a)).status).toBe('borrowed');expect((await row(b)).holder_user_id).toBe(designer);expect(await indicator(peer)).toBe(0);
 });
 it('returns per-item batch outcomes and reuses successful items without duplicating custody or todos',async()=>{
  const a=await sample(),b=await sample(),image=await photo(),key=randomUUID();
  const input={items:[{sampleId:a,version:1,photoAttachmentIds:[image]},{sampleId:b,version:99,photoAttachmentIds:[image]}]};
  const first=await service.returnBatch(user(),input,key),second=await service.returnBatch(user(),input,key);
  expect(first.items.map(item=>item.success)).toEqual([true,false]);expect(second).toEqual(first);expect(await indicator(peer)).toBe(1);
  await service.cancel(owner(),a,{version:2,reason:'测试管理员撤销'},randomUUID());expect(await indicator(peer)).toBe(0);
 });
 it('keeps ordinary system_admin denied and invalidates QR after cancellation or regeneration',async()=>{
  const id=await sample();await expect(service.view(actor('system_admin',root),id)).rejects.toMatchObject({code:'FORBIDDEN'});
  await service.returnRequest(user(),id,{version:1,photoAttachmentIds:[await photo()]},randomUUID());const first=await issue(id,2),second=await issue(id,2);
  await expect(service.lookupQr(clerk(),first)).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
  await service.cancel(user(),id,{version:2,reason:'取消归还'},randomUUID());await expect(service.lookupQr(clerk(),second)).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
 });
 it('serializes concurrent administrative confirmations into one custody change',async()=>{
  const id=await sample();await service.returnRequest(user(),id,{version:1,photoAttachmentIds:[await photo()]},randomUUID());const qr=await issue(id,2);
  const results=await Promise.allSettled([
   service.confirm(clerk(),id,{version:2,token:qr,storageLocation:'C01'},randomUUID()),
   service.confirm(actor('sample_administrative',peer),id,{version:2,token:qr,storageLocation:'C01'},randomUUID()),
  ]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect(await row(id)).toMatchObject({status:'in_stock',version:3,holder_user_id:null});
  expect(await indicator(administrative)).toBe(0);expect(await indicator(peer)).toBe(0);
  expect(Number((await db.query("SELECT count(*) FROM operation_events WHERE entity_type='sample' AND entity_id=$1 AND action='sample.return_confirmed'",[id])).rows[0].count)).toBe(1);
 });
});
