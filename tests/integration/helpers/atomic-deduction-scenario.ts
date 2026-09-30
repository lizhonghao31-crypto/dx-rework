import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect, vi } from "vitest";
import { CreateExternalDeductionEntrySchema, RequestExternalDeductionSpecialApprovalSchema, type ExternalResponsibilityCaseResponse } from "@dx-rework/contracts/external-responsibility";
import type { ExternalResponsibilityApplicationService } from "../../../apps/api/src/rework/external-responsibility-application-service.js";
import { registerExternalResponsibilityRoutes } from "../../../apps/api/src/rework/external-responsibility-routes.js";
import { TodoBackfillService } from "../../../apps/api/src/todos/backfill-service.js";
import type { TodoProjectionService } from "../../../apps/api/src/todos/projection-service.js";
import { AccessMasterDataService } from "../../../apps/api/src/access/service.js";
import { OperationEventRepository, type TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";

// Continues a real, completed N01–N11 order with 80.00 already carried forward
// against a revised 148.10 proposal. This exercises the actual service and SQL.
export async function exerciseAtomicOverDeduction(input: {
  database: Pool; external: ExternalResponsibilityApplicationService; projection: TodoProjectionService;
  currentCase: ExternalResponsibilityCaseResponse; payables: TrustedActorContext;
  director: TrustedActorContext; reader: TrustedActorContext; productionId: string; root: TrustedActorContext;
}): Promise<void> {
  const {database, external, projection, currentCase, payables, director, reader, productionId}=input;
  const caseId=currentCase.caseId;
  const ordinary=CreateExternalDeductionEntrySchema.parse({expectedCaseVersion:currentCase.caseVersion,
    entryType:"deduction",amount:"69.10",deductedOn:"2026-09-15",attachmentIds:[]});
  const command=RequestExternalDeductionSpecialApprovalSchema.parse({expectedCaseVersion:currentCase.caseVersion,
    requestMode:"proposed_entry",requestedAmount:"69.10",deductedOn:"2026-09-15",attachmentIds:[],reason:"超出本次拟扣 1 元，申请总监确认"});
  const snapshot=async()=>({
    ledger:(await database.query("SELECT * FROM rework_external_deduction_entries WHERE case_id=$1 ORDER BY deduction_entry_id",[caseId])).rows,
    requests:(await database.query("SELECT * FROM rework_external_deduction_special_requests WHERE case_id=$1 ORDER BY request_version",[caseId])).rows,
    decisions:(await database.query("SELECT decision.* FROM rework_external_deduction_special_decisions decision JOIN rework_external_deduction_special_requests request USING(special_request_id) WHERE request.case_id=$1 ORDER BY special_decision_id",[caseId])).rows,
    closures:(await database.query("SELECT * FROM rework_external_deduction_closures WHERE case_id=$1",[caseId])).rows,
    state:(await database.query("SELECT status,case_version FROM rework_external_responsibility_cases WHERE case_id=$1",[caseId])).rows,
    outbox:(await database.query("SELECT event_id FROM message_outbox ORDER BY event_id")).rows,
  });
  const before=await snapshot();
  for (const invalid of [ordinary,{...ordinary,specialApprovalReason:"旧页面参数"}])
    await expect(external.recordDeduction(payables,caseId,invalid,randomUUID())).rejects.toMatchObject({statusCode:400});
  for (const invalid of [
    {...command,requestedAmount:"0"}, {...command,reason:" "}, {...command,requestedAmount:"68.10"},
    {...command,requestMode:undefined},
  ]) await expect(external.requestSpecialApproval(payables,caseId,invalid,randomUUID())).rejects.toMatchObject({statusCode:400});
  expect(await snapshot()).toEqual(before);

  // Direct SQL cannot persist an over-deduction without its matching request,
  // even with a legitimate deduction audit event and a permitted actor.
  const client=await database.connect();
  try {
    await client.query("BEGIN");
    const eventId=await new OperationEventRepository().append(client,payables,{action:"rework.external_deduction.record",entityType:"rework_order",entityId:currentCase.reworkOrderId,before:{},after:{}});
    await client.query("SELECT set_config('dx_rework.external_responsibility_event_id',$1,true),set_config('dx_rework.external_responsibility_request_id',$2,true)",[eventId,payables.requestId]);
    await expect(client.query("INSERT INTO rework_external_deduction_entries(deduction_entry_id,case_id,entry_type,amount,deducted_on,attachment_ids,recorded_by,operation_event_id,request_id) VALUES($1,$2,'deduction',69.10,'2026-09-15','{}',$3,$4,$5)",[randomUUID(),caseId,payables.actorId,eventId,payables.requestId])).rejects.toMatchObject({code:"23514"});
  } finally {await client.query("ROLLBACK");client.release();}
  expect(await snapshot()).toEqual(before);

  // A genuine direct-role ambiguity must roll back the financial command too.
  const access=new AccessMasterDataService(database,"corp");
  const conflictAssignment=await access.assignRole(input.root,{userId:reader.actorId,roleCode:"finance_director",reason:"隔离测试财务总监收件人冲突"});
  try {await expect(external.requestSpecialApproval(payables,caseId,command,randomUUID())).rejects.toMatchObject({statusCode:409});}
  finally {await access.revokeRole(input.root,conflictAssignment.assignmentId,"结束隔离收件人冲突测试");}
  expect(await snapshot()).toEqual(before);

  // Failure after both todo and outbox insertion still leaves no financial fact.
  const project=projection.actionableForUniqueDirectRole.bind(projection);
  const failure=vi.spyOn(projection,"actionableForUniqueDirectRole").mockImplementationOnce(async(...args)=>{
    await project(...args);throw new Error("simulated failure after outbox enqueue");
  });
  const key=randomUUID();
  try {await expect(external.requestSpecialApproval(payables,caseId,command,key)).rejects.toThrow("simulated failure");}
  finally {failure.mockRestore();}
  expect(await snapshot()).toEqual(before);

  const recorded=await external.requestSpecialApproval(payables,caseId,command,key);
  expect(recorded.value).toMatchObject({status:"pending_special_approval",actualDeductedAmount:"80.00",remainingAmount:"68.10",canClose:false,
    specialApproval:{proposedAmount:"148.10",actualDeductedAmount:"80.00",remainingAmount:"68.10",requestVersion:1,requestMode:"proposed_entry",requestedAmount:"69.10"}});
  const same=await external.requestSpecialApproval(payables,caseId,command,key);
  expect(same.reused).toBe(true);
  expect(same.value.specialApproval?.requestId).toBe(recorded.value.specialApproval?.requestId);
  await expect(external.requestSpecialApproval(payables,caseId,command,randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await database.query("SELECT status FROM rework_orders WHERE rework_order_id=$1",[currentCase.reworkOrderId])).rows[0].status).toBe("completed");
  const firstRequestId=recorded.value.specialApproval!.requestId;
  const firstTodo=(await database.query("SELECT todo_id,recipient_user_id,route_descriptor FROM rework_todos WHERE dedupe_key=$1",[`external-special:${caseId}:${firstRequestId}`])).rows;
  expect(firstTodo).toHaveLength(1);
  expect(firstTodo[0].recipient_user_id).toBe(director.actorId);
  expect(firstTodo[0].route_descriptor).toMatchObject({entityId:caseId,reworkOrderId:currentCase.reworkOrderId});
  expect((await database.query("SELECT count(*)::int count FROM message_outbox WHERE aggregate_id=$1 AND payload->>'deliveryKind'='create'",[firstTodo[0].todo_id])).rows[0].count).toBe(1);
  expect((await database.query("SELECT recorded_entry_id FROM rework_external_deduction_special_requests WHERE special_request_id=$1",[firstRequestId])).rows[0].recorded_entry_id).toBeNull();
  expect((await snapshot()).ledger).toEqual(before.ledger);
  expect(recorded.value.canDecideSpecialApproval).toBe(false);
  await expect(external.approveSpecialApproval(payables,caseId,{expectedCaseVersion:recorded.value.caseVersion,expectedRequestVersion:1},randomUUID())).rejects.toMatchObject({statusCode:403});

  let httpActor=reader;
  const app=Fastify();
  registerExternalResponsibilityRoutes(app,{service:external,authenticate:async()=>({id:httpActor.actorId,businessRoles:httpActor.actorRoles,capabilities:httpActor.authorizationCapabilities!})});
  try {
    expect((await app.inject({url:`/external-responsibility-cases/${caseId}`})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/external-responsibility-cases/${caseId}/special-approval/approve`,payload:{expectedCaseVersion:recorded.value.caseVersion,expectedRequestVersion:1},headers:{"idempotency-key":randomUUID()}})).statusCode).toBe(403);
    httpActor=payables;
    expect((await app.inject({url:`/external-responsibility-cases/${caseId}`})).json().canDecideSpecialApproval).toBe(false);
    for (const action of ["approve","return"]) expect((await app.inject({method:"POST",url:`/external-responsibility-cases/${caseId}/special-approval/${action}`,payload:{expectedCaseVersion:recorded.value.caseVersion,expectedRequestVersion:1,reason:"纯会计不得审批"},headers:{"idempotency-key":randomUUID()}})).statusCode).toBe(403);
    httpActor=director;
    expect((await app.inject({url:`/external-responsibility-cases/${caseId}`})).json().canDecideSpecialApproval).toBe(true);
  } finally {await app.close();}
  await expect(external.close(payables,caseId,{expectedCaseVersion:recorded.value.caseVersion,result:"full",evidenceAttachmentIds:[]},randomUUID())).rejects.toThrow();
  const returned=await external.returnSpecialApproval(director,caseId,{expectedCaseVersion:recorded.value.caseVersion,expectedRequestVersion:1,reason:"请补充超扣说明"},randomUUID());
  expect(returned.value).toMatchObject({status:"deduction_follow_up",actualDeductedAmount:"80.00",remainingAmount:"68.10",closure:null});
  expect(returned.value.deductions).toEqual(recorded.value.deductions);

  // Simulate an old, real pending request whose projection was missing. The
  // repair must reconstruct only its todo, without inserting ledger/request facts.
  const absent=vi.spyOn(projection,"actionableForUniqueDirectRole").mockResolvedValueOnce();
  let resubmitted;
  try {resubmitted=await external.requestSpecialApproval(payables,caseId,{...command,expectedCaseVersion:returned.value.caseVersion,reason:"补充说明后重新申请",attachmentIds:[]},randomUUID());}
  finally {absent.mockRestore();}
  const repair=new TodoBackfillService(database);
  const repairKey=`external-special:${caseId}:${resubmitted.value.specialApproval!.requestId}`;
  const financeFacts=await snapshot();
  await repair.run({mode:"dry_run"});
  expect((await database.query("SELECT todo_id FROM rework_todos WHERE dedupe_key=$1",[repairKey])).rows).toEqual([]);
  await repair.run({mode:"apply",actorUserId:productionId});
  const repaired=(await database.query("SELECT todo_id,recipient_user_id FROM rework_todos WHERE dedupe_key=$1",[repairKey])).rows;
  expect(repaired).toHaveLength(1);expect(repaired[0].recipient_user_id).toBe(director.actorId);
  const repairFacts=await snapshot();
  expect(repairFacts.ledger).toEqual(financeFacts.ledger);expect(repairFacts.requests).toEqual(financeFacts.requests);expect(repairFacts.state).toEqual(financeFacts.state);
  await repair.run({mode:"apply",actorUserId:productionId});
  expect((await database.query("SELECT todo_id,recipient_user_id FROM rework_todos WHERE dedupe_key=$1",[repairKey])).rows).toEqual(repaired);
  expect((await snapshot()).outbox).toEqual(repairFacts.outbox);

  const decision={expectedCaseVersion:resubmitted.value.caseVersion,expectedRequestVersion:2};
  const beforeApproval=await snapshot();
  const interrupted=vi.spyOn(projection,"information").mockRejectedValueOnce(new Error("simulated failure after approval ledger and closure"));
  try {await expect(external.approveSpecialApproval(director,caseId,decision,randomUUID())).rejects.toThrow("simulated failure");}
  finally {interrupted.mockRestore();}
  expect(await snapshot()).toEqual(beforeApproval);
  const decisions=await Promise.allSettled([
    external.approveSpecialApproval(director,caseId,decision,randomUUID()),
    external.approveSpecialApproval(director,caseId,decision,randomUUID()),
  ]);
  expect(decisions.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(decisions.filter(result=>result.status==='rejected')).toHaveLength(1);
  const closed=await external.getCase(payables,caseId);
  expect(closed).toMatchObject({status:"closed",actualDeductedAmount:"149.10",remainingAmount:"-1.00",closure:{result:"over_deducted",actualDeductedAmount:"149.10",remainingAmount:"-1.00"}});
  expect((await database.query("SELECT amount::text,recorded_by,approval_request_id FROM rework_external_deduction_entries WHERE case_id=$1",[caseId])).rows).toEqual([{amount:"69.10",recorded_by:director.actorId,approval_request_id:resubmitted.value.specialApproval!.requestId}]);
  const after=await snapshot();
  await repair.run({mode:"apply",actorUserId:productionId});
  expect(await snapshot()).toEqual(after);
  expect((await database.query("SELECT count(*)::int count FROM rework_external_deduction_closures WHERE case_id=$1",[caseId])).rows[0].count).toBe(1);
}
