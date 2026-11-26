import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {expect} from 'vitest';
import type {PoolClient} from 'pg';
import type {ReviseSourcingStyles,SourcingCaseSummary,SourcingContractStateResponse} from '@dx-rework/contracts/sourcing';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {AuthService} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerSourcingRoutes} from '../../apps/api/src/sourcing/sourcing-routes.js';
import type {businessAnchorFixture} from './business-anchor-fixture.js';
import {decideSeenSourcingOwner} from './sourcing-owner-approval-fixture.js';

type Fixture=Awaited<ReturnType<typeof businessAnchorFixture>>;

export async function checkSourcingStyleConflicts(f:Fixture){
 const merchandiser=f.people.merchandiser!,manager=f.people['production-management']!,corp='anchor-test';
 const ready=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true});
 const neighbor=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});
 const ownCase=ready.caseId,foreignCase=neighbor.caseId;
 const mapping=async(id:string)=>(await f.db.query<{child_line_key:string;line_id:string;production_order_id:string}>(
  "SELECT child_line_key,line_id,production_order_id FROM digital_production_child_lines WHERE module='sourcing' AND child_id=$1 ORDER BY child_line_key",[id])).rows;
 const [first,second]=await mapping(ownCase),[foreign]=await mapping(foreignCase);
 expect([first?.child_line_key,second?.child_line_key,foreign?.production_order_id]).toEqual(['1','2',neighbor.id]);
 const legacyInput={gender:ready.input.gender,styleName:'TEST G8 independent sourcing',deliveryDate:ready.input.deliveryDate,
  estimatedCutPieceSendDate:ready.input.estimatedCutPieceSendDate,daxingUnitPrice:ready.input.daxingUnitPrice,
  attachmentIds:[await f.image(merchandiser)],lineItems:[{styleNo:'TEST-G8-LEGACY-'+randomUUID(),color:'黑',quantity:17}]};
 const legacyCase=(await f.sourcing.createCase(merchandiser,legacyInput,randomUUID())).value.sourcingCaseId;
 const linePrices=[{position:1,unitPrice:'5'}];
 await f.sourcing.quoteIePrice(f.people.ie!,legacyCase,{linePrices},randomUUID());
 const [craft]=await f.access.ensureCrafts(manager,{craftNames:['TEST车缝']});
 await f.sourcing.recordManagementDecision(manager,legacyCase,{supplierId:f.supplierId,linePrices,craftIds:[craft!.craftId],cuttingProcess:'in_house'},randomUUID());
 await decideSeenSourcingOwner(f.sourcing,f.people.owner!,legacyCase,{decision:'approved'},randomUUID());

 const otherId=randomUUID(),otherAlias='g8-other-merch-'+randomUUID();
 await f.db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST unrelated G8 merchandiser',true)",[otherId]);
 await f.db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
  VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),otherId,corp,'uat-'+otherAlias,'uat-union-'+otherAlias]);
 await f.access.assignRole({...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']},
  {userId:otherId,roleCode:'order_merchandiser',reason:'TEST unrelated signed G8 warehouse order merchandiser'});
 const root=new RootAuthority(f.db,corp,'uat-root'),secret=f.runtime.secret;
 const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,corp,secret),new PostgresAuthStore(f.db,corp,'uat-root'),corp,3600000,secret);
 const cookie=async(alias:string)=>'dx_rework_session='+(await auth.loginMobile(mintAcceptanceLoginCode(alias,secret))).token;
 const primary=await cookie('merchandiser'),management=await cookie('production-management'),outsider=await cookie(otherAlias);
 const app=Fastify({logger:false});
 registerSourcingRoutes(app,{service:f.sourcing,contracts:f.contracts,root,authenticate:token=>auth.authenticate(token)});
 const request=(actor:string,id:string,input:ReviseSourcingStyles,key:string)=>app.inject({
  method:'POST',url:`/sourcing/cases/${id}/styles`,headers:{cookie:actor,'idempotency-key':key},payload:input,
 });
 const readContract=async(id:string)=>{
  const response=await app.inject({method:'GET',url:`/sourcing/cases/${id}/contract`,headers:{cookie:primary}});
  expect(response.statusCode,response.body).toBe(200);
  const state=response.json<SourcingContractStateResponse>();
  expect(state.item).toMatchObject({status:'ready',pdfAttachmentId:expect.any(String)});
  return state;
 };
 const keys=Array.from({length:8},()=>randomUUID());
 const database=async()=>{
  const snapshot=await f.db.connect();
  try{
   await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const rows=async(sql:string,args:unknown[]=[])=> (await snapshot.query(sql,args)).rows;
   const ids=[ownCase,foreignCase,legacyCase];
   const result={
    orders:await rows('SELECT production_order_id,version FROM digital_production_orders ORDER BY production_order_id'),
    po:await rows('SELECT production_order_id,line_id,po_number,formal_style_no,temporary_style_no FROM digital_production_po_lines ORDER BY production_order_id,line_id'),
    caseRows:await rows('SELECT * FROM sourcing_cases WHERE sourcing_case_id=ANY($1::uuid[]) ORDER BY sourcing_case_id',[ids]),
    revisions:await rows('SELECT * FROM sourcing_style_revisions WHERE sourcing_case_id=ANY($1::uuid[]) ORDER BY sourcing_case_id,revision',[ids]),
    audits:await rows("SELECT * FROM operation_events WHERE entity_type='sourcing_case' AND action='sourcing.styles.revise' AND entity_id=ANY($1::text[]) ORDER BY event_id",[ids]),
    contracts:await rows('SELECT * FROM sourcing_contract_documents WHERE sourcing_case_id=ANY($1::uuid[]) ORDER BY sourcing_case_id,contract_version',[ids]),
    approval:await rows(`SELECT s.sourcing_case_id,l.* FROM sourcing_approval_snapshots s JOIN sourcing_approval_snapshot_lines l USING(sourcing_approval_snapshot_id)
     WHERE s.sourcing_case_id=ANY($1::uuid[]) ORDER BY s.sourcing_case_id,l.sourcing_approval_snapshot_id,l.position`,[ids]),
    receipts:await rows("SELECT idempotency_key,status,response FROM idempotency_records WHERE scope='sourcing.styles.revise' AND idempotency_key=ANY($1::text[]) ORDER BY idempotency_key",[keys]),
   };
   await snapshot.query('COMMIT');
   return result;
  }catch(error){await snapshot.query('ROLLBACK');throw error;}
  finally{snapshot.release();}
 };
 // Only this fixture owns this schema. Each corrupt mapping is visible to the
 // independently connected route; the trigger is live again before requests.
 const changeMapping=async(action:(client:PoolClient)=>Promise<void>)=>{
  const client=await f.db.connect();
  try{
   await client.query('BEGIN');
   expect((await client.query('SELECT current_schema() AS name')).rows[0]?.name).toMatch(/^business_anchors_[0-9a-f]{32}$/);
   await client.query('ALTER TABLE digital_production_child_lines DISABLE TRIGGER digital_production_child_lines_immutable');
   await action(client);
   await client.query('ALTER TABLE digital_production_child_lines ENABLE TRIGGER digital_production_child_lines_immutable');
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
 };
 const update=async(lineId:string,constraint?:{name:string;definition?:string})=>{
  await changeMapping(async client=>{
   if(constraint&&!constraint.definition)await client.query(`ALTER TABLE digital_production_child_lines DROP CONSTRAINT "${constraint.name}"`);
   await client.query("UPDATE digital_production_child_lines SET line_id=$2 WHERE module='sourcing' AND child_id=$1 AND child_line_key='2'",[ownCase,lineId]);
   if(constraint?.definition)await client.query(`ALTER TABLE digital_production_child_lines ADD CONSTRAINT "${constraint.name}" ${constraint.definition}`);
  });
 };
 try{
  const original=await readContract(ownCase),legacyOriginal=await readContract(legacyCase);
  const style='TEST-G8-STYLE-'+randomUUID(),originalCase=await f.sourcing.getCase({...merchandiser,authorizationCapability:'sourcing:view'},ownCase);
  const input={expectedRevision:originalCase.identityRevision??0,lines:originalCase.lineItems.map(line=>({
   position:line.position,styleNo:style+'-'+line.position,alternateStyleNo:line.alternateStyleNo,
  }))};
  const before=await database();
  const wrong=async(label:string,key:string,status:number,actor=primary,payload:ReviseSourcingStyles=input)=>{
   const reply=await request(actor,ownCase,payload,key);
   expect(reply.statusCode,`${label}: ${reply.body}`).toBe(status);
   expect(await database(),`${label} must not write`).toEqual(before);
  };
  await wrong('unrelated authorized role',keys[0]!,403,outsider);
  await wrong('repeated request position',keys[1]!,400,primary,{...input,lines:[input.lines[0]!,{...input.lines[1]!,position:1}]});
  await changeMapping(async client=>{await client.query("DELETE FROM digital_production_child_lines WHERE module='sourcing' AND child_id=$1 AND child_line_key='2'",[ownCase]);});
  try{await wrong('missing mapped row',keys[2]!,409);}
  finally{
   await f.db.query("INSERT INTO digital_production_child_lines(module,child_id,child_line_key,production_order_id,line_id) VALUES('sourcing',$1,'2',$2,$3)",[ownCase,ready.id,second!.line_id]);
  }
  await update(first!.line_id);
  try{await wrong('repeated mapped line',keys[3]!,409);}finally{await update(second!.line_id);}

  // A valid cross-order FK disallows this row in all live schemas. Drop just
  // that FK in this disposable fixture, then restore and revalidate it.
  const {rows:[key]}=await f.db.query<{name:string;definition:string}>(`SELECT conname AS name,pg_get_constraintdef(oid) AS definition
   FROM pg_constraint WHERE conrelid='digital_production_child_lines'::regclass AND confrelid='digital_production_po_lines'::regclass AND contype='f'`);
  expect(key?.name).toMatch(/^[a-z_][a-z0-9_]*$/);
  expect(key?.definition).toMatch(/^FOREIGN KEY \(production_order_id, line_id\) REFERENCES digital_production_po_lines\(production_order_id, line_id\)/);
  await update(foreign!.line_id,{name:key!.name});
  try{await wrong('line from a different production order',keys[4]!,409);}
  finally{await update(second!.line_id,key!);}
  expect(await mapping(ownCase)).toEqual([first,second]);
  expect(await database()).toEqual(before);

  expect(before.caseRows.find(row=>row.sourcing_case_id===legacyCase)?.workflow_generation).toBe('legacy');
  expect((await f.db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='sourcing' AND child_id=$1",[legacyCase])).rows).toEqual([]);
  expect(await mapping(legacyCase)).toEqual([]);
  const legacyResponse=await request(primary,legacyCase,{expectedRevision:0,lines:[{position:1,styleNo:style+'-legacy',alternateStyleNo:null}]},keys[5]!);
  expect(legacyResponse.statusCode,legacyResponse.body).toBe(200);
  const afterLegacy=await database();
  expect(afterLegacy.orders).toEqual(before.orders);
  expect(afterLegacy.po).toEqual(before.po);
  expect(afterLegacy.revisions).toHaveLength(before.revisions.length+1);
  expect(afterLegacy.audits).toHaveLength(before.audits.length+1);
  expect(afterLegacy.contracts).toHaveLength(before.contracts.length+1);
  expect(afterLegacy.approval).toEqual(before.approval);
  expect((await readContract(legacyCase)).item?.contractVersion).toBe(legacyOriginal.item!.contractVersion+1);

  const competing={...input,lines:input.lines.map(line=>({...line,styleNo:line.styleNo+'-manager'}))};
  const contenders=[{actor:primary,input,key:keys[6]!},{actor:management,input:competing,key:keys[7]!}];
  const responses=await Promise.all(contenders.map(entry=>request(entry.actor,ownCase,entry.input,entry.key)));
  expect(responses.map(response=>response.statusCode).sort(),responses.map(response=>response.body).join('\n')).toEqual([200,409]);
  const winnerIndex=responses.findIndex(response=>response.statusCode===200),winning=contenders[winnerIndex]!;
  const winner=responses[winnerIndex]!.json<SourcingCaseSummary>();
  expect(winner.identityRevision).toBe(input.expectedRevision+1);
  const after=await database();
  expect(after.revisions).toHaveLength(afterLegacy.revisions.length+1);
  expect(after.audits).toHaveLength(afterLegacy.audits.length+1);
  expect(after.contracts).toHaveLength(afterLegacy.contracts.length+1);
  expect(after.approval).toEqual(before.approval);
  expect(after.receipts.map(receipt=>receipt.idempotency_key).sort()).toEqual([keys[5]!,winning.key].sort());
  expect(after.orders.filter(row=>row.production_order_id!==ready.id)).toEqual(before.orders.filter(row=>row.production_order_id!==ready.id));
  expect(after.po.filter(row=>row.production_order_id!==ready.id)).toEqual(before.po.filter(row=>row.production_order_id!==ready.id));
  for(const link of [first!,second!]){
   const expected=winning.input.lines.find(line=>line.position===Number(link.child_line_key))!;
   expect(after.po.find(row=>row.line_id===link.line_id)).toMatchObject({po_number:expected.styleNo,formal_style_no:expected.styleNo,temporary_style_no:expected.alternateStyleNo});
  }
  expect(after.orders.find(row=>row.production_order_id===ready.id)?.version).toBe(before.orders.find(row=>row.production_order_id===ready.id)!.version+1);
  const repeated=await request(winning.actor,ownCase,winning.input,winning.key);
  expect(repeated.statusCode,repeated.body).toBe(200);
  expect(repeated.headers['idempotency-replayed']).toBe('true');
  expect(repeated.json()).toEqual(winner);
  expect(await database()).toEqual(after);
  expect(after.contracts.find(row=>row.sourcing_contract_document_id===original.item!.sourcingContractDocumentId))
   .toEqual(before.contracts.find(row=>row.sourcing_contract_document_id===original.item!.sourcingContractDocumentId));
  const oldDocument=await f.contracts.getCurrent({...merchandiser,authorizationCapability:'sourcing:view'},ownCase,original.item!.sourcingContractDocumentId);
  expect(oldDocument.item).toMatchObject({status:'ready',pdfAttachmentId:original.item!.pdfAttachmentId,pdfSha256:original.item!.pdfSha256});
  expect((await readContract(ownCase)).item?.contractVersion).toBe(original.item!.contractVersion+1);
 }finally{await app.close();}
}
