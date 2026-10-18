import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { RootAuthority } from "../../../apps/api/src/access/root-authority.js";
import { registerExternalResponsibilityRoutes } from "../../../apps/api/src/rework/external-responsibility-routes.js";
import type { ExternalResponsibilityApplicationService } from "../../../apps/api/src/rework/external-responsibility-application-service.js";
import type { ResponsibilityDeterminationApplicationService } from "../../../apps/api/src/rework/responsibility-determination-application-service.js";
import type { TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";

// Uses the full current migration manifest and a legally completed synthetic order.
export async function exerciseRevisionApproval(input: {
  database: Pool; external: ExternalResponsibilityApplicationService;
  responsibility: ResponsibilityDeterminationApplicationService;
  orderId: string; configurationItemId: string; requester: TrustedActorContext;
  reviewer: TrustedActorContext; handler: TrustedActorContext;
  unauthorized: TrustedActorContext; signer: TrustedActorContext; paidAmount: string;
}): Promise<void> {
  const {database,external,responsibility,orderId,requester,reviewer,handler}=input;
  const rows = async (sql: string) => (await database.query(sql,[orderId])).rows;
  const immutable = async () => ({
    wages:await rows("SELECT * FROM rework_wage_items WHERE rework_order_id=$1 ORDER BY wage_item_id"),
    deductions:await rows("SELECT e.* FROM rework_external_deduction_entries e JOIN rework_external_responsibility_cases c USING(case_id) WHERE c.rework_order_id=$1 ORDER BY deduction_entry_id"),
    finalized:await rows("SELECT * FROM rework_responsibility_determinations WHERE rework_order_id=$1 AND stage='finalized' ORDER BY determination_id"),
  });
  const snapshot = async () => ({
    immutable:await immutable(),
    order:await rows("SELECT * FROM rework_orders WHERE rework_order_id=$1"),
    cases:await rows("SELECT * FROM rework_external_responsibility_cases WHERE rework_order_id=$1 ORDER BY case_id"),
    batches:await rows("SELECT * FROM rework_external_responsibility_batches WHERE rework_order_id=$1 ORDER BY batch_id"),
    revisions:await rows("SELECT r.* FROM rework_external_responsibility_revision_requests r JOIN rework_external_responsibility_cases c USING(case_id) WHERE c.rework_order_id=$1 ORDER BY revision_request_id"),
    drafts:await rows("SELECT * FROM rework_responsibility_determinations WHERE rework_order_id=$1 ORDER BY determination_id"),
    events:await rows("SELECT * FROM operation_events WHERE entity_id=$1 ORDER BY event_id"),
    todos:(await database.query("SELECT * FROM rework_todos ORDER BY todo_id")).rows,
    outbox:(await database.query("SELECT * FROM message_outbox ORDER BY event_id")).rows,
  });
  const original=await immutable();
  const batch=await external.get(requester,orderId);
  const target=batch!.cases.find(row=>row.responsibilityType==='processing_factory')!;
  const request = async () => {
    const current=await external.getCase(requester,target.caseId);
    const result=await external.requestRevision({...requester,requestId:randomUUID()},target.caseId,{
      expectedCaseVersion:current.caseVersion,
      requestedChange:{kind:'responsibility_type',configurationItemIds:[input.configurationItemId],targetResponsibilityType:'own_factory'},
      reason:'隔离回归：复核责任，不自动执行申请中的责任变更',attachmentIds:[],
    },randomUUID());
    const revision=result.value.revisionRequests.find(row=>row.status==='pending')!;
    return {id:revision.revisionRequestId, payload:{expectedCaseVersion:result.value.caseVersion,expectedRevisionVersion:revision.revisionVersion}};
  };
  let currentActor=reviewer;
  const app=Fastify();
  registerExternalResponsibilityRoutes(app,{service:external,root:new RootAuthority(database,"corp",undefined),
    authenticate:async()=>({id:currentActor.actorId,businessRoles:currentActor.actorRoles.includes("root_superuser")?[]:currentActor.actorRoles,capabilities:currentActor.actorRoles.includes("root_superuser")?[]:currentActor.authorizationCapabilities!})});
  const decide = (pending: Awaited<ReturnType<typeof request>>, action: string, key=randomUUID()) =>
    app.inject({method:'POST',url:`/external-responsibility-revision-requests/${pending.id}/${action}`,
      headers:{'idempotency-key':key},payload:{...pending.payload,...(action==='reject'?{reason:'证据不足，维持原判责'}:{})}});
  try {
    const rejected=await request();
    const beforeDenied=await snapshot();
    currentActor=input.unauthorized;
    for(const action of ['approve','reject']) expect((await decide(rejected,action)).statusCode).toBe(403);
    expect(await snapshot()).toEqual(beforeDenied);
    currentActor=reviewer;
    const rejectKey=randomUUID();
    const rejection=await decide(rejected,'reject',rejectKey);
    expect(rejection.statusCode,rejection.body).toBe(200);
    const rejectSnapshot=await snapshot();
    expect((await decide(rejected,'reject',rejectKey)).headers['idempotency-replayed']).toBe('true');
    expect(await snapshot()).toEqual(rejectSnapshot);
    expect((await external.getCase(requester,target.caseId)).status).toBe(target.status);
    expect(await immutable()).toEqual(original);

    const pending=await request();
    const before=await snapshot();
    if(!reviewer.actorRoles.includes('root_superuser')) {
      currentActor={...reviewer,authorizationCapabilities:['external_responsibility:approve_revision']};
      expect((await decide(pending,'approve')).statusCode).toBe(403);
      expect(await snapshot()).toEqual(before);
      currentActor=reviewer;
    }
    const key=randomUUID();
    // Inject a late failure after superseding the ledger, inserting the draft and
    // projecting its todo, but before the request is marked approved.
    await database.query(`CREATE FUNCTION test_revision_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='approved' THEN RAISE EXCEPTION 'synthetic late revision failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_revision_late_failure BEFORE UPDATE ON rework_external_responsibility_revision_requests
      FOR EACH ROW EXECUTE FUNCTION test_revision_late_failure()`);
    try {
      const failed=await decide(pending,'approve',key);
      expect(failed.statusCode,failed.body).toBe(500);
      expect(failed.body).toContain('synthetic late revision failure');
    } finally {
      await database.query('DROP TRIGGER test_revision_late_failure ON rework_external_responsibility_revision_requests; DROP FUNCTION test_revision_late_failure()');
    }
    expect(await snapshot()).toEqual(before);
    const approved=await decide(pending,'approve',key);
    expect(approved.statusCode,approved.body).toBe(200);
    const approvedSnapshot=await snapshot();
    const replay=await decide(pending,'approve',key);
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(approved.json());
    expect((await decide(pending,'approve')).statusCode).toBe(409);
    expect((await decide(pending,'reject')).statusCode).toBe(409);
    expect(await snapshot()).toEqual(approvedSnapshot);
    expect(await immutable()).toEqual(original);
    const draft=await responsibility.revisions.get(handler,orderId);
    expect(draft).toMatchObject({status:'pending_responsibility_determination',paidAmount:input.paidAmount});
    const audit=(await database.query(`SELECT d.handler_user_id,d.created_by,e.actor_id,e.action
      FROM rework_responsibility_determinations d JOIN operation_events e ON e.event_id=d.operation_event_id
      JOIN rework_external_responsibility_revision_requests r ON r.seeded_determination_id=d.determination_id
      WHERE r.revision_request_id=$1`,[pending.id])).rows[0];
    expect(audit).toEqual({handler_user_id:handler.actorId,created_by:reviewer.actorId,actor_id:reviewer.actorId,action:'rework.responsibility.draft'});
    const decision=(await database.query(`SELECT r.decided_by,e.actor_id,e.action FROM rework_external_responsibility_revision_requests r
      JOIN operation_events e ON e.event_id=r.decision_operation_event_id WHERE r.revision_request_id=$1`,[pending.id])).rows[0];
    expect(decision).toEqual({decided_by:reviewer.actorId,actor_id:reviewer.actorId,action:'rework.external_responsibility.revision.approved'});
    expect((await rows("SELECT recipient_user_id FROM rework_todos WHERE entity_id=$1 AND category='responsibility_determination' AND status='pending'")).map(row=>row.recipient_user_id)).toEqual([handler.actorId]);
    // Outside the matching trusted approval transaction, no new draft exception exists.
    expect((await database.query('SELECT external_revision_can_seed_draft($1,$2,$3) permitted',[reviewer.actorId,orderId,batch!.finalizedDeterminationId])).rows[0].permitted).toBe(false);
    const final=await responsibility.finalize(handler,orderId,{expectedOrderVersion:draft.orderVersion,expectedCurrentDeterminationVersion:draft.currentVersion!},randomUUID());
    if(final.value.reworkStatus==='pending_owner_signature') await responsibility.approveOwnerSignature(input.signer,orderId,{expectedOrderVersion:final.value.orderVersion},randomUUID());
    else expect(final.value.reworkStatus).toBe('completed');
    const next=await external.get(requester,orderId);
    expect(next!.cases.find(row=>row.responsibilityType==='processing_factory')!.actualDeductedAmount).toBe(target.actualDeductedAmount);
    expect((await immutable()).wages).toEqual(original.wages);
    expect((await immutable()).deductions).toEqual(original.deductions);
  } finally {await app.close();}
}
