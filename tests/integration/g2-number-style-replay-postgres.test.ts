import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { SourcingCaseSummary } from "@dx-rework/contracts";
import { businessActor } from "../../apps/api/src/access/business-authority.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AcceptanceDingTalkProvider, mintAcceptanceLoginCode } from "../../apps/api/src/auth/acceptance-provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { registerSourcingRoutes } from "../../apps/api/src/sourcing/sourcing-routes.js";
import { businessAnchorFixture } from "../helpers/business-anchor-fixture.js";

const databaseUrl = process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("G2 original digital PO and sourcing style revision replay", () => {
  type Fixture = Awaited<ReturnType<typeof businessAnchorFixture>>;
  type SeededOrder = Awaited<ReturnType<Fixture["bulkReady"]>>;
  let f: Fixture;
  let app: ReturnType<typeof Fastify>;
  let identity: DigitalProductionIdentityService;
  let login: Record<"root" | "merchandiser" | "sample-designer" | "warehouse", string>;
  let root: RootAuthority;
  let auth: AuthService;

  beforeAll(async () => {
    f = await businessAnchorFixture(databaseUrl!);
    root = new RootAuthority(f.db,"anchor-test","uat-root");
    const secret = "TEST signed original G2 number and styles roles ".repeat(2);
    auth = new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),
      new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
    const aliases = ["root","merchandiser","sample-designer","warehouse"] as const;
    const sessions = await Promise.all(aliases.map(alias => auth.loginMobile(mintAcceptanceLoginCode(alias,secret))));
    login = Object.fromEntries(aliases.map((alias,index) => [alias,sessions[index]!.token])) as typeof login;
    app = Fastify();
    identity = new DigitalProductionIdentityService(f.db,true,f.sourcing);
    const authenticate = (token: string | undefined) => auth.authenticate(token);
    registerDigitalIdentityRoutes(app,{service:identity,root,creationEnabled:true,authenticate});
    registerSourcingRoutes(app,{service:f.sourcing,contracts:f.contracts,root,authenticate});
  },120_000);

  afterAll(async () => {
    await app?.close();
    await f?.dispose();
  });

  const native = (poCount = 2) => f.bulkReady("无",undefined,poCount,f.sourcing,{stopBeforeCompletion:true});
  const currentContract = (caseId: string) => f.contracts.getCurrent(f.root,caseId).then(value => value.item!);
  const originalIdentity = async (caseId: string) => {
    const response = await app.inject({method:"GET",url:`/sourcing/cases/${caseId}`,cookies:{dx_rework_session:login.merchandiser}});
    expect(response.statusCode,response.body).toBe(200);
    return response.json<SourcingCaseSummary>();
  };
  const digitalPath = (orderId: string,lineId: string) => `/digital-production/orders/${orderId}/lines/${lineId}/numbers`;
  const stylesPath = (caseId: string) => `/sourcing/cases/${caseId}/styles`;
  const request = (method: "PATCH" | "POST", url: string, actor: keyof typeof login, key: string, payload: object) =>
    app.inject({method,url,cookies:{dx_rework_session:login[actor]},headers:{"idempotency-key":key},payload});

  async function preparePendingB(caseId: string) {
    const edit = await f.contracts.content.get(f.root,caseId);
    const documentId = await f.contracts.content.save(f.root,caseId,
      {...edit,content:{...edit.content,contractTitle:"TEST authorized later revision B"}},randomUUID());
    expect(await currentContract(caseId)).toMatchObject({
      sourcingContractDocumentId:documentId,status:"generation_pending",pdfAttachmentId:null,pdfSha256:null,generatedAt:null,
    });
    return documentId;
  }

  async function snapshot({id,caseId}: SeededOrder) {
    return (await f.db.query(`
      WITH document AS (SELECT * FROM sourcing_contract_documents WHERE sourcing_case_id=$2::uuid),
           task AS (SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
                    WHERE a.production_order_id=$1::uuid)
      SELECT (SELECT jsonb_agg(to_jsonb(document) ORDER BY contract_version) FROM document) AS documents,
             (SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.sourcing_contract_document_id)
              FROM sourcing_contract_business_ready_facts fact WHERE fact.sourcing_case_id=$2::uuid) AS ready_facts,
             (SELECT jsonb_agg(to_jsonb(file) ORDER BY file.attachment_id) FROM attachments file
              JOIN document ON file.entity_id=document.sourcing_contract_document_id::text
              WHERE file.entity_type='sourcing_contract_document' AND file.mime_type='application/pdf') AS pdfs,
             (SELECT jsonb_agg(to_jsonb(stage) ORDER BY stage.generation_attempt_id) FROM sourcing_contract_generation_staging stage
              JOIN document USING(sourcing_contract_document_id)) AS staging,
             (SELECT jsonb_agg(to_jsonb(todo) ORDER BY todo.todo_id) FROM rework_todos todo
              WHERE todo.entity_type='sourcing_case' AND todo.entity_id=$2::text) AS contract_todos,
             (SELECT jsonb_agg(to_jsonb(task) ORDER BY task.task_id) FROM task) AS tasks,
             (SELECT jsonb_agg(to_jsonb(event) ORDER BY event.event_id) FROM digital_production_task_events event JOIN task USING(task_id)) AS task_events,
             (SELECT jsonb_agg(to_jsonb(deadline) ORDER BY deadline.revision_id)
              FROM digital_production_deadline_revisions deadline JOIN task USING(task_id)) AS deadlines,
             (SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision.revision) FROM sourcing_style_revisions revision
              WHERE revision.sourcing_case_id=$2::uuid) AS revisions,
             (SELECT jsonb_agg(to_jsonb(event) ORDER BY event.event_id) FROM operation_events event
              WHERE (event.entity_type='sourcing_case' AND event.entity_id=$2::text)
                 OR (event.entity_type='sourcing_contract_document' AND event.entity_id IN
                     (SELECT sourcing_contract_document_id::text FROM document))) AS operations,
             (SELECT to_jsonb(o) FROM digital_production_orders o WHERE o.production_order_id=$1::uuid) AS mother,
             (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.position) FROM digital_production_po_lines p
              WHERE p.production_order_id=$1::uuid) AS lines`,[id,caseId])).rows[0];
  }

  it("lets the original designer publish only the corrected document without granting a contract read role", async () => {
    const order=await native();
    const actor=await businessActor(root,await auth.authenticate(login["sample-designer"]),randomUUID(),"pattern_room:orders:create");
    expect(actor.authorizationCapabilities).not.toContain("sourcing:view");
    const initial=await identity.read(actor,order.id),line=initial.lines[0]!,url=digitalPath(order.id,line.lineId);
    const first=await request("PATCH",url,"sample-designer",randomUUID(),{expectedVersion:initial.version,formalPoNo:"TEST-G2-DESIGNER-A"});
    expect(first.statusCode,first.body).toBe(200);
    const a=await currentContract(order.caseId);
    expect(a).toMatchObject({status:"ready",pdfSha256:expect.stringMatching(/^[0-9a-f]{64}$/)});
    const noRead=await app.inject({method:"GET",url:`/sourcing/cases/${order.caseId}/contract`,cookies:{dx_rework_session:login["sample-designer"]}});
    expect(noRead.statusCode,noRead.body).toBe(403);
    const client=await f.db.connect();
    try{
      await client.query("BEGIN");
      await identity.inTransaction(client).correctNumbers(actor,order.id,line.lineId,
        {expectedVersion:initial.version+1,formalPoNo:"TEST-G2-DESIGNER-B"},randomUUID());
      expect(await currentContract(order.caseId)).toEqual(a);
      await client.query("COMMIT");
    }finally{await client.query("ROLLBACK");client.release();}
    const b=await currentContract(order.caseId);
    expect(b).toMatchObject({status:"generation_pending",contractVersion:a.contractVersion+1});
    const resumed=await f.contracts.resumePendingContracts(1);
    expect(resumed).toMatchObject({candidates:1,advanced:1,ready:1});
    expect(await currentContract(order.caseId)).toMatchObject({sourcingContractDocumentId:b.sourcingContractDocumentId,status:"ready"});
    const publication=(await f.db.query(`SELECT e.actor_id,e.authorization_capability FROM sourcing_contract_business_ready_facts f
      JOIN operation_events e ON e.event_id=f.operation_event_id WHERE f.sourcing_contract_document_id=$1`,[b.sourcingContractDocumentId])).rows[0];
    expect(publication).toEqual({actor_id:actor.actorId,authorization_capability:"pattern_room:orders:create"});
  },120_000);

  it("replays only A from the real digital PO PATCH, including same-key races and a committed later B", async () => {
    const order = await native(), separate = await native(1);
    const initial = await identity.read(f.people.merchandiser!,order.id);
    expect(initial.lines).toHaveLength(2);
    const link = (await f.db.query("SELECT child_id FROM digital_production_child_links WHERE production_order_id=$1 AND module='sourcing'",[order.id])).rows;
    expect(link).toEqual([{child_id:order.caseId}]);
    const untouched = await snapshot(separate);
    const original = await currentContract(order.caseId);
    const line = initial.lines[0]!, url = digitalPath(order.id,line.lineId), key = randomUUID();
    const body = {expectedVersion:initial.version,formalPoNo:"TEST-G2-PO-A-"+randomUUID()};
    const generation = vi.spyOn(f.contracts,"generateIfReady");
    try {
      const firstPair = await Promise.all([request("PATCH",url,"merchandiser",key,body),request("PATCH",url,"merchandiser",key,body)]);
      for(const response of firstPair) expect(response.statusCode,response.body).toBe(200);
      const receipt = firstPair[0]!.json<DigitalOrder>();
      expect(firstPair[1]!.json()).toEqual(receipt);
      expect(receipt).toMatchObject({productionOrderId:order.id,version:initial.version+1});
      expect(receipt.lines[0]?.formalPoNo).toBe(body.formalPoNo);
      expect(receipt.lines[1]).toEqual(initial.lines[1]);
      const a = await currentContract(order.caseId);
      expect(a.contractVersion).toBe(original.contractVersion+1);
      expect(a.status).toBe("ready");
      expect.soft(generation.mock.calls.map(([,caseId,documentId]) => [caseId,documentId])).toEqual([[order.caseId,a.sourcingContractDocumentId]]);
      await preparePendingB(order.caseId);
      const before = await snapshot(order);
      generation.mockClear();
      const replay = await request("PATCH",url,"merchandiser",key,body);
      expect(replay.statusCode,replay.body).toBe(200);
      expect(replay.json()).toEqual(receipt);
      const mismatched = await request("PATCH",url,"merchandiser",key,{...body,formalPoNo:"TEST-G2-ALTERED"});
      expect(mismatched.statusCode,mismatched.body).toBe(409);
      const unauthorized = await request("PATCH",url,"warehouse",key,body);
      expect([403,404]).toContain(unauthorized.statusCode);
      expect.soft(generation).not.toHaveBeenCalled();
      expect(await snapshot(order)).toEqual(before);
      expect(await snapshot(separate)).toEqual(untouched);
      expect(await f.contracts.getCurrent(f.root,order.caseId,a.sourcingContractDocumentId)).toEqual({item:a});
      const commands = (await f.db.query("SELECT response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3",
        [f.people.merchandiser!.actorId,`numbers:${order.id}:${line.lineId}`,key])).rows;
      expect(commands).toEqual([{response:receipt}]);
      const audit = (await f.db.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='digital_numbers_corrected'",[order.id])).rowCount;
      expect(audit).toBe(1);
    } finally { generation.mockRestore(); }
  },120_000);

  it("keeps a caller-owned digital transaction free of generation until a committed document exists", async () => {
    const order = await native();
    const actor = await businessActor(root,await auth.authenticate(login.root),randomUUID(),"pattern_room:orders:create");
    const initial = await identity.read(actor,order.id), line = initial.lines[0]!;
    const original = await snapshot(order);
    const generation = vi.spyOn(f.contracts,"generateIfReady");
    const client = await f.db.connect();
    try {
      const txn = identity.inTransaction(client);
      const apply = () => txn.correctNumbers(actor,order.id,line.lineId,
        {expectedVersion:initial.version,formalPoNo:"TEST-G2-OUTER-TX"},randomUUID());
      await client.query("BEGIN");
      const discarded = await apply();
      expect(discarded.version).toBe(initial.version+1);
      expect(await snapshot(order)).toEqual(original);
      const lastPending = () => client.query(`SELECT sourcing_contract_document_id,status FROM sourcing_contract_documents
        WHERE sourcing_case_id=$1 ORDER BY contract_version DESC LIMIT 1`,[order.caseId]).then(result=>result.rows[0]);
      expect(await lastPending()).toMatchObject({status:"generation_pending"});
      await client.query("ROLLBACK");
      expect(await snapshot(order)).toEqual(original);
      expect(generation).not.toHaveBeenCalled();

      await client.query("BEGIN");
      await apply();
      const target = await lastPending();
      expect(target).toMatchObject({status:"generation_pending"});
      expect(await snapshot(order)).toEqual(original);
      expect(generation).not.toHaveBeenCalled();
      await client.query("COMMIT");
      expect(await currentContract(order.caseId)).toMatchObject({sourcingContractDocumentId:target.sourcing_contract_document_id,status:"generation_pending"});
      const manual = await request("POST",`/sourcing/cases/${order.caseId}/contract/generate`,"merchandiser",randomUUID(),{});
      expect(manual.statusCode,manual.body).toBe(200);
      expect(manual.json().item).toMatchObject({sourcingContractDocumentId:target.sourcing_contract_document_id,status:"ready"});
    } finally {
      await client.query("ROLLBACK");
      client.release();
      generation.mockRestore();
    }
  },120_000);

  it("returns the original styles response, including expired replay, without generating later B or a no-op", async () => {
    const order = await native();
    const initial = await originalIdentity(order.caseId), url = stylesPath(order.caseId), key = randomUUID();
    const styles = (record: SourcingCaseSummary) => record.lineItems.map(line => ({
      position:line.position,styleNo:line.formalStyleNo === undefined ? line.styleNo : line.formalStyleNo,alternateStyleNo:line.alternateStyleNo,
    }));
    const body = {expectedRevision:initial.identityRevision??0,lines:styles(initial)};
    body.lines[0]!.styleNo = "TEST-G2-STYLE-A-"+randomUUID();
    const original = await currentContract(order.caseId);
    const generation = vi.spyOn(f.contracts,"generateIfReady");
    try {
      const first = await request("POST",url,"merchandiser",key,body);
      expect(first.statusCode,first.body).toBe(200);
      const receipt = first.json<SourcingCaseSummary>();
      expect(receipt.identityRevision).toBe(body.expectedRevision+1);
      const a = await currentContract(order.caseId);
      expect(a).toMatchObject({status:"ready",contractVersion:original.contractVersion+1});
      expect.soft(generation.mock.calls.map(([,caseId,documentId]) => [caseId,documentId])).toEqual([[order.caseId,a.sourcingContractDocumentId]]);
      generation.mockClear();
      const noop = await request("POST",url,"merchandiser",randomUUID(),{expectedRevision:receipt.identityRevision,lines:styles(receipt)});
      expect(noop.statusCode,noop.body).toBe(200);
      expect.soft(generation).not.toHaveBeenCalled();
      generation.mockClear();
      await preparePendingB(order.caseId);
      const before = await snapshot(order);
      const checkReplay = async () => {
        const replay = await request("POST",url,"merchandiser",key,body);
        expect(replay.statusCode,replay.body).toBe(200);
        expect(replay.headers["idempotency-replayed"]).toBe("true");
        expect(replay.json()).toEqual(receipt);
        expect(generation).not.toHaveBeenCalled();
        expect(await snapshot(order)).toEqual(before);
      };
      await checkReplay();
      const expired = await f.db.query(`UPDATE idempotency_records SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 day'
        WHERE scope='sourcing.styles.revise' AND actor_key=$1 AND idempotency_key=$2 AND status='completed'
        RETURNING acquisition_token,request_hash,response,updated_at,expires_at`,[f.people.merchandiser!.actorId,key]);
      expect(expired.rowCount).toBe(1);
      await checkReplay();
      const stored = (await f.db.query(`SELECT acquisition_token,request_hash,response,updated_at,expires_at
        FROM idempotency_records WHERE scope='sourcing.styles.revise' AND actor_key=$1 AND idempotency_key=$2`,[f.people.merchandiser!.actorId,key])).rows;
      expect(stored).toEqual(expired.rows);
      const changed = await request("POST",url,"merchandiser",key,{...body,lines:body.lines.map((line,i)=>i?line:{...line,styleNo:"TEST-ALTERNATE"})});
      expect(changed.statusCode,changed.body).toBe(409);
      const forbidden = await request("POST",url,"warehouse",key,body);
      expect(forbidden.statusCode,forbidden.body).toBe(403);
      expect(generation).not.toHaveBeenCalled();
      expect(await snapshot(order)).toEqual(before);
    } finally { generation.mockRestore(); }
  },120_000);
});
