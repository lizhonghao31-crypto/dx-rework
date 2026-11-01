import { ownedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {SampleCreateService} from '../../apps/api/src/samples/sample-create-service.js';
import {SampleDisposalService} from '../../apps/api/src/samples/sample-disposal-service.js';
import {SampleReadService} from '../../apps/api/src/samples/sample-read-service.js';
import {SampleAttachmentService} from '../../apps/api/src/samples/sample-attachments.js';
import {SampleWorkflowService} from '../../apps/api/src/samples/sample-workflow-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {RootAwareTodoProjectionService} from '../../apps/api/src/todos/root-aware-projection-service.js';
import {SampleCapabilitySchema} from '../../packages/contracts/src/samples.js';

const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)('sample disposal, private corrections and archive lifecycle',()=>{
 const schema=ownedPostgresSchema("sample"),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const root=randomUUID(),designer=randomUUID(),other=randomUUID(),administrative=randomUUID(),peer=randomUUID(),finance=randomUUID(),approver=randomUUID();
 const actor=(role:string,id:string)=>({actorId:id,actorRoles:[role],authorizationCapability:'sample:view_basic',authorizationCapabilities:[...SampleCapabilitySchema.options,'todo:view'],requestId:`sample-test-${randomUUID()}`});
 const owner=()=>actor('root_superuser',root),user=()=>actor('sample_designer',designer),clerk=()=>actor('sample_administrative',administrative);
 const todos=new TodoService(db),projection=new RootAwareTodoProjectionService(todos),creation=new SampleCreateService(db,'sample-handoff-corp');
 let token='';
 const service=new SampleWorkflowService(db,'sample-handoff-corp','https://example.test/platform/',projection,undefined,undefined,async text=>{token=new URL(text).hash.slice(1);return '<svg xmlns="http://www.w3.org/2000/svg"/>';});
 const attachment=async(by:string)=>{const id=randomUUID();await db.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
  VALUES($1,$2,'test.png','image/png',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,[id,`sample-test/${id}`,'a'.repeat(64),by]);return id;};
 const sample=async()=>{const result=await creation.create(actor('sample_finance',finance),{items:[{brand:'测试',styleName:'样衣',color:'蓝',department:'设计',purchaseDate:'2020-01-01',purchasePrice:'80.00',purchaserUserId:designer,receiptAttachmentIds:[await attachment(finance)]}]},randomUUID(),false);return result.items[0]!.sampleId;};
 const disposal=new SampleDisposalService(db,'sample-handoff-corp',projection),read=new SampleReadService(db),files=new SampleAttachmentService(db);
 const photo=()=>attachment(designer);
 const row=async(id:string)=>(await db.query('SELECT * FROM sample_items WHERE sample_id=$1',[id])).rows[0];
 const issue=async(id:string,version:number)=>{await service.issueQr(user(),id,{version},randomUUID());return token;};

 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const folder=new URL('../../apps/api/migrations/',import.meta.url);
  for(const name of (await readdir(folder)).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort()){
   const sql=await readFile(new URL(name,folder),'utf8');await db.query('BEGIN');await db.query(sql);
   await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[name.slice(0,-4),createHash('sha256').update(sql).digest('hex')]);await db.query('COMMIT');
  }
  for(const id of [root,designer,other,administrative,peer,finance,approver]){
   await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'同名测试员工',true)",[id]);
   await db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
    VALUES($1,$2,'dingtalk','sample-handoff-corp',$3,$3,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),id,`sample-${id}`]);
  }
  // Controlled fixture assignments before organization policy activation, as in platform access tests.
  for(const [id,role] of [[designer,'sample_designer'],[other,'sample_designer'],[administrative,'sample_administrative'],[peer,'sample_administrative'],[finance,'sample_finance'],[other,'owner_group'],[other,'sample_approver'],[approver,'sample_approver']] as const){
   await db.query('INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,\'fixture\')',[randomUUID(),id,role,root]);
  }
  await db.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','sample-handoff-corp')");
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'sample-handoff-corp')",[root,`sample-${root}`]);
  await db.query("UPDATE sample_write_control SET enabled=true,changed_by=$1,changed_at=CURRENT_TIMESTAMP,reason='isolated fixture'",[root]);
 },60000);
 afterAll(async()=>{await db.end();await dropOwnedPostgresSchema(admin,schema);await admin.end();});
 const stock=async()=>{const id=await sample();await service.returnRequest(user(),id,{version:1,photoAttachmentIds:[await photo()]},randomUUID());await service.confirm(clerk(),id,{version:2,token:await issue(id,2),storageLocation:'A01'},randomUUID());return id;};
 it('only owner approves sale and reject restores actual borrowed responsibility',async()=>{
  const id=await stock();await disposal.request(clerk(),id,{version:3,type:'sale',recipient:'买家',amount:'35.10',proofAttachmentIds:[await attachment(administrative)]},randomUUID());
  await expect(disposal.decide(clerk(),id,{version:4,decision:'approve',finalAmount:'35.10'},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await disposal.decide(actor('owner_group',other),id,{version:4,decision:'approve',finalAmount:'30.25'},randomUUID());expect((await row(id)).status).toBe('sold');
  const b=await sample();await disposal.request(clerk(),b,{version:1,type:'scrap',reason:'破损',proofAttachmentIds:[await attachment(administrative)]},randomUUID());
  await disposal.decide(owner(),b,{version:2,decision:'reject',reason:'仍可使用'},randomUUID());expect(await row(b)).toMatchObject({status:'borrowed',holder_user_id:designer});
 });
 it('retains loss holder and excludes unpaid recovery until administrative evidence closes it',async()=>{
  const id=await sample();await disposal.request(clerk(),id,{version:1,type:'loss',reason:'遗失',responsibleUserId:designer},randomUUID());
  expect((await disposal.actions(clerk(),id)).pending).not.toHaveProperty('proposedAmount');
  await disposal.decide(owner(),id,{version:2,decision:'approve',finalAmount:'22.50'},randomUUID());expect(await row(id)).toMatchObject({status:'loss_payment_pending',holder_user_id:designer});
  expect((await disposal.actions(clerk(),id)).pending?.finalAmount).toBe('22.50');expect((await disposal.actions(user(),id)).pending).not.toHaveProperty('finalAmount');
  await expect(disposal.closeLoss(clerk(),id,{version:3,proofAttachmentIds:[]},randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  const key=randomUUID(),input={version:3,proofAttachmentIds:[await attachment(administrative)]};await disposal.closeLoss(clerk(),id,input,key);await disposal.closeLoss(clerk(),id,input,key);
  expect(await row(id)).toMatchObject({status:'lost',holder_user_id:null});const custody=(await db.query('SELECT returned_at,disposed_at FROM sample_custody_records WHERE sample_id=$1',[id])).rows[0];expect(custody.returned_at).toBeNull();expect(custody.disposed_at).not.toBeNull();
  expect((await db.query('SELECT paid_by FROM sample_disposals WHERE sample_id=$1',[id])).rows[0].paid_by).toBe(administrative);
 });
 it('keeps corrected receipts and amounts private while preserving old receipt audit',async()=>{
  const id=await sample(),receipt=await attachment(root);expect(await disposal.actions(owner(),id)).toMatchObject({canCorrectFinance:true,canReplaceReceipts:true});const old=(await files.list(owner(),id)).attachments.find(f=>f.purpose==='purchase_receipt')!.attachmentId;
  await expect(disposal.correctFinance(clerk(),id,{version:1,purchasePrice:'90.35',receiptAttachmentIds:[receipt],receiptMode:'replace',reason:'核对原始票据'},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await disposal.correctFinance(owner(),id,{version:1,purchasePrice:'90.35',receiptAttachmentIds:[receipt],receiptMode:'replace',reason:'核对原始票据'},randomUUID());
  expect((await files.list(owner(),id)).attachments.map(f=>f.attachmentId)).toContain(receipt);expect((await files.list(owner(),id)).attachments.map(f=>f.attachmentId)).not.toContain(old);
  expect((await files.list(clerk(),id)).attachments).toEqual([]);expect(await files.canDownloadForSample(clerk(),id,old)).toBe(false);expect(await files.canDownloadForSample(actor('sample_finance',finance),id,old)).toBe(true);await expect(disposal.financialHistory(clerk(),id,1)).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await disposal.financialHistory(owner(),id,1)).items.some(e=>e.after.purchasePrice==='90.35')).toBe(true);
  const publicAudit=(await db.query("SELECT before_state,after_state FROM operation_events WHERE entity_id=$1 AND action='sample.finance_corrected'",[id])).rows;expect(JSON.stringify(publicAudit)).not.toContain('90.35');expect(JSON.stringify(publicAudit)).not.toContain(receipt);
 });
 it('finance edits basic data and appends receipts with private immutable audit, idempotency and boundaries',async()=>{
  const id=await sample(),f=actor('sample_finance',finance),receipt=await attachment(finance);
  const original=(await files.list(f,id)).attachments.find(a=>a.purpose==='purchase_receipt')!.attachmentId;
  expect(await disposal.actions(f,id)).toMatchObject({canUpdateBasic:true,canCorrectFinance:true,canReplaceReceipts:false,canApprove:false,canArchive:false});
  const basic={version:1,brand:'修改品牌',styleName:'新名称',color:'黑',department:'设计',styleNo:'S1',category:'上衣',size:'M',remark:'核对资料',reason:'核对样衣'};
  await disposal.updateBasic(f,id,basic,randomUUID());
  const key=randomUUID(),input={version:2,purchasePrice:'91.25',receiptAttachmentIds:[receipt],reason:'补充采购小票'};
  await disposal.correctFinance(f,id,input,key);await disposal.correctFinance(f,id,input,key);
  expect((await files.list(f,id)).attachments.map(a=>a.attachmentId).sort()).toEqual([original,receipt].sort());
  expect(await row(id)).toMatchObject({version:3,brand:'修改品牌',holder_user_id:designer,status:'borrowed'});
  const audit=await disposal.financialHistory(f,id,1),change=audit.items.filter(a=>a.action==='sample.finance_corrected');
  expect(change).toHaveLength(1);expect(change[0]).toMatchObject({reason:input.reason,before:{purchasePrice:'80.00',receiptAttachmentIds:[original]},after:{purchasePrice:'91.25'}});
  expect(change[0]!.after.receiptAttachmentIds).toEqual(expect.arrayContaining([original,receipt]));
  const binding=(await db.query('SELECT bound_by,bound_at FROM sample_attachment_bindings WHERE sample_id=$1 AND attachment_id=$2',[id,receipt])).rows[0];expect(binding.bound_by).toBe(finance);expect(binding.bound_at).toBeTruthy();
  const summary=(await db.query("SELECT before_state,after_state FROM operation_events WHERE entity_id=$1 AND action='sample.finance_corrected'",[id])).rows;
  expect(JSON.stringify(summary)).not.toContain(receipt);expect(JSON.stringify(summary)).not.toContain('91.25');
  await expect(disposal.correctFinance(f,id,{...input,version:3,receiptMode:'replace'},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(disposal.correctFinance(f,id,{...input,version:3,receiptAttachmentIds:[await attachment(other)]},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(disposal.correctFinance(f,id,{...input,version:3,reason:''},randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(disposal.correctFinance(f,id,input,randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  for(const role of ['sample_designer','sample_administrative','sample_approver','owner_group','system_admin'])await expect(disposal.correctFinance(actor(role,other),id,{...input,version:3},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await disposal.correctFinance(f,id,{version:3,purchasePrice:'92.00',receiptAttachmentIds:[],reason:'仅更正采购价'},randomUUID());
  expect((await files.list(f,id)).attachments).toHaveLength(2);
  await disposal.archive(owner(),id,{version:4,reason:'暂存'},randomUUID());
  await expect(disposal.correctFinance(f,id,{...input,version:5},randomUUID())).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
 });
 it('routes disposal approval only to active owner roles after the standalone approver role is retired',async()=>{
  const id=await sample();await disposal.request(clerk(),id,{version:1,type:'scrap',reason:'破损',proofAttachmentIds:[await attachment(administrative)]},randomUUID());
  const tasks=(await db.query("SELECT recipient_user_id,status FROM rework_todos WHERE entity_id=$1 AND category='sample_disposal_approval'",[id])).rows;
  expect(tasks).toHaveLength(1);expect(tasks.map(t=>t.recipient_user_id)).toEqual([other]);
  await disposal.decide(actor('owner_group',other),id,{version:2,decision:'approve'},randomUUID());
  expect((await row(id)).status).toBe('scrapped');
  expect((await db.query("SELECT status FROM rework_todos WHERE entity_id=$1",[id])).rows.every(t=>t.status==='completed')).toBe(true);
 });
 it('archive cancels tasks and QR; restore reopens exact pending work with a new task generation',async()=>{
  const id=await sample();await service.returnRequest(user(),id,{version:1,photoAttachmentIds:[await photo()]},randomUUID());const qr=await issue(id,2);
  await disposal.archive(owner(),id,{version:2,reason:'临时归档'},randomUUID());await expect(service.lookupQr(clerk(),qr)).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});await expect(read.detail(user(),id)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await disposal.archived(owner(),1)).items.some(x=>x.sampleId===id)).toBe(true);await disposal.restore(owner(),id,{version:3,reason:'恢复继续归还'},randomUUID());expect(await row(id)).toMatchObject({status:'return_pending',holder_user_id:designer});
  const tasks=(await db.query("SELECT status,count(*)::int n FROM rework_todos WHERE entity_id=$1 GROUP BY status",[id])).rows;expect(tasks).toEqual(expect.arrayContaining([{status:'cancelled',n:2},{status:'pending',n:2}]));
  await service.confirm(clerk(),id,{version:4,token:await issue(id,4),storageLocation:'恢复库位'},randomUUID());expect((await row(id)).status).toBe('in_stock');
 });
 it('covers gifts, both scrap origins and every business role denial',async()=>{
  for(const role of ['sample_designer','sample_finance','system_admin'])await expect(disposal.request(actor(role,designer),await sample(),{version:1,type:'loss',reason:'测试越权',responsibleUserId:designer},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  const borrowed=await sample();await expect(disposal.request(clerk(),borrowed,{version:1,type:'gift',recipient:'接收人',proofAttachmentIds:[await attachment(administrative)]},randomUUID())).rejects.toMatchObject({code:'INVALID_STATE_TRANSITION'});
  for(const type of ['gift','scrap'] as const){const id=await stock();await disposal.request(clerk(),id,{version:3,type,...(type==='gift'?{recipient:'接收人'}:{reason:'不可使用'}),proofAttachmentIds:[await attachment(administrative)]},randomUUID());await disposal.decide(owner(),id,{version:4,decision:'approve'},randomUUID());expect((await row(id)).status).toBe(type==='gift'?'gifted':'scrapped');}
  await disposal.request(clerk(),borrowed,{version:1,type:'scrap',reason:'不可使用',proofAttachmentIds:[await attachment(administrative)]},randomUUID());await disposal.decide(owner(),borrowed,{version:2,decision:'approve'},randomUUID());expect((await row(borrowed)).holder_user_id).toBeNull();
 });
 it('concurrent owner approvals allow one terminal disposal and one version conflict',async()=>{
  const id=await stock();await disposal.request(clerk(),id,{version:3,type:'gift',recipient:'接收人',proofAttachmentIds:[await attachment(administrative)]},randomUUID());
  const results=await Promise.allSettled([disposal.decide(owner(),id,{version:4,decision:'approve'},randomUUID()),disposal.decide(actor('owner_group',other),id,{version:4,decision:'approve'},randomUUID())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await row(id)).version).toBe(5);
 });

});