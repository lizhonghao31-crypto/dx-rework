import {AuthService} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {businessActor} from '../../apps/api/src/access/business-authority.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {registerSourcingRoutes} from '../../apps/api/src/sourcing/sourcing-routes.js';
import {readSeenSourcingOwnerReview,seenSourcingOwnerDecision} from '../helpers/sourcing-owner-approval-fixture.js';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import Fastify from 'fastify';
import type {PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {sourcingSlaEvidence} from '../../apps/api/src/production-platform/sourcing-sla-evidence.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {IdempotencyService} from '../../apps/api/src/tools/repositories.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('digital owner approval requires real handling readiness',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);});
 afterAll(async()=>{await f?.dispose();});
 const signedIdentities=()=>{
  const root=new RootAuthority(f.db,'anchor-test','uat-root'),secret='TEST native seen owner version '.repeat(3);
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,'anchor-test',secret),new PostgresAuthStore(f.db,'anchor-test','uat-root'),'anchor-test',3600000,secret);
  const sign=(alias:string)=>auth.loginMobile(mintAcceptanceLoginCode(alias,secret));
  return {root,auth,sign};
 };
 const pendingApproval=async(service:SourcingService)=>{
  const merch=f.people.merchandiser!,manager=f.people['production-management']!,price=[{position:1,unitPrice:'3.25'}];
  const created=await service.createCase(merch,{gender:'男装',styleName:'TEST老板所见版本',estimatedCutPieceSendDate:'2026-12-01',deliveryDate:'2027-01-10',
   daxingUnitPrice:'5',attachmentIds:[await f.image(merch)],lineItems:[{styleNo:'TEST-OWNER-'+randomUUID(),color:'黑',quantity:10}]},randomUUID());
  const id=created.value.sourcingCaseId;
  const craft=(await f.access.ensureCrafts(manager,{craftNames:['TEST车缝']}))[0]!;
  await service.quoteIePrice(f.people.ie!,id,{linePrices:price},randomUUID());
  await service.recordManagementDecision(manager,id,{linePrices:price,craftIds:[craft.craftId],supplierId:f.supplierId,cuttingProcess:'in_house'},randomUUID());
  return id;
 };
 const competingWrites=async<T>(root:RootAuthority,first:(service:SourcingService)=>Promise<T>,second:()=>Promise<unknown>)=>{
  const holding=new SourcingService(f.db,undefined,undefined,undefined,f.contracts,undefined,root);
  const locking=holding as unknown as {lockOwnerApprovalCase(client:PoolClient,id:string):Promise<void>};
  const acquire=locking.lockOwnerApprovalCase.bind(holding);
  const locked=Promise.withResolvers<number>(),release=Promise.withResolvers<void>();
  const barrier=vi.spyOn(locking,'lockOwnerApprovalCase').mockImplementation(async(client,id)=>{
   await acquire(client,id);
   locked.resolve((await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
   await release.promise;
  });
  const original=first(holding);
  void original.catch(locked.reject);
  let competing:Promise<unknown>|undefined;
  try{
   const pid=await locked.promise;
   competing=second().then(value=>({value}),error=>({error}));
   await expect.poll(async()=>Boolean((await f.db.query(`SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))`,[pid])).rowCount),{timeout:5000}).toBe(true);
   release.resolve();
   return {winner:await original,loser:await competing};
  }finally{
   release.resolve();await Promise.allSettled(competing?[original,competing]:[original]);barrier.mockRestore();
  }
 };
 it('does not charge missing-staff waiting, starts after the original assignment and never restarts on later reassignment',async()=>{
  const scene=await f.scene('2026-11-09T08:00:00Z'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work);
  const native=new SourcingService(f.db,undefined,undefined,new TodoProjectionService(new TodoService(f.db)),f.contracts,undefined,new RootAuthority(f.db,'anchor-test','uat-root'));
  let orderId='',caseId='';const stop=new Error('TEST stop fixture at the real pending-owner stage');
  const management=native.recordManagementDecision.bind(native);
  const managementSpy=vi.spyOn(native,'recordManagementDecision').mockImplementation(async(...args)=>{
   caseId=args[1];orderId=(await f.db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='sourcing' AND child_id=$1",[caseId])).rows[0].production_order_id;
   // Explicit isolated missing-staff precondition, not a claimed public
   // unassignment command. All approval and personnel actions below are native.
   await f.db.query('UPDATE digital_production_orders SET primary_merchandiser_id=NULL WHERE production_order_id=$1',[orderId]);
   return management(...args);
  });
  const ownerSpy=vi.spyOn(native,'decideOwner').mockRejectedValueOnce(stop);
  try{await expect(run(()=>f.bulkReady('无',undefined,1,native))).rejects.toBe(stop);}
  finally{managementSpy.mockRestore();ownerSpy.mockRestore();}
  const todos=async()=>(await f.db.query("SELECT todo_id,due_at FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1 AND category='sourcing_owner_approval' ORDER BY todo_id",[caseId])).rows;
  expect(await todos()).toEqual([]);
  expect((await sourcingSlaEvidence(f.db,orderId)).sourcing_approval).toBeUndefined();
  await expect(run(async()=>native.decideOwner(f.people.owner!,caseId,await seenSourcingOwnerDecision(native,f.people.owner!,caseId,{decision:'approved'}),randomUUID()))).rejects.toThrow('请先在本单指派有效主跟单');
  await f.advance(scene,'2026-11-11T12:00:00Z');
  const access=new DigitalProductionAccessService(f.db),version=async()=>(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0].version;
  await run(async()=>access.assignMerchandiser(f.root,orderId,f.people.merchandiser!.actorId,await version()));
  const opened=await todos();expect(opened.length).toBeGreaterThan(0);
  const parameter=(await f.db.query('SELECT parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[orderId])).rows[0].parameters_json.sourcing_approval.value;
  expect(parameter.kind).toBe('duration');
  for(const todo of opened)expect(todo.due_at.toISOString()).toBe(new Date(Date.parse('2026-11-11T12:00:00Z')+parameter.minutes*60000).toISOString());
  expect((await sourcingSlaEvidence(f.db,orderId)).sourcing_approval?.startedAt).toBe('2026-11-11T12:00:00.000Z');
  await f.advance(scene,'2026-11-12T12:00:00Z');
  await run(async()=>access.assignMerchandiser(f.root,orderId,f.people.merchandiser!.actorId,await version()));
  expect(await todos()).toEqual(opened);
  const approved=await run(async()=>native.decideOwner(f.people.owner!,caseId,await seenSourcingOwnerDecision(native,f.people.owner!,caseId,{decision:'approved'}),randomUUID()));
  expect(approved.value.status).toBe('pending_finance_reconciliation');
 });
 it('refuses old budgets and ABA corrections, restores the original approval receipt and generates only its exact document',async()=>{
  const {root,auth,sign}=signedIdentities();
  const signed=await sign('owner');
  const owner=await businessActor(root,await auth.authenticate(signed.token),randomUUID(),'sourcing:owner:approve');
  expect(owner.actorRoles).toEqual(['owner_group']);
  const service=new SourcingService(f.db,undefined,undefined,new TodoProjectionService(new TodoService(f.db)),f.contracts,undefined,root);
  const id=await pendingApproval(service);
  const before=await readSeenSourcingOwnerReview(service,owner,id);
  const correct=(daxingUnitPrice:string)=>service.correctBudgetPrice({...f.root,authorizationCapability:'sourcing:inquiry:create'},id,{
   daxingUnitPrice,reason:'TEST legitimate same-decision budget correction',
  },randomUUID());
  await correct('6');
  const changed=await readSeenSourcingOwnerReview(service,owner,id);
  expect(changed.basis).toMatchObject({expectedVersion:before.basis.expectedVersion,expectedDecisionId:before.basis.expectedDecisionId,expectedDecisionVersion:before.basis.expectedDecisionVersion});
  expect(changed.basis.expectedApprovalBasis).not.toBe(before.basis.expectedApprovalBasis);
  expect(changed.item.daxingUnitPrice).toBe('6.0000');
  await correct('5');
  const aba=await readSeenSourcingOwnerReview(service,owner,id);
  expect(aba.item.daxingUnitPrice).toBe(before.item.daxingUnitPrice);
  expect(aba.basis.expectedApprovalBasis).not.toBe(before.basis.expectedApprovalBasis);
  const readActor={...owner,authorizationCapability:'sourcing:view'};
  expect(await service.readDetailSections(readActor,id)).not.toHaveProperty('ownerReview');
  expect((await service.readDetailSections({...f.people.ie!,authorizationCapability:'sourcing:view'},id,true)).ownerReview).toBeNull();
  const footprint=async()=>{
   const tables=['sourcing_case_transitions','sourcing_owner_decisions','sourcing_approval_snapshots','sourcing_contract_documents'] as const;
   const state=await Promise.all(tables.map(table=>f.db.query(`SELECT to_jsonb(row) AS state FROM ${table} row WHERE sourcing_case_id=$1 ORDER BY to_jsonb(row)::text`,[id])));
   return {native:state.map(result=>result.rows),todos:(await f.db.query("SELECT * FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1 ORDER BY todo_id",[id])).rows,
    events:(await f.db.query("SELECT * FROM operation_events WHERE entity_type='sourcing_case' AND entity_id=$1 ORDER BY event_id",[id])).rows};
  };
  const stable=await footprint(),stale={code:'CONFLICT',statusCode:409,message:'审批内容已更新，请刷新后重新核对'};
  const other=await pendingApproval(service),otherView=await readSeenSourcingOwnerReview(service,owner,other);
  const rejectedKeys=Array.from({length:7},()=>randomUUID());
  await expect(service.decideOwner(owner,id,{decision:'approved',...before.basis},rejectedKeys[0]!)).rejects.toMatchObject(stale);
  await expect(service.decideOwner(owner,id,{decision:'rejected',...changed.basis},rejectedKeys[1]!)).rejects.toMatchObject(stale);
  await expect(service.returnToMerchandiser(owner,id,{reason:'TEST keep original explanation',...changed.basis},rejectedKeys[2]!)).rejects.toMatchObject(stale);
  await expect(service.decideOwner(owner,id,{decision:'approved'},rejectedKeys[3]!)).rejects.toMatchObject(stale);
  await expect(service.decideOwner(owner,id,{decision:'approved',...otherView.basis},rejectedKeys[4]!)).rejects.toMatchObject(stale);
  await expect(service.decideOwner(owner,id,{decision:'approved',...aba.basis,expectedDecisionVersion:aba.basis.expectedDecisionVersion+1},rejectedKeys[5]!)).rejects.toMatchObject(stale);
  await expect(service.decideOwner(owner,id,{decision:'approved',...aba.basis,expectedApprovalBasis:'0'.repeat(64)},rejectedKeys[6]!)).rejects.toMatchObject(stale);
  expect(await footprint()).toEqual(stable);
  expect((await f.db.query('SELECT 1 FROM idempotency_records WHERE idempotency_key=ANY($1::text[])',[rejectedKeys])).rowCount).toBe(0);
  const generation=vi.spyOn(f.contracts,'generateIfReady'),key=randomUUID(),input={decision:'approved' as const,...aba.basis};
  try{
   const saved=await service.decideOwner(owner,id,input,key);
   expect(saved.value.status).toBe('pending_finance_reconciliation');
   expect(saved.value.approvalSnapshot?.daxingUnitPrice).toBe('5.0000');
   const document=(await f.db.query('SELECT sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_case_id=$1',[id])).rows[0].sourcing_contract_document_id;
   expect(generation).toHaveBeenCalledExactlyOnceWith(owner,id,document);
   expect(await service.decideOwner(owner,id,input,key)).toEqual({value:saved.value,reused:true});
   await expect(service.decideOwner(owner,id,{...input,decisionReason:'TEST body differs after commit'},key)).rejects.toMatchObject({statusCode:409,code:'IDEMPOTENCY_CONFLICT'});
   expect(generation).toHaveBeenCalledTimes(1);
  }finally{generation.mockRestore();}
 });
 it('guards the live attachment set and keeps the recorded view stable across ordinary reads',async()=>{
  const {root,auth,sign}=signedIdentities();
  const owner=await businessActor(root,await auth.authenticate((await sign('owner')).token),randomUUID(),'sourcing:owner:approve');
  const service=f.sourcing,id=await pendingApproval(service);
  const initial=await readSeenSourcingOwnerReview(service,owner,id);
  expect((await readSeenSourcingOwnerReview(service,owner,id)).basis).toEqual(initial.basis);
  const photo=await f.image(f.root);
  await service.supplementImages({...f.root,authorizationCapability:'tools:user'},id,{attachmentIds:[photo]},randomUUID());
  const current=await readSeenSourcingOwnerReview(service,owner,id);
  expect(current.basis.expectedApprovalBasis).not.toBe(initial.basis.expectedApprovalBasis);
  expect({...current.basis,expectedApprovalBasis:initial.basis.expectedApprovalBasis}).toEqual(initial.basis);
  await expect(service.decideOwner(owner,id,{decision:'approved',...initial.basis},randomUUID())).rejects.toMatchObject({statusCode:409,code:'CONFLICT',message:'审批内容已更新，请刷新后重新核对'});
  expect(await service.listAttachments({...owner,authorizationCapability:'sourcing:view'},id)).toMatchObject({items:expect.arrayContaining([expect.objectContaining({attachmentId:photo})])});
  expect((await service.decideOwner(owner,id,{decision:'approved',...current.basis},randomUUID())).value.status).toBe('pending_finance_reconciliation');
 });
 it('resumes pending work by document ID, manually retries only the current failure and leaves superseded failures untouched on approval replay',async()=>{
  const {root,auth,sign}=signedIdentities();
  const [ownerLogin,merchLogin]=await Promise.all([sign('owner'),sign('merchandiser')]);
  const owner=await businessActor(root,await auth.authenticate(ownerLogin.token),randomUUID(),'sourcing:owner:approve');
  const service=f.sourcing;
  const approve=async(id:string,key:string)=>{
   const seen=await seenSourcingOwnerDecision(service,owner,id,{decision:'approved'});
   const result=await service.decideOwner(owner,id,seen,key);
   return {seen,result};
  };
  const documents=async(id:string)=>(await f.db.query(`SELECT sourcing_contract_document_id AS id,contract_version AS version,status,failure_reason,pdf_attachment_id
   FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version`,[id])).rows;
  const generation=vi.spyOn(f.contracts,'generateIfReady');
  const storage=vi.spyOn(f.storage,'writeImmutable');
  const unavailable='Object storage is temporarily unavailable';
  const app=Fastify();
  registerSourcingRoutes(app,{service,contracts:f.contracts,root,authenticate:token=>auth.authenticate(token)});
  const manual=async(id:string)=>{
   const response=await app.inject({method:'POST',url:`/sourcing/cases/${id}/contract/generate`,cookies:{dx_rework_session:merchLogin.token}});
   expect(response.statusCode,response.body).toBe(200);
   return response.json().item;
  };
  try{
   const startupCase=await pendingApproval(service);
   generation.mockRejectedValueOnce(new Error('TEST process stops after committed approval and before generation'));
   await approve(startupCase,randomUUID());
   const [pending]=await documents(startupCase);
   expect(pending).toMatchObject({status:'generation_pending',pdf_attachment_id:null});

   const manualCase=await pendingApproval(service);
   storage.mockRejectedValueOnce(new Error('TEST current document PDF store fails'));
   await approve(manualCase,randomUUID());
   const [failed]=await documents(manualCase);
   expect(failed).toMatchObject({status:'generation_failed',failure_reason:unavailable,pdf_attachment_id:null});

   generation.mockClear();
   await f.contracts.resumePendingContracts();
   expect(generation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId:`sourcing-contract-resume:${pending.id}`}),startupCase,pending.id);
   expect(await documents(startupCase)).toEqual([expect.objectContaining({id:pending.id,status:'ready',pdf_attachment_id:expect.any(String)})]);
   expect(await documents(manualCase)).toEqual([failed]);

   generation.mockClear();
   expect(await manual(manualCase)).toMatchObject({sourcingContractDocumentId:failed.id,status:'ready'});
   expect(generation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({actorId:f.people.merchandiser!.actorId}),manualCase);

   const supersededCase=await pendingApproval(service),key=randomUUID();
   storage.mockRejectedValueOnce(new Error('TEST historical document PDF store fails'));
   const previous=await approve(supersededCase,key);
   const [historical]=await documents(supersededCase);
   expect(historical).toMatchObject({status:'generation_failed',failure_reason:unavailable,pdf_attachment_id:null});
   const replacement=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:'TEST-RECOVERY-FACTORY',supplierType:'factory',supplierName:'TEST replacement factory',address:'TEST',contractEntityName:'TEST factory',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0001',bankName:'TEST',changeReason:'TEST current factory supersedes the old document'}));
   storage.mockRejectedValueOnce(new Error('TEST new current document PDF store fails'));
   await service.requestFactoryChange(owner,supersededCase,{supplierId:replacement.supplierId,unitPrice:'3.25',changeReason:'TEST original same-price transfer'},randomUUID());
   const revisions=await documents(supersededCase);
   expect(revisions).toEqual([historical,expect.objectContaining({id:expect.any(String),status:'generation_failed',failure_reason:unavailable})]);
   const current=revisions[1]!;
   expect(current.id).not.toBe(historical.id);
   generation.mockClear();
   expect(await service.decideOwner(owner,supersededCase,previous.seen,key)).toEqual({value:previous.result.value,reused:true});
   expect(generation).not.toHaveBeenCalled();
   expect(await documents(supersededCase)).toEqual(revisions);
   expect(await manual(supersededCase)).toMatchObject({sourcingContractDocumentId:current.id,status:'ready'});
   expect(await documents(supersededCase)).toEqual([historical,expect.objectContaining({id:current.id,status:'ready',pdf_attachment_id:expect.any(String)})]);
  }finally{generation.mockRestore();storage.mockRestore();await app.close();}
 });
 it('rechecks the locked approval basis when budget correction and approval commit in either order',async()=>{
  const {root,auth,sign}=signedIdentities();
  const [ownerLogin,rootLogin]=await Promise.all([sign('owner'),sign('root')]);
  const owner=await businessActor(root,await auth.authenticate(ownerLogin.token),randomUUID(),'sourcing:owner:approve');
  const corrector=await businessActor(root,await auth.authenticate(rootLogin.token),randomUUID(),'sourcing:inquiry:create');
  const service=f.sourcing;
  const correct=(native:SourcingService,id:string)=>native.correctBudgetPrice(corrector,id,{daxingUnitPrice:'6',reason:'TEST budget updates while approval waits'},randomUUID());
  const state=async(id:string)=>(await f.db.query(`SELECT
   (SELECT new_unit_price::text FROM sourcing_budget_price_corrections WHERE sourcing_case_id=$1 ORDER BY correction_version DESC LIMIT 1) AS corrected_price,
   (SELECT daxing_unit_price::text FROM sourcing_approval_snapshots WHERE sourcing_case_id=$1) AS approved_price,
   (SELECT count(*)::int FROM sourcing_owner_decisions WHERE sourcing_case_id=$1) AS decisions,
   (SELECT count(*)::int FROM sourcing_contract_documents WHERE sourcing_case_id=$1) AS documents`,[id])).rows[0];
  const correctionFirst=await pendingApproval(service);
  const old=await seenSourcingOwnerDecision(service,owner,correctionFirst,{decision:'approved'});
  const correctionWon=await competingWrites(root,native=>correct(native,correctionFirst),()=>service.decideOwner(owner,correctionFirst,old,randomUUID()));
  expect(correctionWon.winner.value.daxingUnitPrice).toBe('6.0000');
  expect(correctionWon.loser).toMatchObject({error:{statusCode:409,code:'CONFLICT',message:'审批内容已更新，请刷新后重新核对'}});
  expect(await state(correctionFirst)).toEqual({corrected_price:'6.0000',approved_price:null,decisions:0,documents:0});

  const approvalFirst=await pendingApproval(service);
  const seen=await seenSourcingOwnerDecision(service,owner,approvalFirst,{decision:'approved'});
  const approvalWon=await competingWrites(root,native=>native.decideOwner(owner,approvalFirst,seen,randomUUID()),()=>correct(service,approvalFirst));
  expect(approvalWon.winner.value.approvalSnapshot?.daxingUnitPrice).toBe('5.0000');
  expect(approvalWon.loser).toMatchObject({error:{statusCode:409,code:'INVALID_STATE_TRANSITION',message:'老板已批准，订单数字已锁定'}});
  expect(await state(approvalFirst)).toEqual({corrected_price:null,approved_price:'5.0000',decisions:1,documents:1});
 });
 it('serializes two independently signed ordinary owners, rejects their outdated decisions and checks revoked authority before replay',async()=>{
  const {root,auth,sign}=signedIdentities();
  const alternateAlias='second-sourcing-owner',alternateId=randomUUID();
  await f.db.query("INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,'TEST second owner',true,false)",[alternateId]);
  await f.db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
   VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),alternateId,`uat-${alternateAlias}`,`uat-union-${alternateAlias}`]);
  const {assignmentId}=await f.access.assignRole(f.root,{userId:alternateId,roleCode:'owner_group',reason:'TEST authorized second owner'});
  const resolveOwner=async(alias:string)=>businessActor(root,await auth.authenticate((await sign(alias)).token),randomUUID(),'sourcing:owner:approve');
  const [a,b]=await Promise.all([resolveOwner('owner'),resolveOwner(alternateAlias)]);
  expect(a.actorRoles).toEqual(['owner_group']);expect(b.actorRoles).toEqual(['owner_group']);expect(a.actorId).not.toBe(b.actorId);
  const service=f.sourcing;
  const decisions=async(id:string)=>(await f.db.query(`SELECT decision,decided_by,sourcing_decision_id FROM sourcing_owner_decisions WHERE sourcing_case_id=$1 ORDER BY decided_at,sourcing_owner_decision_id`,[id])).rows;
  const stale={statusCode:409,code:'CONFLICT',message:'审批内容已更新，请刷新后重新核对'};
  let latestReceipt:{id:string;key:string;input:Awaited<ReturnType<typeof seenSourcingOwnerDecision>>}|undefined;
  for(const loserDecision of ['approved','rejected'] as const){
   const id=await pendingApproval(service);
   const [winnerInput,loserInput]=await Promise.all([
    seenSourcingOwnerDecision(service,b,id,{decision:'approved'}),seenSourcingOwnerDecision(service,a,id,{decision:loserDecision}),
   ]);
   expect(winnerInput.expectedApprovalBasis).toBe(loserInput.expectedApprovalBasis);
   const key=randomUUID(),loserKey=randomUUID();
   const raced=await competingWrites(root,native=>native.decideOwner(b,id,winnerInput,key),()=>service.decideOwner(a,id,loserInput,loserKey));
   expect(raced.winner.value.status).toBe('pending_finance_reconciliation');
   expect(raced.loser).toMatchObject({error:stale});
   expect(await decisions(id)).toEqual([{decision:'approved',decided_by:b.actorId,sourcing_decision_id:winnerInput.expectedDecisionId}]);
   expect((await f.db.query('SELECT 1 FROM idempotency_records WHERE idempotency_key=$1',[loserKey])).rowCount).toBe(0);
   latestReceipt={id,key,input:winnerInput};
  }
  for(const oldDecision of ['approved','rejected'] as const){
   const id=await pendingApproval(service);
   const outdated=await seenSourcingOwnerDecision(service,a,id,{decision:oldDecision});
   const reject=await seenSourcingOwnerDecision(service,b,id,{decision:'rejected'}),rejectKey=randomUUID();
   const refused=await service.decideOwner(b,id,reject,rejectKey);
   expect(refused.value.status).toBe('pending_management_decision');
   expect(await service.decideOwner(b,id,reject,rejectKey)).toEqual({value:refused.value,reused:true});
   const manager=f.people['production-management']!,craft=(await f.access.ensureCrafts(manager,{craftNames:['TEST车缝']}))[0]!;
   await service.recordManagementDecision(manager,id,{linePrices:[{position:1,unitPrice:'3.50'}],craftIds:[craft.craftId],supplierId:f.supplierId,cuttingProcess:'in_house',decisionReason:'TEST revised factory price'},randomUUID());
   const revised=await readSeenSourcingOwnerReview(service,a,id);
   expect(revised.item.decision?.unitPrice).toBe('3.5000');
   expect(revised.basis.expectedDecisionId).not.toBe(outdated.expectedDecisionId);
   const baseline=await decisions(id);
   await expect(service.decideOwner(a,id,outdated,randomUUID())).rejects.toMatchObject(stale);
   expect(await decisions(id)).toEqual(baseline);
   const approved=await service.decideOwner(a,id,{decision:'approved',...revised.basis},randomUUID());
   expect(approved.value.approvalSnapshot?.sourcingDecisionId).toBe(revised.basis.expectedDecisionId);
  }
  const pending=await pendingApproval(service),viewed=await seenSourcingOwnerDecision(service,b,pending,{decision:'approved'});
  await f.access.revokeRole(f.root,assignmentId,'TEST owner authority is withdrawn');
  // Keep the old authenticated actor snapshot to exercise the transaction check directly.
  const denied={statusCode:403,code:'FORBIDDEN'};
  await expect(service.decideOwner(b,pending,viewed,randomUUID())).rejects.toMatchObject(denied);
  expect(await decisions(pending)).toEqual([]);
  expect((await service.readDetailSections({...b,authorizationCapability:'sourcing:view'},pending,true)).ownerReview).toBeNull();
  const receipt=latestReceipt!;
  await expect(service.decideOwner(b,receipt.id,receipt.input,receipt.key)).rejects.toMatchObject(denied);
  expect(await decisions(receipt.id)).toHaveLength(1);
 });
 it('restores unexpired receipts with the original request hash for each owner action and refuses new or expired old-format requests',async()=>{
  const {root,auth,sign}=signedIdentities();
  const owner=await businessActor(root,await auth.authenticate((await sign('owner')).token),randomUUID(),'sourcing:owner:approve');
  const service=f.sourcing,receipts=new IdempotencyService();
  for(const action of ['approved','rejected','return'] as const){
   const id=await pendingApproval(service),seen=await readSeenSourcingOwnerReview(service,owner,id),reason='TEST original owner opinion';
   const legacyReturn={expectedVersion:seen.basis.expectedVersion,reason};
   const decision={decision:action==='return'?'approved' as const:action,decisionReason:reason};
   const scope=action==='return'?'sourcing.case.return':`sourcing.owner.${action}`;
   // Exact persisted request shape from the release version, with a real business receipt below.
   const payload=action==='return'?{sourcingCaseId:id,input:legacyReturn}:{sourcingCaseId:id,...decision};
   const hash=createHash('sha256').update(JSON.stringify({scope,payload})).digest('hex');
   const legacy=(key:string)=>action==='return'?service.returnToMerchandiser(owner,id,legacyReturn,key):service.decideOwner(owner,id,decision,key);
   const store=(key:string,response:typeof seen.item,expiresAt:Date)=>receipts.execute(f.db,{scope,actorKey:owner.actorId,key,requestHash:hash,expiresAt},async()=>({statusCode:action==='return'?200:201,response}));
   const stale={statusCode:409,code:'CONFLICT',message:'审批内容已更新，请刷新后重新核对'};
   await expect(legacy(randomUUID())).rejects.toMatchObject(stale);
   const saved=action==='return'
    ?await service.returnToMerchandiser(owner,id,{...seen.basis,reason},randomUUID())
    :await service.decideOwner(owner,id,{...seen.basis,...decision},randomUUID());
   const key=randomUUID(),expired=randomUUID();
   await store(key,saved.value,new Date(Date.now()+60000));
   await store(expired,saved.value,new Date(Date.now()-60000));
   const generating=vi.spyOn(f.contracts,'generateIfReady');
   try{
    expect(await legacy(key)).toEqual({value:saved.value,reused:true});
    await expect(legacy(expired)).rejects.toMatchObject(action==='return'?{statusCode:409}:stale);
    expect(generating).not.toHaveBeenCalled();
   }finally{generating.mockRestore();}
  }
 });
});
