import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
import {SourcingTransferContractTodos} from '../../apps/api/src/sourcing/sourcing-transfer-contract-todos.js';
import {contractReturnClock} from '../../apps/api/src/sourcing/contract-return-clock.js';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('contract cycle and evidence isolation',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await f?.dispose();});
 const actor=()=>({...f.root,authorizationCapability:'sourcing:contract:record'});
 const reader=()=>({...f.root,authorizationCapability:'sourcing:view'});
 const prepare=async()=>{const scene=await f.scene('2026-11-01T02:00:00.000Z'),ready=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));return {scene,...ready};};
 it('uses the factory re-sign first PDF business ready, preserves prior facts and closes only its valid version todo',async()=>{
  const p=await prepare(),service=new SourcingContractReturnService(f.db),oldDoc=(await f.contracts.getCurrent(f.root,p.caseId)).item!;
  await service.submit(actor(),p.caseId,[await f.image(actor())],randomUUID());
  const original=(await f.db.query('SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1',[p.caseId])).rows[0];
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:'TEST-CLOCK-FACTORY2',supplierType:'factory',supplierName:'TEST clock factory2',address:'TEST',contractEntityName:'TEST factory2',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST isolated re-sign'}));
  await f.advance(p.scene,'2026-11-04T02:00:00.000Z');
  await f.sourcing.requestFactoryChange(f.people['production-management']!,p.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST original factory change'},randomUUID());
  const request=(await f.sourcing.getCurrentFactoryChange(reader(),p.caseId)).item!;
  await f.sourcing.decideFactoryChange(f.people.owner!,p.caseId,request.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST original remaining quantity'},randomUUID());
  const doc=(await f.contracts.getCurrent(f.root,p.caseId)).item!,state=await service.get(reader(),p.caseId);
  expect(doc.sourcingContractDocumentId).not.toBe(oldDoc.sourcingContractDocumentId);
  expect(state).toMatchObject({contractGeneratedAt:'2026-11-04T02:00:00.000Z',contractReturnedAt:null,contractReturnStatus:'pending'});expect(state.contractReturnCycleId).not.toBeNull();
  const client=await f.db.connect();try{
   const before=await new SourcingTransferContractTodos(f.db).inspect(client,p.caseId);expect(before.current?.returned).toBe(false);
   await expect(service.submit(actor(),p.caseId,[await f.image(actor())],randomUUID(),oldDoc.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:409});
   await service.submit(actor(),p.caseId,[await f.image(actor())],randomUUID(),doc.sourcingContractDocumentId);
   expect((await new SourcingTransferContractTodos(f.db).inspect(client,p.caseId)).current?.returned).toBe(true);
  }finally{client.release();}
  expect((await f.db.query('SELECT contract_generated_at,contract_return_due_at,contract_returned_at FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1',[p.caseId])).rows[0]).toMatchObject({contract_generated_at:original.contract_generated_at,contract_return_due_at:original.contract_return_due_at,contract_returned_at:original.contract_returned_at});
  const cycle=(await f.db.query('SELECT cycle.generated_at,document.generated_at AS pdf_generated_at FROM sourcing_contract_return_cycles cycle JOIN sourcing_contract_documents document ON document.sourcing_contract_document_id=cycle.first_document_id WHERE cycle.sourcing_approval_snapshot_id=$1',[state.contractReturnCycleId])).rows[0];expect(cycle.generated_at).toEqual(cycle.pdf_generated_at);
 },60000);
 it('reads without ALS at full pool capacity using the callers existing transactions',async()=>{
  const p=await prepare(),clients=[];
  try{for(let index=0;index<f.db.options.max!;index++)clients.push(await f.db.connect());
   const times=await Promise.all(clients.map(async client=>{await client.query('BEGIN');return contractReturnClock(f.db,client,p.caseId);}));
   expect(times).toHaveLength(10);for(const time of times)expect(time).toMatchObject({scenarioId:p.scene,now:'2026-11-01T02:00:00.000Z'});
  }finally{for(const client of clients){await client.query('ROLLBACK');client.release();}}
 },60000);
 it('independently rejects wrong revisions, instants, scope and inactive UAT evidence in SQL',async()=>{
  const p=await prepare(),scene=await f.runtime.repository.row(p.scene),other=await f.scene('2026-11-01T02:00:00.000Z');
  const time={now:scene.business_now.toISOString(),scenarioId:p.scene,revision:scene.version},doc=(await f.contracts.getCurrent(f.root,p.caseId)).item!;
  for(const variant of ['revision','instant','scope','inactive'] as const){
   const file=await f.image(actor()),client=await f.db.connect();try{await client.query('BEGIN');
    const submissionId=randomUUID(),evidence={...time,...(variant==='revision'?{revision:time.revision+1}:variant==='instant'?{now:'2026-11-01T02:00:00.001Z'}:variant==='scope'?{scenarioId:other}:{})};
    await client.query('INSERT INTO sourcing_contract_return_submissions(submission_id,sourcing_case_id,revision,request_id,submitted_by,sourcing_contract_document_id,submitted_at) VALUES($1,$2,1,$3,$4,$5,clock_timestamp())',[submissionId,p.caseId,randomUUID(),f.root.actorId,doc.sourcingContractDocumentId]);
    await client.query("UPDATE attachments SET entity_type='sourcing_contract_return',entity_id=$2 WHERE attachment_id=$1",[file,p.caseId]);
    await client.query('INSERT INTO sourcing_contract_return_attachments(submission_id,attachment_id,position) VALUES($1,$2,1)',[submissionId,file]);
    const event=await new OperationEventRepository().append(client,actor(),{action:'sourcing.contract_return.upload',entityType:'sourcing_case',entityId:p.caseId,after:{submissionId,revision:1,attachmentIds:[file],sourcingContractDocumentId:doc.sourcingContractDocumentId,businessTime:evidence}});
    if(variant==='inactive')await client.query("UPDATE identity_mappings SET active=false WHERE user_id=$1 AND provider='dingtalk'",[f.root.actorId]);
    await expect(client.query('INSERT INTO sourcing_contract_return_business_facts(submission_id,sourcing_case_id,business_returned_at,business_time,operation_event_id) VALUES($1,$2,$3,$4,$5)',[submissionId,p.caseId,evidence.now,evidence,event])).rejects.toMatchObject({code:'55000'});
   }finally{await client.query('ROLLBACK');client.release();}
  }
  expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_contract_return_business_facts WHERE sourcing_case_id=$1',[p.caseId])).rows[0].n).toBe(0);
 },60000);
 it('makes captured facts immutable and rejects a previously committed event as a new transaction proof',async()=>{
  const p=await prepare(),service=new SourcingContractReturnService(f.db);await service.submit(actor(),p.caseId,[await f.image(actor())],randomUUID());
  const fact=(await f.db.query('SELECT * FROM sourcing_contract_return_business_facts WHERE sourcing_case_id=$1',[p.caseId])).rows[0];
  await expect(f.db.query('UPDATE sourcing_contract_return_business_facts SET business_returned_at=business_returned_at WHERE submission_id=$1',[fact.submission_id])).rejects.toThrow();
  await expect(f.db.query('DELETE FROM sourcing_contract_return_business_facts WHERE submission_id=$1',[fact.submission_id])).rejects.toThrow();
  await expect(f.db.query('INSERT INTO sourcing_contract_return_business_facts(submission_id,sourcing_case_id,business_returned_at,business_time,operation_event_id) VALUES($1,$2,$3,$4,$5)',[fact.submission_id,p.caseId,fact.business_returned_at,fact.business_time,fact.operation_event_id])).rejects.toMatchObject({code:'55000'});
  expect((await service.get(reader(),p.caseId)).contractReturnedAt).toBe('2026-11-01T02:00:00.000Z');
 },60000);
});
