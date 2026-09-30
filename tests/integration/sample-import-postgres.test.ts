import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {SampleImportService,validateSampleImport} from '../../apps/api/src/samples/sample-import-service.js';
import {SampleDisposalService} from '../../apps/api/src/samples/sample-disposal-service.js';
import {SampleWorkflowService} from '../../apps/api/src/samples/sample-workflow-service.js';
import {inventorySampleSource,sampleSourceHash} from '../../apps/api/src/samples/sample-migration.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {RootAwareTodoProjectionService} from '../../apps/api/src/todos/root-aware-projection-service.js';
import {SampleCapabilitySchema,type SampleImportPlan} from '../../packages/contracts/src/index.js';
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)('sample final import, exact reconciliation and cutover',()=>{
 const schema=ownedPostgresSchema("sample"),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const root=randomUUID(),designer=randomUUID(),other=randomUUID(),administrative=randomUUID(),peer=randomUUID(),finance=randomUUID();
 const actor=(role:string,id:string)=>({actorId:id,actorRoles:[role],authorizationCapability:'sample:view_basic',authorizationCapabilities:[...SampleCapabilitySchema.options,'todo:view'],requestId:`sample-test-${randomUUID()}`});
 const owner=()=>actor('root_superuser',root),projection=new RootAwareTodoProjectionService(new TodoService(db)),disposal=new SampleDisposalService(db,'sample-handoff-corp',projection),service=new SampleImportService(db,'sample-handoff-corp',disposal);
 const setUserEnabledAsRoot=async(id:string,enabled:boolean)=>{
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT set_config('dx_rework.employee_access_actor_id',$1,true)",[root]);
   await client.query('UPDATE app_users SET enabled=$2 WHERE id=$1',[id,enabled]);
   await client.query('COMMIT');
  }catch(error){
   await client.query('ROLLBACK');
   throw error;
  }finally{client.release();}
 };
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
  
 },60000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('imports twice, applies final return delta, checks all five totals and guards cutover against later writes',async()=>{
  const attachmentId=randomUUID(),key='daxing-sample/receipt/test.png';await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'test.png','image/png',10,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`sample-test/${attachmentId}`,'a'.repeat(64),root]);
  const history={id:'h1',borrower:'同名员工',department:'设计',purpose:'采购后直接开发/打板',borrowedAt:'2020-01-01T01:00:00.525Z',returnedAt:null as string|null};
  const original={id:'legacy-1',sampleCode:'YI-202001-0001',status:'BORROWED',brand:'测试',styleName:'样衣',color:'蓝',department:'设计',purchaseDate:'2020-01-01',purchasePrice:'12.34',purchaser:'同名员工',currentHolder:'同名员工' as string|null,receiptImages:[{objectKey:key}],borrowHistory:[history],disposalHistory:[],createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T01:00:00Z'};
  const source={samples:[original],logs:[],borrowRequests:[],updatedAt:'2020-01-01T01:00:00Z'};
  const plan:SampleImportPlan={sourceHash:sampleSourceHash(source),reason:'固定验收映射',objects:[{objectKey:key,attachmentId,sha256:'a'.repeat(64),sizeBytes:10}],decisions:inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'固定身份映射已核实'})),items:[{legacyId:original.id,sourceHash:sampleSourceHash(original),status:'borrowed',purchaserUserId:designer,holderUserId:designer,holderName:'同名员工',borrowedAt:history.borrowedAt,purpose:history.purpose,storageLocation:null,archivedFromStatus:null,archiveReason:null,normalizationReason:'原始借出记录保留',custody:[{legacyId:history.id,sourceHash:sampleSourceHash(history),holderUserId:designer,holderName:history.borrower,department:history.department,purpose:history.purpose,borrowedAt:history.borrowedAt,returnedAt:null,disposedAt:null,initialCustody:true,requestedBy:designer,confirmedBy:null}],requests:[]}]};
  await expect(service.import(actor('system_admin',other),source,plan)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(service.import(owner(),source,{...plan,objects:[{...plan.objects[0],sha256:'b'.repeat(64)}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await setUserEnabledAsRoot(designer,false);await expect(service.import(owner(),source,plan)).rejects.toMatchObject({code:'VALIDATION_ERROR'});await setUserEnabledAsRoot(designer,true);
  const first=await service.import(owner(),source,plan);expect(first.passed).toBe(true);expect(first.amounts.purchaseTotal).toEqual({expected:'12.34',actual:'12.34'});expect(Object.keys(first.amounts)).toHaveLength(5);
  expect((await db.query("SELECT borrowed_at FROM sample_custody_records WHERE legacy_id='h1'")).rows[0].borrowed_at.toISOString()).toBe('2020-01-01T01:00:00.525Z');
  const enable={action:'enable',reconciliationId:first.reconciliationId,sourceHash:plan.sourceHash,sourceFreezeEvidence:'isolated source fixture frozen',backupRestoreEvidence:'isolated backup fixture',businessUatEvidence:'fixed business fixtures',reason:'test'};
  await expect(service.cutover(owner(),enable)).rejects.toMatchObject({code:'CONFLICT'});
  const second=await service.import(owner(),source,plan);expect(second.passed).toBe(true);expect(Number((await db.query('SELECT count(*) n FROM sample_items')).rows[0].n)).toBe(1);expect(Number((await db.query('SELECT count(*) n FROM sample_custody_records')).rows[0].n)).toBe(1);
  history.returnedAt='2020-01-02T01:00:00.123Z';original.status='IN_STOCK';original.currentHolder=null;source.updatedAt='2020-01-02T01:00:00Z';
  const pendingRaw={id:'borrow-request-2',type:'BORROW',requestedBy:'历史申请人姓名',borrower:'历史借用人姓名',department:'设计',purpose:'迁移在途借用'};
  const secondOriginal={...original,id:'legacy-2',sampleCode:'YI-202001-0002',status:'PENDING_BORROW',borrowHistory:[],pendingTask:pendingRaw};source.samples.push(secondOriginal);
  plan.items.push({legacyId:secondOriginal.id,sourceHash:sampleSourceHash(secondOriginal),status:'borrow_pending',purchaserUserId:designer,holderUserId:null,holderName:null,borrowedAt:null,purpose:null,storageLocation:'B01',archivedFromStatus:null,archiveReason:null,normalizationReason:'原在途借用重建',custody:[],requests:[{legacyId:pendingRaw.id,sourceHash:sampleSourceHash(pendingRaw),type:'borrow',status:'pending',fromStatus:'in_stock',requestedBy:designer,requestedFor:other,purpose:pendingRaw.purpose,reason:'',createdAt:'2020-01-02T01:00:00Z',resolvedBy:null,resolvedAt:null,resolutionReason:null,disposal:null,proofObjectKeys:[]}]});
  plan.sourceHash=sampleSourceHash(source);const item=plan.items[0]!;item.sourceHash=sampleSourceHash(original);item.status='in_stock';item.holderUserId=null;item.holderName=null;item.borrowedAt=null;item.purpose=null;item.storageLocation='A01';item.custody[0]!.sourceHash=sampleSourceHash(history);item.custody[0]!.returnedAt=history.returnedAt;plan.decisions=inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'固定身份映射已核实'}));
  await service.import(owner(),source,plan);const final=await service.import(owner(),source,plan);expect(final.passed).toBe(true);expect(final.states).toEqual({in_stock:1,borrow_pending:1});
  expect((await db.query("SELECT returned_at FROM sample_custody_records WHERE legacy_id='h1'")).rows[0].returned_at.toISOString()).toBe('2020-01-02T01:00:00.123Z');
  expect((await db.query("SELECT requested_by_name,requested_for_name FROM sample_workflow_requests WHERE legacy_id='borrow-request-2'")).rows[0]).toMatchObject({requested_by_name:'历史申请人姓名',requested_for_name:'历史借用人姓名'});
  await expect(service.cutover(owner(),{...enable,reconciliationId:second.reconciliationId,sourceHash:second.sourceHash})).rejects.toMatchObject({code:'CONFLICT'});
  await service.cutover(owner(),{...enable,reconciliationId:final.reconciliationId,sourceHash:final.sourceHash});
  await expect(service.import(owner(),source,plan)).rejects.toMatchObject({code:'CONFLICT'});
  const id=(await db.query("SELECT sample_id FROM sample_items WHERE external_id='legacy-1'")).rows[0].sample_id,workflow=new SampleWorkflowService(db,'sample-handoff-corp','https://example.test/',projection);await workflow.borrow(actor('sample_designer',designer),id,{version:2,purpose:'迁移后正常借出'},randomUUID());
  await service.cutover(owner(),{action:'disable',reason:'测试回退'});await expect(service.cutover(owner(),{...enable,reconciliationId:final.reconciliationId,sourceHash:final.sourceHash})).rejects.toMatchObject({code:'CONFLICT'});
  expect(()=>validateSampleImport(source,{...plan,items:[{...item,holderUserId:other}]})).toThrow();
 });
});
