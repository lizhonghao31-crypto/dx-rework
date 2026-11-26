import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReviseSourcingStyles, SourcingCaseSummary } from "@dx-rework/contracts";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AcceptanceDingTalkProvider, mintAcceptanceLoginCode } from "../../apps/api/src/auth/acceptance-provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { firstContractBusinessReady } from "../../apps/api/src/production-platform/contract-business-ready.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import * as poRevision from "../../apps/api/src/production-platform/sourcing-po-style-revision.js";
import { registerSourcingRoutes } from "../../apps/api/src/sourcing/sourcing-routes.js";
import { ExportJobService } from "../../apps/api/src/tools/exports.js";
import { registerToolsRoutes } from "../../apps/api/src/tools/routes.js";
import { businessAnchorFixture } from "../helpers/business-anchor-fixture.js";
import { checkSourcingStyleConflicts } from "../helpers/g8-sourcing-style-conflicts.js";

const databaseUrl = process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("G8 original sourcing revision and digital PO transaction", () => {
  type Fixture = Awaited<ReturnType<typeof businessAnchorFixture>>;
  type SeededOrder = Awaited<ReturnType<Fixture["bulkReady"]>>;
  type Reader = Pick<Pool | PoolClient, "query">;
  let f: Fixture;
  let app: ReturnType<typeof Fastify>;
  let login: Record<"merchandiser" | "owner", string>;

  beforeAll(async () => {
    f = await businessAnchorFixture(databaseUrl!);
    const root = new RootAuthority(f.db,"anchor-test","uat-root");
    const secret = "TEST original G8 signed order roles ".repeat(2);
    const auth = new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),
      new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
    const aliases = ["merchandiser","owner"] as const;
    const sessions = await Promise.all(aliases.map(alias => auth.loginMobile(mintAcceptanceLoginCode(alias,secret))));
    login = Object.fromEntries(aliases.map((alias,index)=>[alias,sessions[index]!.token])) as typeof login;
    const authenticate = (token: string | undefined) => auth.authenticate(token);
    const identity = new DigitalProductionIdentityService(f.db,true,f.sourcing);
    app = Fastify();
    registerSourcingRoutes(app,{service:f.sourcing,contracts:f.contracts,root,authenticate});
    registerDigitalIdentityRoutes(app,{service:identity,root,authenticate,creationEnabled:true});
    registerToolsRoutes(app,{authenticate,attachments:f.attachments,exports:new ExportJobService(f.db),
      canDownloadBoundAttachment:async (actor,binding)=>f.sourcing.canDownloadBoundAttachment({
        ...actor,authorizationCapability:"sourcing:view",authorizationCapabilities:actor.capabilities,requestId:"TEST-G8-ORIGINAL-PDF",
      },binding)});
  },120_000);

  afterAll(async () => {
    await app?.close();
    await f?.dispose();
  });

  const sourcingPath = (caseId:string) => `/sourcing/cases/${caseId}`;
  const orderPath = (orderId:string) => `/digital-production/orders/${orderId}`;
  const merchant = () => ({dx_rework_session:login.merchandiser});
  async function get<T>(url: string, actor: keyof typeof login = "merchandiser") {
    const response = await app.inject({method:"GET",url,cookies:{dx_rework_session:login[actor]}});
    expect(response.statusCode,response.body).toBe(200);
    return response.json<T>();
  }
  const readCase = (caseId:string) => get<SourcingCaseSummary>(sourcingPath(caseId));
  const readOrder = (orderId:string) => get<DigitalOrder>(orderPath(orderId));
  const styles = (record:SourcingCaseSummary): ReviseSourcingStyles["lines"] => record.lineItems.map(line=>({
    position:line.position,styleNo:line.formalStyleNo===undefined?line.styleNo:line.formalStyleNo,alternateStyleNo:line.alternateStyleNo,
  }));
  const revise = (caseId:string,key:string,payload:ReviseSourcingStyles) => app.inject({
    method:"POST",url:`${sourcingPath(caseId)}/styles`,cookies:merchant(),headers:{"idempotency-key":key},payload,
  });

  async function native(poCount = 2, explicitTemporary = false) {
    const prepare = () => f.bulkReady("无",undefined,poCount,f.sourcing,{stopBeforeCompletion:true});
    if (!explicitTemporary) return prepare();
    // Use the fixture's native order command with explicit legal PO temporary numbers.
    const create = DigitalProductionIdentityService.prototype.createOrder;
    const numberInput = vi.spyOn(DigitalProductionIdentityService.prototype,"createOrder")
      .mockImplementationOnce(function (...args) {
        const [actor,input,key] = args;
        return create.call(this,actor,{
          ...input,lines:input.lines.map((line,index)=>({...line,temporaryStyleNo:`${input.designStyleNo}-TEMP-${index+1}`})),
        },key);
      });
    try { return await prepare(); }
    finally { numberInput.mockRestore(); }
  }

  async function snapshot(order: SeededOrder, db: Reader = f.db) {
    return (await db.query(`
      WITH document AS (SELECT * FROM sourcing_contract_documents WHERE sourcing_case_id=$2::uuid),
           approval AS (SELECT * FROM sourcing_approval_snapshots WHERE sourcing_case_id=$2::uuid),
           line_scope AS (SELECT * FROM digital_production_po_lines WHERE production_order_id=$1::uuid),
           task AS (SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
                    WHERE a.production_order_id=$1::uuid)
      SELECT (SELECT to_jsonb(o) FROM digital_production_orders o WHERE o.production_order_id=$1::uuid) AS mother,
             (SELECT jsonb_agg(to_jsonb(line_scope) ORDER BY position) FROM line_scope) AS lines,
             (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.line_id,s.size) FROM digital_production_po_sizes s JOIN line_scope USING(line_id)) AS sizes,
             (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.revision),'[]'::jsonb) FROM sourcing_style_revisions r
              WHERE r.sourcing_case_id=$2::uuid) AS revisions,
             (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.event_id),'[]'::jsonb) FROM operation_events e
              WHERE e.action='sourcing.styles.revise' AND e.entity_type='sourcing_case' AND e.entity_id=$2::text) AS style_events,
             (SELECT jsonb_agg(to_jsonb(approval) ORDER BY decision_version) FROM approval) AS approvals,
             (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.sourcing_approval_snapshot_id,a.position) FROM sourcing_approval_snapshot_lines a
              JOIN approval USING(sourcing_approval_snapshot_id)) AS approval_lines,
             (SELECT jsonb_agg(to_jsonb(document) ORDER BY contract_version) FROM document) AS documents,
             (SELECT jsonb_agg(to_jsonb(file) ORDER BY file.attachment_id) FROM attachments file
              JOIN document ON file.entity_id=document.sourcing_contract_document_id::text
              WHERE file.entity_type='sourcing_contract_document' AND file.mime_type='application/pdf') AS pdfs,
             (SELECT jsonb_agg(to_jsonb(stage) ORDER BY stage.generation_attempt_id) FROM sourcing_contract_generation_staging stage
              JOIN document USING(sourcing_contract_document_id)) AS staging,
             (SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.sourcing_contract_document_id)
              FROM sourcing_contract_business_ready_facts fact WHERE fact.sourcing_case_id=$2::uuid) AS ready_facts,
             (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.revision_id) FROM digital_production_deadline_revisions d JOIN task USING(task_id)) AS deadlines,
             (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.todo_id) FROM rework_todos t
              WHERE t.entity_type='sourcing_case' AND t.entity_id=$2::text) AS todos`,[order.id,order.caseId])).rows[0];
  }

  const styleReceipt = async (key:string,db:Reader = f.db) => (await db.query(`
    SELECT status,request_hash,response FROM idempotency_records WHERE scope='sourcing.styles.revise' AND actor_key=$1 AND idempotency_key=$2`,
    [f.people.merchandiser!.actorId,key])).rows;

  async function checkPdf(attachmentId:string,expectedSha:string) {
    const download = await app.inject({method:"GET",url:`/tools/attachments/${attachmentId}/download?mode=download`,cookies:merchant()});
    expect(download.statusCode,download.body).toBe(302);
    const key = decodeURIComponent(new URL(download.headers.location!).pathname.slice(1));
    const bytes = await f.storage.readBytes(key,1_000_000);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha);
  }

  it.each(["persisted","inherited"] as const)(
    "changes only the original target PO in both directions when the other temporary number is %s",
    async temporary => {
      const target = await native(2,temporary==="persisted"), other = await native(1);
      const initialCase = await readCase(target.caseId), initialOrder = await readOrder(target.id);
      const initial = await snapshot(target), outside = await snapshot(other);
      const clock = await firstContractBusinessReady(f.db,target.id);
      const approvalHistory = `${sourcingPath(target.caseId)}/history/owner`;
      const oldApproval = await get(approvalHistory,"owner");
      const oldPdf = initial.documents[0];
      expect(initial.lines).toHaveLength(2);
      expect(initial.lines[1].temporary_style_no===null).toBe(temporary==="inherited");
      await checkPdf(oldPdf.pdf_attachment_id,oldPdf.pdf_sha256);
      const matchAnotherOrder = (await readOrder(other.id)).lines[0]!.formalPoNo!;
      const newAlternate = "TEST-G8-ALT-"+randomUUID();
      const input = {expectedRevision:initialCase.identityRevision??0,lines:styles(initialCase),confirmedDuplicateStyles:[matchAnotherOrder]};
      input.lines[0] = {...input.lines[0]!,styleNo:matchAnotherOrder,alternateStyleNo:newAlternate};
      const key = randomUUID();
      const prepare = vi.spyOn(f.contracts,"prepareForApproval");
      const generate = vi.spyOn(f.contracts,"generateIfReady");
      const reverse = vi.spyOn(f.sourcing,"reviseDigitalNumbersWithClient");
      const external = vi.spyOn(f.sourcing,"reviseStyles");
      const write = poRevision.writeSourcingPoStyleRevision;
      const compareMappings = vi.spyOn(poRevision,"writeSourcingPoStyleRevision").mockImplementationOnce(async (client,targetInput) => {
        expect(targetInput.caseId).toBe(target.caseId);
        expect(targetInput.workflowGeneration).toBe("digital_production_v1");
        expect(targetInput.lines).toEqual(input.lines.map((line,index)=>({...line,changed:index===0})));
        // Replay the old UPDATE's FROM/WHERE as SELECT on this same, already
        // locked transaction. Observe the new mapping and resulting values
        // without executing the old write or adding a production dry-run.
        const oldTargets = [];
        for (const line of input.lines) {
          const rows = (await client.query(`
            SELECT production_order_id,line_id,po_number,formal_style_no,temporary_style_no FROM digital_production_po_lines p
            WHERE EXISTS(SELECT 1 FROM digital_production_child_lines l WHERE l.module='sourcing'
              AND l.child_id=$1 AND l.child_line_key=$2 AND p.line_id=l.line_id)`,
          [target.caseId,String(line.position)])).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({production_order_id:target.id,line_id:initialOrder.lines[line.position-1]!.lineId});
          oldTargets.push({...rows[0],po_number:line.styleNo,formal_style_no:line.styleNo,temporary_style_no:line.alternateStyleNo});
        }
        const nextVersion = (await client.query<{version:number}>(
          "SELECT version+1 AS version FROM digital_production_orders WHERE production_order_id=$1",[target.id],
        )).rows[0]!.version;
        expect(nextVersion).toBe(initialOrder.version+1);
        await write(client,targetInput);
        const written = (await client.query(`
          SELECT production_order_id,line_id,po_number,formal_style_no,temporary_style_no
          FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[target.id])).rows;
        expect(written.map(row=>row.line_id)).toEqual(oldTargets.map(row=>row.line_id));
        expect(written[0]).toEqual(oldTargets[0]);
        expect(written[1]).toEqual(temporary==="persisted"?oldTargets[1]:{...oldTargets[1],temporary_style_no:null});
        expect((await client.query("SELECT version FROM digital_production_orders WHERE production_order_id=$1",[target.id])).rows[0])
          .toEqual({version:nextVersion});
      });
      try {
        const forward = await revise(target.caseId,key,input);
        expect(forward.statusCode,forward.body).toBe(200);
        const returned = forward.json<SourcingCaseSummary>();
        const after = await snapshot(target);
        expect(returned.identityRevision).toBe(input.expectedRevision+1);
        expect(after.mother).toEqual({...initial.mother,version:initial.mother.version+1});
        expect(after.lines[0]).toEqual({...initial.lines[0],po_number:matchAnotherOrder,formal_style_no:matchAnotherOrder,temporary_style_no:newAlternate});
        expect(after.lines[1]).toEqual(initial.lines[1]);
        expect(after.sizes).toEqual(initial.sizes);
        expect(after.approvals).toEqual(initial.approvals);
        expect(after.approval_lines).toEqual(initial.approval_lines);
        expect(after.revisions).toHaveLength(initial.revisions.length+1);
        expect(after.style_events).toHaveLength(initial.style_events.length+1);
        expect(after.documents).toHaveLength(initial.documents.length+1);
        expect(after.documents[0]).toEqual(oldPdf);
        expect(after.ready_facts.filter((fact: {is_first_for_case:boolean})=>fact.is_first_for_case)).toEqual(initial.ready_facts);
        expect(after.deadlines).toEqual(initial.deadlines);
        expect(await firstContractBusinessReady(f.db,target.id)).toEqual(clock);
        expect(await snapshot(other)).toEqual(outside);
        expect(await styleReceipt(key)).toEqual([expect.objectContaining({status:"completed",response:returned})]);
        const generated = after.documents.at(-1);
        expect(generated).toMatchObject({contract_version:oldPdf.contract_version+1,status:"ready"});
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(compareMappings).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls.map(([,caseId,documentId])=>[caseId,documentId])).toEqual([[target.caseId,generated.sourcing_contract_document_id]]);
        expect(reverse).not.toHaveBeenCalled();
        expect(await readCase(target.caseId)).toMatchObject({identityRevision:input.expectedRevision+1,lineItems:[
          expect.objectContaining({formalStyleNo:matchAnotherOrder,alternateStyleNo:newAlternate}),
          expect.objectContaining({formalStyleNo:initialCase.lineItems[1]!.formalStyleNo,alternateStyleNo:initialCase.lineItems[1]!.alternateStyleNo}),
        ]});
        const refreshed = await readOrder(target.id);
        expect(refreshed.version).toBe(initialOrder.version+1);
        expect(refreshed.lines[0]).toMatchObject({lineId:initialOrder.lines[0]!.lineId,formalPoNo:matchAnotherOrder,temporaryStyleNo:newAlternate});
        expect(refreshed.lines[1]).toEqual(initialOrder.lines[1]);
        expect(await get(approvalHistory,"owner")).toEqual(oldApproval);
        const directory = await get<{contracts:unknown[]}>(`${sourcingPath(target.caseId)}/contract-directory`);
        expect(directory.contracts).toEqual(expect.arrayContaining([expect.objectContaining({pdfAttachmentId:oldPdf.pdf_attachment_id,pdfStatus:"ready"})]));
        await checkPdf(oldPdf.pdf_attachment_id,oldPdf.pdf_sha256);
        await checkPdf(generated.pdf_attachment_id,generated.pdf_sha256);

        prepare.mockClear(); generate.mockClear(); external.mockClear();
        const reverseNumber = "TEST-G8-REVERSE-"+randomUUID();
        const back = await app.inject({method:"PATCH",
          url:`${orderPath(target.id)}/lines/${initialOrder.lines[1]!.lineId}/numbers`,cookies:merchant(),
          headers:{"idempotency-key":randomUUID()},payload:{expectedVersion:refreshed.version,formalPoNo:reverseNumber}});
        expect(back.statusCode,back.body).toBe(200);
        expect(back.json<DigitalOrder>()).toMatchObject({version:refreshed.version+1});
        const final = await snapshot(target);
        expect(final.mother.version).toBe(refreshed.version+1);
        expect(final.lines[0]).toEqual(after.lines[0]);
        expect(final.lines[1]).toEqual({...after.lines[1],po_number:reverseNumber,formal_style_no:reverseNumber});
        expect(final.revisions).toHaveLength(after.revisions.length+1);
        expect(final.style_events).toHaveLength(after.style_events.length+1);
        expect(final.documents).toHaveLength(after.documents.length+1);
        expect(external).not.toHaveBeenCalled();
        expect(reverse).toHaveBeenCalledTimes(1);
        expect(compareMappings).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls.map(([,caseId,documentId])=>[caseId,documentId])).toEqual([[target.caseId,final.documents.at(-1).sourcing_contract_document_id]]);
        expect(await snapshot(other)).toEqual(outside);
        expect(await firstContractBusinessReady(f.db,target.id)).toEqual(clock);
        console.log(JSON.stringify({scenario:temporary, caseId:target.caseId,motherId:target.id,anotherMotherId:other.id,
          lineIds:initialOrder.lines.map(line=>line.lineId),versions:[initial.mother.version,after.mother.version,final.mother.version],
          contractIds:final.documents.map((row:{sourcing_contract_document_id:string})=>row.sourcing_contract_document_id),
          pdfSha256:[oldPdf.pdf_sha256,generated.pdf_sha256],clock,otherUnchanged:true,sameLockOldNewMappingCompared:true}));
      } finally { prepare.mockRestore(); generate.mockRestore(); reverse.mockRestore(); external.mockRestore(); compareMappings.mockRestore(); }
    },120_000,
  );

  it("rolls back a real SQL failure after both PO and contract preparation writes and accepts the same key once", async () => {
    const target = await native(2,true), key = randomUUID();
    const initialCase = await readCase(target.caseId);
    const before = await snapshot(target);
    const input = {expectedRevision:initialCase.identityRevision??0,lines:styles(initialCase)};
    const requestedStyle = "TEST-G8-ROLLBACK-"+randomUUID();
    input.lines[0] = {...input.lines[0]!,styleNo:requestedStyle};
    const entered = Promise.withResolvers<{pid:number; documentId:string}>();
    const release = Promise.withResolvers<void>();
    const originalPrepare = f.contracts.prepareForApproval.bind(f.contracts);
    const prepare = vi.spyOn(f.contracts,"prepareForApproval").mockImplementationOnce(async (transaction,approvalId,actor,newDocumentOnly) => {
      try {
        const documentId = newDocumentOnly ? await originalPrepare(transaction,approvalId,actor,newDocumentOnly)
          : await originalPrepare(transaction,approvalId,actor);
        expect(documentId).toBeTruthy();
        const inside = await snapshot(target,transaction);
        expect(inside.mother.version).toBe(before.mother.version+1);
        expect(inside.lines[0].po_number).toBe(requestedStyle);
        expect(inside.revisions).toHaveLength(before.revisions.length+1);
        expect(inside.style_events).toHaveLength(before.style_events.length+1);
        expect(inside.documents.at(-1)).toMatchObject({sourcing_contract_document_id:documentId,status:"generation_pending"});
        expect(await styleReceipt(key,transaction)).toEqual([expect.objectContaining({status:"in_progress"})]);
        const pid = (await transaction.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        entered.resolve({pid,documentId:documentId!});
        await release.promise;
        await transaction.query("SELECT 1 / 0");
        return documentId;
      } catch (error) {
        entered.reject(error);
        throw error;
      }
    });
    const generation = vi.spyOn(f.contracts,"generateIfReady");
    const observer = await f.db.connect();
    const rejected = revise(target.caseId,key,input);
    try {
      const checkpoint = await Promise.race([
        entered.promise,
        rejected.then(response=>{throw new Error(`The request finished before the real PO/contract breakpoint: ${response.statusCode} ${response.body}`);}),
        delay(10_000).then(()=>{throw new Error("Timed out waiting for the PO/contract breakpoint");}),
      ]);
      const observerPid = (await observer.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      expect(observerPid).not.toBe(checkpoint.pid);
      expect(await snapshot(target,observer)).toEqual(before);
      expect(await styleReceipt(key,observer)).toEqual([]);
      release.resolve();
      const failed = await rejected;
      expect(failed.statusCode,failed.body).toBe(500);
      expect(failed.json().message).toContain("division by zero");
      expect(await snapshot(target,observer)).toEqual(before);
      expect(await styleReceipt(key,observer)).toEqual([]);
      expect(generation).not.toHaveBeenCalled();

      const retry = await revise(target.caseId,key,input);
      expect(retry.statusCode,retry.body).toBe(200);
      const committed = await snapshot(target,observer);
      expect(committed.mother.version).toBe(before.mother.version+1);
      expect(committed.lines[0].po_number).toBe(requestedStyle);
      expect(committed.lines[1]).toEqual(before.lines[1]);
      expect(committed.revisions).toHaveLength(before.revisions.length+1);
      expect(committed.style_events).toHaveLength(before.style_events.length+1);
      expect(committed.documents).toHaveLength(before.documents.length+1);
      expect(committed.documents[0]).toEqual(before.documents[0]);
      expect(committed.documents.at(-1)).toMatchObject({status:"ready"});
      expect(committed.documents.at(-1).sourcing_contract_document_id).not.toBe(checkpoint.documentId);
      expect(generation.mock.calls.map(([,caseId,documentId])=>[caseId,documentId])).toEqual([[target.caseId,committed.documents.at(-1).sourcing_contract_document_id]]);
      expect(await styleReceipt(key,observer)).toEqual([expect.objectContaining({status:"completed",response:retry.json()})]);
      const replay = await revise(target.caseId,key,input);
      expect(replay.statusCode,replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(retry.json());
      expect(generation).toHaveBeenCalledTimes(1);
      expect(await snapshot(target,observer)).toEqual(committed);
      console.log(JSON.stringify({scenario:"late same transaction SQL failure",caseId:target.caseId,motherId:target.id,
        writerBackend:checkpoint.pid,observerBackend:observerPid,rolledBackDocument:checkpoint.documentId,
        committedDocument:committed.documents.at(-1).sourcing_contract_document_id,statuses:[failed.statusCode,retry.statusCode,replay.statusCode]}));
    } finally {
      release.resolve();
      await rejected.catch(()=>undefined);
      observer.release();
      prepare.mockRestore(); generation.mockRestore();
    }
  },120_000);

  it("rejects invalid mappings through the signed route and replays only the concurrency winner", async () => {
    await checkSourcingStyleConflicts(f);
  },120_000);
});
