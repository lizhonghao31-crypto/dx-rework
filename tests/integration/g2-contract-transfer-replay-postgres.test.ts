import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CreateSupplierSchema } from "@dx-rework/contracts";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AcceptanceDingTalkProvider, mintAcceptanceLoginCode } from "../../apps/api/src/auth/acceptance-provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { BulkPreparationService } from "../../apps/api/src/production-platform/bulk-preparation-service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { registerSourcingRoutes } from "../../apps/api/src/sourcing/sourcing-routes.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { businessAnchorFixture } from "../helpers/business-anchor-fixture.js";
import { seenSourcingOwnerDecision } from "../helpers/sourcing-owner-approval-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const aliases = ["merchandiser","production-management","owner","warehouse"] as const;
type Alias = typeof aliases[number];

(databaseUrl ? describe : describe.skip)("G2 original contract supplement and transfer receipts", () => {
  let f: Awaited<ReturnType<typeof businessAnchorFixture>>;
  let app: ReturnType<typeof Fastify>;
  let service: SourcingService;
  let todos: TodoProjectionService;
  let sessions: Record<Alias,string>;

  beforeAll(async () => {
    f = await businessAnchorFixture(databaseUrl!);
    const root = new RootAuthority(f.db,"anchor-test","uat-root");
    const secret = "TEST signed G2 contract and transfer sessions ".repeat(2);
    const auth = new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),
      new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
    sessions = Object.fromEntries(await Promise.all(aliases.map(async alias =>
      [alias,(await auth.loginMobile(mintAcceptanceLoginCode(alias,secret))).token] as const))) as typeof sessions;
    app = Fastify();
    todos = new TodoProjectionService(new TodoService(f.db));
    service = new SourcingService(f.db,undefined,undefined,todos,f.contracts,undefined,root);
    registerSourcingRoutes(app,{service,contracts:f.contracts,root,authenticate:token=>auth.authenticate(token)});
  },120_000);

  afterAll(async () => {
    await app?.close();
    await f?.dispose();
  });

  const request = (alias: Alias, path: string, key: string, payload: object) => app.inject({
    method:"POST",url:path,cookies:{dx_rework_session:sessions[alias]},headers:{"idempotency-key":key},payload,
  });
  const supplier = (needsInfo = false) => {
    const suffix=randomUUID().slice(0,18).toUpperCase();
    return f.access.createSupplier(f.root,CreateSupplierSchema.parse({
    supplierCode:`TEST-G2-${suffix}`,supplierType:"factory",supplierName:`TEST G2 isolated factory ${suffix}`,
    address:"TEST",contractEntityName:"TEST",partyBRepresentative:"TEST",payeeName:"TEST",
    bankAccount:needsInfo?null:"TEST0001",bankName:needsInfo?null:"TEST bank",changeReason:"TEST original authorized contractor",
    }));
  };
  const current = (id: string, doc?: string) => f.contracts.getCurrent(f.root,id,doc).then(r=>r.item!);
  async function pendingRevision(caseId: string) {
    const base = await f.contracts.content.get(f.root,caseId);
    const id = await f.contracts.content.save(f.root,caseId,
      {...base,content:{...base.content,contractTitle:"TEST authorized original B revision"}},randomUUID());
    expect(await current(caseId,id)).toMatchObject({status:"generation_pending",pdfAttachmentId:null,pdfSha256:null});
    return id;
  }

  async function snapshot(caseId: string, orderId: string|null = null) {
    return (await f.db.query(`
      WITH docs AS (SELECT * FROM sourcing_contract_documents WHERE sourcing_case_id=$1),
           task AS (SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access access USING(task_id)
                    WHERE access.production_order_id=$2::uuid)
      SELECT (SELECT jsonb_agg(to_jsonb(docs) ORDER BY contract_version) FROM docs) docs,
        (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.sourcing_contract_document_id) FROM sourcing_contract_business_ready_facts f WHERE f.sourcing_case_id=$1) readiness,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attachment_id) FROM attachments a JOIN docs ON a.attachment_id=docs.pdf_attachment_id) pdfs,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sourcing_contract_supplement_id) FROM sourcing_contract_supplements s JOIN docs USING(sourcing_contract_document_id)) supplements,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.todo_id) FROM rework_todos t WHERE t.entity_type='sourcing_case' AND t.entity_id=$1::text) todos,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.factory_change_request_id) FROM sourcing_factory_change_requests r WHERE r.sourcing_case_id=$1) requests,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.factory_change_decision_id) FROM sourcing_factory_change_decisions r JOIN sourcing_factory_change_requests a
          ON a.factory_change_request_id=r.factory_change_request_id AND a.sourcing_case_id=$1) decisions,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.task_id) FROM task t) bulk_tasks,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.event_id) FROM digital_production_task_events t JOIN task USING(task_id)) task_events,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.revision_id) FROM digital_production_deadline_revisions t JOIN task USING(task_id)) deadlines,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.preparation_id) FROM digital_bulk_preparations p WHERE p.production_order_id=$2::uuid) preparations
      `,[caseId,orderId])).rows[0];
  }

  it("returns the authorized original supplement after concurrent, expired and ambiguous replays without touching B",async()=>{
    const merch=f.people.merchandiser!,manager=f.people["production-management"]!,owner=f.people.owner!;
    const missing=await supplier(true),craft=(await f.access.ensureCrafts(manager,{craftNames:["TEST车缝"]}))[0]!;
    const {value:created}=await service.createCase(merch,{gender:"男装",styleName:"TEST initial incomplete supplier",
      estimatedCutPieceSendDate:"2026-12-01",deliveryDate:"2027-01-10",daxingUnitPrice:"5",attachmentIds:[await f.image(merch)],
      lineItems:[{styleNo:`TEST-G2-${randomUUID()}`,color:"黑",quantity:10}]},randomUUID());
    const caseId=created.sourcingCaseId,prices=[{position:1,unitPrice:"3.25"}];
    await service.quoteIePrice(f.people.ie!,caseId,{linePrices:prices},randomUUID());
    await service.recordManagementDecision(manager,caseId,{linePrices:prices,craftIds:[craft.craftId],supplierId:missing.supplierId,cuttingProcess:"in_house"},randomUUID());
    await service.decideOwner(owner,caseId,await seenSourcingOwnerDecision(service,owner,caseId,{decision:"approved"}),randomUUID());
    const a=await current(caseId),path=`/sourcing/cases/${caseId}/contract/supplements`;
    expect(a).toMatchObject({status:"pending_supplement"});
    const generate=vi.spyOn(f.contracts,"generateIfReady");
    try{
      const partial=await request("merchandiser",path,randomUUID(),{bankName:"TEST bank"});
      expect(partial.statusCode,partial.body).toBe(200);
      expect(partial.json().item).toMatchObject({sourcingContractDocumentId:a.sourcingContractDocumentId,status:"pending_supplement",missingFields:["bankAccount"]});
      expect(generate).not.toHaveBeenCalled();
      const key=randomUUID(),body={bankAccount:"TEST0001"};
      const [one,two]=await Promise.all([request("merchandiser",path,key,body),request("merchandiser",path,key,body)]);
      for(const result of [one,two]){
        expect(result.statusCode,result.body).toBe(200);
        expect(result.json().item.sourcingContractDocumentId).toBe(a.sourcingContractDocumentId);
      }
      const original=await current(caseId,a.sourcingContractDocumentId);
      expect(original).toMatchObject({status:"ready",pdfSha256:expect.stringMatching(/^[0-9a-f]{64}$/)});
      const signedReceipt=[one,two].map(r=>r.json().item).find(item=>item.status==="ready");
      expect(signedReceipt).toMatchObject({canEditContent:false,pdfSha256:original.pdfSha256});
      expect(generate.mock.calls.map(([,targetCase,id])=>[targetCase,id])).toEqual([[caseId,a.sourcingContractDocumentId]]);
      const b=await pendingRevision(caseId);
      generate.mockClear();
      const duplicate=await f.db.connect();
      try{
        await duplicate.query("BEGIN");
        expect(await f.contracts.prepareForApproval(duplicate,a.sourcingApprovalSnapshotId,f.root)).toBe(a.sourcingContractDocumentId);
        expect(await f.contracts.prepareForApproval(duplicate,a.sourcingApprovalSnapshotId,f.root,true)).toBeNull();
      }finally{await duplicate.query("ROLLBACK");duplicate.release();}
      const before=await snapshot(caseId), receiptKey=["sourcing.contract.supplement",merch.actorId,key];
      const expired=await f.db.query(`UPDATE idempotency_records SET expires_at=clock_timestamp()-interval '1 second'
        WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3 AND status='completed' RETURNING acquisition_token`,receiptKey);
      expect(expired.rowCount).toBe(1);
      const token=expired.rows[0].acquisition_token;
      const replay=await request("merchandiser",path,key,body);
      expect(replay.statusCode,replay.body).toBe(200);
      expect(replay.json().item).toEqual(signedReceipt);
      expect((await request("merchandiser",path,key,{bankAccount:"wrong"})).statusCode).toBe(409);
      expect((await request("warehouse",path,key,body)).statusCode).toBe(403);
      const saved=(await f.db.query(`SELECT response,acquisition_token FROM idempotency_records WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3`,receiptKey)).rows[0];
      expect(saved).toEqual({response:{documentId:a.sourcingContractDocumentId},acquisition_token:token});
      await f.db.query(`UPDATE idempotency_records SET response='{}'::jsonb WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3`,receiptKey);
      const ambiguous=await request("merchandiser",path,key,body);
      expect(ambiguous.statusCode).toBe(409);
      expect(ambiguous.body).toContain("原合同版本待核");
      await f.db.query(`UPDATE idempotency_records SET status='in_progress',status_code=NULL,response=NULL
        WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3`,receiptKey);
      const unfinished=await request("merchandiser",path,key,body);
      expect(unfinished.statusCode).toBe(409);
      expect(unfinished.body).toContain("IDEMPOTENCY_IN_PROGRESS");
      expect(generate).not.toHaveBeenCalled();
      expect(await current(caseId,b)).toMatchObject({status:"generation_pending",pdfAttachmentId:null,pdfSha256:null});
      expect(await snapshot(caseId)).toEqual(before);
    }finally{generate.mockRestore();}
  },120_000);

  const transferModes = [
    {name:"management direct",path:"/management",actor:"production-management",expectDocument:true},
    {name:"owner direct",path:"/owner",actor:"owner",expectDocument:true},
    {name:"merchandiser request",path:"",actor:"merchandiser",expectDocument:false},
    {name:"management forwards higher price",path:"/decision",actor:"production-management",expectDocument:false},
    {name:"management rejects",path:"/decision",actor:"production-management",expectDocument:false,reject:true},
    {name:"management approves",path:"/decision",actor:"production-management",expectDocument:true},
    {name:"owner approves",path:"/owner-decision",actor:"owner",expectDocument:true},
  ] as const satisfies readonly {name:string;path:string;actor:Alias;expectDocument:boolean;reject?:boolean}[];

  it.each(transferModes)("keeps the original $name receipt and leaves the newer contract and bulk tasks untouched",async mode=>{
    const seeded=await f.bulkReady("无",undefined,1,service,{stopBeforeCompletion:true});
    const caseId=seeded.caseId,orderId=seeded.id,base=`/sourcing/cases/${caseId}/factory-changes`;
    const proposed=await supplier(),needsDecision=mode.path.endsWith("decision"),needOwner=mode.path==="/owner-decision"||mode.name==="management forwards higher price";
    const offer={supplierId:proposed.supplierId,unitPrice:needOwner?"5.25":"5",changeReason:"TEST original turn of factory"};
    const initial=await current(caseId);
    let path=base+mode.path, body: Record<string,string>=offer;
    if(needsDecision){
      const started=await request("merchandiser",base,randomUUID(),offer);
      expect(started.statusCode,started.body).toBe(201);
      const requestId=(await f.db.query("SELECT factory_change_request_id AS id FROM sourcing_factory_change_requests WHERE sourcing_case_id=$1",[caseId])).rows[0].id;
      if(mode.path==="/owner-decision"){
        const forwards=await request("production-management",`${base}/${requestId}/decision`,randomUUID(),{decision:"approved",verificationReason:"TEST requires owner review"});
        expect(forwards.statusCode,forwards.body).toBe(201);
      }
      path=base+"/"+requestId+mode.path;
      body={decision:"reject" in mode?"rejected":"approved",verificationReason:"TEST original decision"};
    }
    const generate=vi.spyOn(f.contracts,"generateIfReady"),sync=vi.spyOn(BulkPreparationService.prototype,"sync");
    const todoCreate=vi.spyOn(todos,"actionableForAllAssignedRole"),todoClose=vi.spyOn(todos,"completeOpenByDedupePrefix");
    try{
      const key=randomUUID(),first=await request(mode.actor,path,key,body);
      expect(first.statusCode,first.body).toBe(201);
      const a=await current(caseId);
      if(mode.expectDocument){
        expect(a.sourcingContractDocumentId).not.toBe(initial.sourcingContractDocumentId);
        expect(a.status).toBe("ready");
      }else expect(a.sourcingContractDocumentId).toBe(initial.sourcingContractDocumentId);
      expect(generate.mock.calls.map(([,targetCase,id])=>[targetCase,id])).toEqual(mode.expectDocument?[[caseId,a.sourcingContractDocumentId]]:[]);
      expect(sync).toHaveBeenCalledTimes(1);
      if(mode.name==="merchandiser request"||mode.name==="management forwards higher price") expect(todoCreate).toHaveBeenCalled();
      let b: string;
      let expiredToken: string|undefined;
      let receiptKey: string[] | undefined;
      if(mode.name==="management direct"){
        const second=await supplier();
        generate.mockRejectedValueOnce(new Error("TEST stop B before starting its already committed generation"));
        const later=await request(mode.actor,path,randomUUID(),{...body,supplierId:second.supplierId});
        expect(later.statusCode,later.body).toBe(201);
        b=(await current(caseId)).sourcingContractDocumentId;
        receiptKey=["sourcing.factory-change.request.production_management",f.people["production-management"]!.actorId,key];
        const expired=await f.db.query(`UPDATE idempotency_records SET expires_at=clock_timestamp()-interval '1 second'
          WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3 AND status='completed' RETURNING acquisition_token`,receiptKey);
        expect(expired.rowCount).toBe(1);
        expiredToken=expired.rows[0].acquisition_token;
      }else b=await pendingRevision(caseId);
      expect(b).not.toBe(a.sourcingContractDocumentId);
      expect(await current(caseId,b)).toMatchObject({status:"generation_pending",pdfAttachmentId:null,pdfSha256:null});
      generate.mockClear();sync.mockClear();todoCreate.mockClear();todoClose.mockClear();
      const before=await snapshot(caseId,orderId);
      expect(before.bulk_tasks).not.toBeNull();
      const replay=await request(mode.actor,path,key,body);
      expect(replay.statusCode,replay.body).toBe(201);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(first.json());
      if(receiptKey){
        const saved=(await f.db.query(`SELECT acquisition_token,(expires_at<=clock_timestamp()) AS expired
          FROM idempotency_records WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3`,receiptKey)).rows[0];
        expect(saved).toEqual({acquisition_token:expiredToken,expired:true});
      }
      const changed=await request(mode.actor,path,key,needsDecision?{...body,decision:body.decision==="approved"?"rejected":"approved"}:{...body,changeReason:"TEST different body"});
      expect(changed.statusCode,changed.body).toBe(409);
      expect((await request("warehouse",path,key,body)).statusCode).toBe(403);
      expect(generate).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(todoCreate).not.toHaveBeenCalled();
      expect(todoClose).not.toHaveBeenCalled();
      expect(await snapshot(caseId,orderId)).toEqual(before);
    }finally{generate.mockRestore();sync.mockRestore();todoCreate.mockRestore();todoClose.mockRestore();}
  },120_000);
});
