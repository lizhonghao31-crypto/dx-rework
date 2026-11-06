import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {vi} from 'vitest';
import {renderSourcingContractPdf,sourcingContractFingerprint} from '../../apps/api/src/sourcing/sourcing-contract-pdf.js';
import {loadContractContent,hydrateContractContentImages} from '../../apps/api/src/sourcing/sourcing-contract-content.js';
import pg from 'pg';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('native independent contract return business clock',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await f?.dispose();});
 const reader=()=>({...f.root,authorizationCapability:'sourcing:view'});
 const uploader=()=>({...f.root,authorizationCapability:'sourcing:contract:record'});
 const get=(id:string)=>new SourcingContractReturnService(f.db).get(reader(),id);
 const prepare=async(at:string)=>{const scene=await f.scene(at),ready=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));return {scene,...ready};};
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: first monitor follows its recorded ready business fact while PDF auditing stays real`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='current'?0:7)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const ready=scene?await f.runtime.run(scene,f.root,()=>f.bulkReady('无')):await f.bulkReady('无');
  const fact=(await f.db.query('SELECT * FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1 AND is_first_for_case',[ready.caseId])).rows[0];
  if(scene)expect(fact.business_ready_at.toISOString()).toBe(at);
  const document=(await f.db.query('SELECT generated_at FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1',[fact.sourcing_contract_document_id])).rows[0];
  expect(Math.abs(document.generated_at.getTime()-Date.now())).toBeLessThan(60000);if(scene&&mode!=="current")expect(document.generated_at.toISOString()).not.toBe(at);
  const result=await get(ready.caseId),start=scene?at:document.generated_at.toISOString();
  expect(result.contractGeneratedAt).toBe(start);expect(result.contractReturnTimeQuality).toBe(scene?'business_projection':undefined);
  const due=(await f.db.query('SELECT sourcing_contract_return_add_hours($1::timestamptz,48) AS due',[start])).rows[0].due.toISOString();
  expect(result.contractReturnDueAt).toBe(due);expect(result.contractReturnStatus).toBe('pending');
 },testExecutionConfig.correctnessTimeoutMs);
 it('uses the frozen business instant for the effective return and retains the real upload audit',async()=>{
  const at=new Date(Date.now()+5*86400000).toISOString(),scene=await f.scene(at),ready=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));
  const actor={...f.root,authorizationCapability:'sourcing:contract:record'},file=await f.image(actor);
  const result=await f.runtime.run(scene,f.root,()=>new SourcingContractReturnService(f.db).submit(actor,ready.caseId,[file],randomUUID()));
  expect(result.contractReturnedAt).toBe(at);expect(result.contractReturnStatus).toBe('returned_on_time');
  const audit=(await f.db.query('SELECT submitted_at FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].submitted_at;
  expect(Math.abs(audit.getTime()-Date.now())).toBeLessThan(60000);expect(audit.toISOString()).not.toBe(at);
 },testExecutionConfig.correctnessTimeoutMs);

 it('freezes the first effective endpoint through same-key, different-key and concurrent retries',async()=>{
  const at='2026-11-06T02:00:00.000Z',p=await prepare(at),service=new SourcingContractReturnService(f.db),file=await f.image(uploader()),key=randomUUID();
  const run=()=>service.submit(uploader(),p.caseId,[file],key);
  const both=await Promise.all([run(),run()]);expect(both[0]).toEqual(both[1]);
  await f.advance(p.scene,'2026-11-10T02:00:00.000Z');
  const retry=await service.submit(uploader(),p.caseId,[file],randomUUID());
  expect(retry.contractReturnedAt).toBe(at);expect(retry.contractReturnDueAt).toBe('2026-11-09T02:00:00.000Z');expect(retry.contractReturnStatus).toBe('returned_on_time');
  const second=await service.submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID());expect(second.contractReturnedAt).toBe(at);
  expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_contract_return_business_facts WHERE sourcing_case_id=$1',[p.caseId])).rows[0].n).toBe(2);
  expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1',[p.caseId])).rows[0].n).toBe(2);
  await expect(service.submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID())).rejects.toMatchObject({statusCode:409});
 },testExecutionConfig.correctnessTimeoutMs);
 for(const [start,due] of [
  ['2026-11-06T02:00:00.000Z','2026-11-09T02:00:00.000Z'],
  ['2026-11-07T16:00:00.000Z','2026-11-10T16:00:00.000Z'],
  ['2026-11-05T16:00:00.000Z','2026-11-08T16:00:00.000Z'],
  ['2026-11-05T15:59:59.999Z','2026-11-07T15:59:59.999Z'],
  ['2026-11-05T16:00:00.001Z','2026-11-08T16:00:00.001Z'],
 ])it(`preserves Shanghai Sunday and millisecond boundaries from ${start}`,async()=>{
  const p=await prepare(start);expect((await get(p.caseId)).contractReturnDueAt).toBe(due);
  await f.advance(p.scene,new Date(Date.parse(due)-1).toISOString());expect((await get(p.caseId)).contractReturnStatus).toBe('pending');
  await f.advance(p.scene,due);expect((await get(p.caseId)).contractReturnStatus).toBe('pending');
  await f.advance(p.scene,new Date(Date.parse(due)+1).toISOString());expect((await get(p.caseId)).contractReturnStatus).toBe('overdue_pending');
 },testExecutionConfig.correctnessTimeoutMs);
 it('permits the original first return before PDF, then starts once on actual successful ready',async()=>{
  const scene=await f.scene('2026-11-01T02:00:00.000Z'),hold=vi.spyOn(f.contracts,'generateIfReady').mockResolvedValue({item:null});
  let p:Awaited<ReturnType<typeof f.bulkReady>>;try{p=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));}finally{hold.mockRestore();}
  const service=new SourcingContractReturnService(f.db),first=await service.submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID());
  expect(first).toMatchObject({contractGeneratedAt:null,contractReturnDueAt:null,contractReturnedAt:'2026-11-01T02:00:00.000Z',contractReturnStatus:'returned_on_time'});
  await f.advance(scene,'2026-11-02T02:00:00.000Z');await f.contracts.generateIfReady(f.root,p.caseId);
  const ready=await get(p.caseId);expect(ready.contractGeneratedAt).toBe('2026-11-02T02:00:00.000Z');expect(ready.contractReturnedAt).toBe(first.contractReturnedAt);
  await f.advance(scene,'2026-11-03T02:00:00.000Z');await f.contracts.generateIfReady(f.root,p.caseId);expect((await get(p.caseId)).contractReturnDueAt).toBe(ready.contractReturnDueAt);
 },testExecutionConfig.correctnessTimeoutMs);
 it('keeps per-order observations and list filters consistent across scenes and ordinary orders',async()=>{
  const a=await prepare('2026-10-20T02:00:00.000Z'),b=await prepare('2026-11-20T02:00:00.000Z');
  await f.advance(a.scene,'2026-10-23T02:00:00.000Z');
  const service=f.sourcing;
  const detailA=await service.getCase(reader(),a.caseId),detailB=await service.getCase(reader(),b.caseId);
  expect(detailA).toMatchObject({contractReturnAsOf:'2026-10-23T02:00:00.000Z',contractReturnStatus:'overdue_pending'});
  expect(detailB).toMatchObject({contractReturnAsOf:'2026-11-20T02:00:00.000Z',contractReturnStatus:'pending'});
  for(const [id,status] of [[a.caseId,'overdue_pending'],[b.caseId,'pending']] as const){
   const style=(await f.db.query('SELECT style_no FROM sourcing_cases WHERE sourcing_case_id=$1',[id])).rows[0].style_no;
   const list=await service.listCases(reader(),style,'all',1,{contractReturn:status});expect(list.items.map(i=>i.sourcingCaseId)).toContain(id);expect(list.totalCount).toBe(list.items.length);
   const wrong=await service.listCases(reader(),style,'all',1,{contractReturn:status==='pending'?'overdue_pending':'pending'});expect(wrong.items.map(i=>i.sourcingCaseId)).not.toContain(id);
  }
 },testExecutionConfig.correctnessTimeoutMs);
 it('rejects missing readers, another scene, mixed ordinary scope and invalid current evidence without falling back',async()=>{
  const p=await prepare('2026-11-01T02:00:00.000Z'),other=await f.scene('2026-11-02T02:00:00.000Z'),ordinary=await f.bulkReady('无'),unverified=new pg.Pool({...f.db.options});
  try{await expect(new SourcingContractReturnService(unverified).get(reader(),p.caseId)).rejects.toMatchObject({code:'ACCEPTANCE_ISOLATION'});
   await expect(new SourcingService(unverified).listCases(reader(),'never-matches','all',1,{contractReturn:'pending'})).rejects.toMatchObject({code:'ACCEPTANCE_ISOLATION'});
  }finally{await unverified.end();}
  await expect(f.runtime.run(other,f.root,()=>get(p.caseId))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
  await expect(f.runtime.run(p.scene,f.root,()=>get(ordinary.caseId))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
  const current=await f.runtime.repository.row(p.scene),time={now:current.business_now.toISOString(),scenarioId:p.scene,revision:current.version};
  expect((await f.db.query('SELECT sourcing_contract_return_clock_evidence($1,$2) AS ok',[p.scene,time])).rows[0].ok).toBe(true);
  for(const invalid of [{...time,revision:999},{...time,now:'2026-11-01T02:00:00.001Z'},{...time,scenarioId:other},{...time,now:'garbage'},{...time,revision:-1}])expect((await f.db.query('SELECT sourcing_contract_return_clock_evidence($1,$2) AS ok',[p.scene,invalid])).rows[0].ok).toBe(false);
 },testExecutionConfig.correctnessTimeoutMs);
 it('rolls back files, requests, monitor, new evidence and event if a later original todo write fails',async()=>{
  const p=await prepare('2026-11-01T02:00:00.000Z'),file=await f.image(uploader()),key=randomUUID(),todos=new TodoProjectionService(new TodoService(f.db));
  vi.spyOn(todos,'completeOpenByDedupePrefix').mockRejectedValue(new Error('TEST failure after business fact'));
  const broken=new SourcingContractReturnService(f.db,new OperationEventRepository(),todos);
  await expect(broken.submit(uploader(),p.caseId,[file],key)).rejects.toThrow('TEST failure after business fact');
  for(const table of ['sourcing_contract_return_business_facts','sourcing_contract_return_requests','sourcing_contract_return_submissions'])expect((await f.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE sourcing_case_id=$1`,[p.caseId])).rows[0].n).toBe(0);
  expect((await f.db.query("SELECT count(*)::int AS n FROM operation_events WHERE action='sourcing.contract_return.upload' AND entity_id=$1",[p.caseId])).rows[0].n).toBe(0);
  expect((await f.db.query('SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1',[file])).rows[0]).toMatchObject({entity_type:null,entity_id:null});
  expect((await get(p.caseId)).contractReturnedAt).toBeNull();
  expect((await new SourcingContractReturnService(f.db).submit(uploader(),p.caseId,[file],key)).contractReturnedAt).toBe('2026-11-01T02:00:00.000Z');
 },testExecutionConfig.correctnessTimeoutMs);

 // Model a newly imported pre-0265 writer in this isolated fixture. No old row or immutable fact is edited/deleted.
 const legacyUpload=async(caseId:string,evidence?:unknown)=>{
  const file=await f.image(uploader()),client=await f.db.connect(),submissionId=randomUUID();
  try{await client.query('BEGIN');await client.query('SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE',[caseId]);
   const doc=(await client.query('SELECT sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version DESC LIMIT 1',[caseId])).rows[0].sourcing_contract_document_id;
   const revision=(await client.query('SELECT COALESCE(max(revision),0)+1 AS n FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1',[caseId])).rows[0].n;
   const signed=(await client.query('INSERT INTO sourcing_contract_return_submissions(submission_id,sourcing_case_id,revision,request_id,submitted_by,sourcing_contract_document_id,submitted_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING submitted_at',[submissionId,caseId,revision,randomUUID(),f.root.actorId,doc])).rows[0];
   await client.query("UPDATE attachments SET entity_type='sourcing_contract_return',entity_id=$2 WHERE attachment_id=$1",[file,caseId]);
   await client.query('INSERT INTO sourcing_contract_return_attachments(submission_id,attachment_id,position) VALUES($1,$2,1)',[submissionId,file]);
   await new OperationEventRepository().append(client,uploader(),{action:'sourcing.contract_return.upload',entityType:'sourcing_case',entityId:caseId,after:{submissionId,revision,attachmentIds:[file],sourcingContractDocumentId:doc,...(evidence?{acceptanceClock:evidence}:{})}});
   await client.query('UPDATE sourcing_contract_return_monitors SET contract_returned_at=COALESCE(contract_returned_at,$2),contract_return_uploaded_by=COALESCE(contract_return_uploaded_by,$3),contract_return_latest_uploaded_by=$3 WHERE sourcing_case_id=$1',[caseId,signed.submitted_at,f.root.actorId]);
   await client.query('COMMIT');return {submissionId,file};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 };
 it('preserves unknown first legacy endpoints and their files instead of choosing a later proven upload',async()=>{
  const p=await prepare('2026-11-01T02:00:00.000Z');await legacyUpload(p.caseId);
  const before=await get(p.caseId);expect(before).toMatchObject({contractReturnTimeQuality:'unknown',contractReturnStatus:null,contractReturnedAt:null,currentContractReturned:true});expect(before.attachments).toHaveLength(1);
  await f.advance(p.scene,'2026-11-02T02:00:00.000Z');const after=await new SourcingContractReturnService(f.db).submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID());
  expect(after.contractReturnTimeQuality).toBe('unknown');expect(after.contractReturnedAt).toBeNull();expect(after.attachments).toHaveLength(2);
  const style=(await f.db.query('SELECT style_no FROM sourcing_cases WHERE sourcing_case_id=$1',[p.caseId])).rows[0].style_no;
  expect((await f.sourcing.listCases(reader(),style,'all',1,{contractReturn:'all'})).items.map(i=>i.sourcingCaseId)).toContain(p.caseId);
  for(const status of ['pending','returned_on_time','overdue_pending','returned_late','all_overdue'] as const)expect((await f.sourcing.listCases(reader(),style,'all',1,{contractReturn:status})).items.map(i=>i.sourcingCaseId)).not.toContain(p.caseId);
 },testExecutionConfig.correctnessTimeoutMs);
 it('projects only an exact old event with original scene revision and never writes during reads',async()=>{
  const p=await prepare('2026-11-01T02:00:00.000Z'),row=await f.runtime.repository.row(p.scene),time={now:row.business_now.toISOString(),scenarioId:p.scene,revision:row.version};
  await legacyUpload(p.caseId,time);await f.advance(p.scene,'2026-11-03T02:00:00.000Z');
  const before=(await f.db.query('SELECT (SELECT count(*) FROM operation_events) AS events,(SELECT count(*) FROM sourcing_contract_return_business_facts) AS facts')).rows[0];
  expect(await get(p.caseId)).toMatchObject({contractReturnTimeQuality:'business_projection',contractReturnedAt:time.now,contractReturnStatus:'returned_on_time'});
  expect((await f.db.query('SELECT (SELECT count(*) FROM operation_events) AS events,(SELECT count(*) FROM sourcing_contract_return_business_facts) AS facts')).rows[0]).toEqual(before);
  const original=(await f.db.query("SELECT after_state FROM operation_events WHERE action='sourcing.contract_return.upload' AND entity_id=$1",[p.caseId])).rows[0].after_state;
  const client=await f.db.connect();try{await new OperationEventRepository().append(client,uploader(),{action:'sourcing.contract_return.upload',entityType:'sourcing_case',entityId:p.caseId,after:original});}finally{client.release();}
  const ambiguous=await get(p.caseId);expect(ambiguous.contractReturnTimeQuality).toBe('unknown');expect(ambiguous.contractReturnedAt).toBeNull();expect(ambiguous.attachments).toHaveLength(1);
 },testExecutionConfig.correctnessTimeoutMs);
 it('keeps a pre-0263 ready PDF as unknown in a scene while retaining its actual audit and eligibility',async()=>{
  const scene=await f.scene('2026-11-01T02:00:00.000Z'),hold=vi.spyOn(f.contracts,'generateIfReady').mockResolvedValue({item:null});
  let p:Awaited<ReturnType<typeof f.bulkReady>>;try{p=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));}finally{hold.mockRestore();}
  const doc=(await f.contracts.getCurrent(f.root,p.caseId)).item!,snapshot=await hydrateContractContentImages(f.attachments,p.caseId,await loadContractContent(f.db,doc.sourcingContractDocumentId));
  const file=await f.attachments.storeGenerated(f.root,{filename:'TEST-legacy.pdf',mimeType:'application/pdf',content:await renderSourcingContractPdf(snapshot),entityType:'sourcing_contract_document',entityId:doc.sourcingContractDocumentId});
  await f.db.query("UPDATE sourcing_contract_documents SET status='ready',generated_at=CURRENT_TIMESTAMP,pdf_attachment_id=$2,pdf_sha256=$3,snapshot_fingerprint=$4 WHERE sourcing_contract_document_id=$1",[doc.sourcingContractDocumentId,file.attachmentId,file.sha256,sourcingContractFingerprint(snapshot)]);
  const before=(await f.db.query('SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1',[p.caseId])).rows[0];
  expect(await get(p.caseId)).toMatchObject({contractReturnMonitoring:true,contractReturnTimeQuality:'unknown',contractReturnStatus:null,contractGeneratedAt:null,contractReturnDueAt:null,canUpload:true});
  expect((await f.db.query('SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1',[p.caseId])).rows[0]).toEqual(before);
 },testExecutionConfig.correctnessTimeoutMs);
 it('starts an independent price re-sign cycle on its first ready and does not count previous version files',async()=>{
  const p=await prepare('2026-11-01T02:00:00.000Z'),service=new SourcingContractReturnService(f.db),old=await service.submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID());
  const first=(await f.contracts.getCurrent(f.root,p.caseId)).item!;
  await f.advance(p.scene,'2026-11-04T02:00:00.000Z');
  await f.sourcing.requestPriceReapplication(f.people['production-management']!,p.caseId,{unitPrice:'6',changeReason:'TEST scene price re-sign',expectedDecisionId:(await f.db.query('SELECT sourcing_decision_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1',[first.sourcingContractDocumentId])).rows[0].sourcing_decision_id,expectedContractDocumentId:first.sourcingContractDocumentId},randomUUID());
  const request=(await f.sourcing.getCurrentPriceReapplication(reader(),p.caseId)).item!;
  if(request.status==='pending')await f.sourcing.decidePriceReapplication(f.people.owner!,p.caseId,request.priceRequestId,{decision:'approved',verificationReason:'TEST original price approval'},randomUUID());
  const current=(await f.contracts.getCurrent(f.root,p.caseId)).item!,state=await get(p.caseId);
  expect(state.contractReturnCycleId).not.toBeNull();expect(state.contractGeneratedAt).toBe('2026-11-04T02:00:00.000Z');expect(state.contractReturnedAt).toBeNull();expect(state.contractReturnStatus).toBe('pending');
  await service.submit(uploader(),p.caseId,old.attachments.map(a=>a.attachmentId),randomUUID(),current.sourcingContractDocumentId);expect((await get(p.caseId)).contractReturnedAt).toBeNull();
  await expect(service.submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID(),first.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:409});
  const signed=await service.submit(uploader(),p.caseId,[await f.image(uploader())],randomUUID(),current.sourcingContractDocumentId);expect(signed.contractReturnedAt).toBe('2026-11-04T02:00:00.000Z');
  expect((await f.db.query('SELECT contract_returned_at FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1',[p.caseId])).rows[0].contract_returned_at.toISOString()).not.toBe(signed.contractReturnedAt);
 },testExecutionConfig.correctnessTimeoutMs);
 it('does not restart first or cycle anchors for information revisions and repeated ready/download reads',async()=>{
  const p=await prepare('2026-11-01T02:00:00.000Z'),before=await get(p.caseId),management=f.contracts.management,template=(await management.templates(f.root)).item;
  await management.saveTemplate(f.root,{expectedVersion:template.templateVersion,templateName:template.templateName,partyAName:template.partyAName,partyAAddress:template.partyAAddress,signingPlace:template.signingPlace,terms:{...template.terms,logistics:template.terms.logistics+' TEST clock nonrestart'}},randomUUID());
  await f.advance(p.scene,'2026-11-03T02:00:00.000Z');const preview=await management.previewInformation(f.root,p.caseId),key=randomUUID(),doc=await management.refreshInformation(f.root,p.caseId,preview,key);
  expect(await management.refreshInformation(f.root,p.caseId,preview,key)).toBe(doc);await f.contracts.generateIfReady(f.root,p.caseId,doc);await f.contracts.getCurrent(f.root,p.caseId,doc);
  const after=await get(p.caseId);expect(after.contractGeneratedAt).toBe(before.contractGeneratedAt);expect(after.contractReturnDueAt).toBe(before.contractReturnDueAt);
  expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1 AND is_first_for_case',[p.caseId])).rows[0].n).toBe(1);
 },testExecutionConfig.correctnessTimeoutMs);
});
