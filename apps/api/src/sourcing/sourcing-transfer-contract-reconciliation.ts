import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { contractHistoryBaseline, contractHistoryBaselines } from "./sourcing-contract-history-scope.js";
import { SourcingTransferContractTodos } from "./sourcing-transfer-contract-todos.js";

export type TransferContractSelection = { caseId: string; documentId: string; version: number; evidenceHash: string };
const conflict = (message: string): never => { throw new ApplicationError("CONFLICT", message, 409); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Root-invoked historical repair only; reads, startup and migrations never call apply. */
export class SourcingTransferContractReconciliation {
  constructor(private readonly database: Pool, private readonly projection = new SourcingTransferContractTodos(database)) {}

  private assertRoot(actor: TrustedActorContext): void {
    if (!isRootActor(actor)) throw new ApplicationError("FORBIDDEN", "仅 Root 可盘点或补录转厂合同待签回", 403);
  }

  private assertScope(caseIds: readonly string[]): void {
    if (!caseIds.length || caseIds.length > 3 || new Set(caseIds).size !== caseIds.length
      || caseIds.some(id => !contractHistoryBaseline(id))) conflict("历史处理仅允许已确认的三个唯一订单，禁止扩展范围");
  }

  private async inspect(client: PoolClient, caseId: string) {
    const facts = await this.projection.inspect(client, caseId);
    const { current, recipients, tasks } = facts;
    const baseline = contractHistoryBaseline(caseId)!;
    const valid = !!current && current.sourcing_contract_document_id === baseline.documentId
      && Number(current.contract_version) === baseline.version && current.status === "ready"
      && !!current.pdf_attachment_id && !!current.generated_at && !!current.source_change_request_id && !current.ambiguous_return
      && (!baseline.generatedAt || Math.floor(new Date(current.generated_at).getTime()/1000) === Math.floor(new Date(baseline.generatedAt).getTime()/1000));
    const matchesRecipient = (todo: (typeof tasks)[number], recipient: (typeof recipients)[number]) =>
      todo.recipient_user_id === recipient.userId && todo.dedupe_key.startsWith(recipient.dedupeKey.slice(0,-recipient.userId.length));
    const terminal = !current?.returned && (tasks.some(todo => ["pending", "blocked_recipient"].includes(todo.status)
      && !recipients.some(recipient => matchesRecipient(todo,recipient))) || recipients.some(recipient => tasks.some(todo => matchesRecipient(todo,recipient)
      && todo.status !== "pending")));
    const blocked = !valid || terminal;
    // Signed/existing tasks are monotonic skips: execution accepts those changes, but never new recipients or versions.
    const evidenceHash = digest({ caseId, documentId: current?.sourcing_contract_document_id,
      version: current?.contract_version, generatedAt: current?.generated_at, source: current?.source_change_request_id,
      recipients, ambiguous: current?.ambiguous_return });
    const actions = recipients.map(recipient => ({ role: recipient.role,
      action: blocked ? "blocked_precondition" : current?.returned ? "skipped_signed" : !recipient.eligible ? "skipped_ineligible"
        : tasks.some(todo => matchesRecipient(todo,recipient)) ? "skipped_existing" : "create",
      dedupeKey: recipient.dedupeKey.replace(recipient.userId, recipient.role),
    }));
    return { facts, public: { caseId, documentId: current?.sourcing_contract_document_id ?? baseline.documentId,
      version: Number(current?.contract_version ?? baseline.version), status: current?.status ?? "missing",
      sourceAction: current?.source_action ?? null, returned: current?.returned ?? false,
      generatedAt: current?.generated_at ?? null,
      cycleId:current?.return_cycle_id ?? null, cycleGeneratedAt:current?.cycle_generated_at ?? current?.generated_at ?? null,
      cycleDueAt:current?.cycle_due_at ?? (current?.generated_at ? (await client.query<{due_at:Date}>("SELECT sourcing_contract_return_add_hours($1::timestamptz,48) AS due_at",[current.generated_at])).rows[0]!.due_at : null),
      cycleOrigin:current?.return_cycle_id ? "existing" : "explicit_historical_ready", evidenceHash, blocked,
      reason: !valid ? "合同基准、就绪证据或回签关联异常" : terminal ? "现存任务需人工处置，不能自动重开或改派" : null,
      actions, proposedCount: actions.filter(item => item.action === "create").length,
      tasks: tasks.map(todo => ({ todoId: todo.todo_id, status: todo.status,
        dedupeKey: todo.dedupe_key.replace(todo.recipient_user_id,
          recipients.find(recipient => recipient.userId === todo.recipient_user_id)?.role ?? "other_recipient") })),
    } };
  }

  async preview(actor: TrustedActorContext, caseIds: readonly string[] = contractHistoryBaselines.map(item => item.caseId), _limit = 3) {
    this.assertRoot(actor);
    if (_limit < 1) conflict("预览数量必须为正数");
    const ids = caseIds.length ? caseIds : contractHistoryBaselines.map(item => item.caseId);
    this.assertScope(ids);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='10s'");
      const results = [];
      for (const caseId of [...ids].sort()) results.push((await this.inspect(client, caseId)).public);
      await client.query("COMMIT");
      return { mode: "dry_run" as const, truncated: false, results };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async apply(actor: TrustedActorContext, selected: readonly TransferContractSelection[], reason: string, key: string) {
    this.assertRoot(actor);
    this.assertScope(selected.map(item => item.caseId));
    if (!reason.trim() || reason.length > 300 || selected.some(item => !item.evidenceHash || !item.version))
      conflict("请绑定只读预检证据、合同文档和版本，并填写补录原因");
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='15s'");
      const result = await new IdempotencyService().execute(client, {
        scope: "sourcing.transfer-contract-todo.reconcile", actorKey: actor.actorId, key,
        requestHash: digest({ selected, reason }), expiresAt: new Date(Date.now() + 86400000),
      }, async () => {
        const results = [];
        for (const item of [...selected].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
          await client.query("SAVEPOINT historical_case");
          try {
            await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE", [item.caseId]);
            const inspected = await this.inspect(client, item.caseId);
            const proof = inspected.public;
            if (proof.blocked || proof.documentId !== item.documentId || proof.version !== item.version || proof.evidenceHash !== item.evidenceHash) {
              results.push({ caseId: item.caseId, action: "blocked_precondition", createdTodoIds: [] as string[] });
            } else if (proof.returned) {
              results.push({ caseId: item.caseId, action: "skipped_signed", createdTodoIds: [] as string[] });
            } else {
              if (!inspected.facts.current!.return_cycle_id) {
                const current=inspected.facts.current!;
                const eventId=await new OperationEventRepository().append(client,actor,{
                  action:"sourcing.contract_return_cycle.reconcile",entityType:"sourcing_case",entityId:item.caseId,
                  after:{documentId:item.documentId,version:item.version,batchKey:key,evidenceHash:item.evidenceHash},reason,
                });
                await client.query(`INSERT INTO sourcing_contract_return_cycles(sourcing_approval_snapshot_id,sourcing_case_id,business_event_id,origin,created_operation_event_id,first_document_id,generated_at,due_at)
                  SELECT $1,$2,snapshot.operation_event_id,'historical',$3,document.sourcing_contract_document_id,document.generated_at,sourcing_contract_return_add_hours(document.generated_at,48)
                  FROM sourcing_approval_snapshots snapshot JOIN sourcing_contract_documents document ON document.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
                  WHERE snapshot.sourcing_approval_snapshot_id=$1 AND document.sourcing_contract_document_id=$4
                  ON CONFLICT(sourcing_approval_snapshot_id) DO NOTHING`,
                  [current.sourcing_approval_snapshot_id,item.caseId,eventId,item.documentId]);
              }
              if (!proof.proposedCount) {
                results.push({ caseId: item.caseId, action: "skipped", createdTodoIds: [] as string[], cycleId:inspected.facts.current!.sourcing_approval_snapshot_id,cycleCreated:!inspected.facts.current!.return_cycle_id, actions: proof.actions });
              } else {
                const created = await this.projection.synchronize(client, actor, item.caseId, { historical: true });
                results.push({ caseId: item.caseId, action: created.createdTodoIds.length ? "created" : "skipped",cycleId:inspected.facts.current!.sourcing_approval_snapshot_id,cycleCreated:!inspected.facts.current!.return_cycle_id, ...created });
              }
            }
            await client.query("RELEASE SAVEPOINT historical_case");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT historical_case");
            await client.query("RELEASE SAVEPOINT historical_case");
            results.push({ caseId: item.caseId, action: "failed", createdTodoIds: [] as string[],
              reason: error instanceof ApplicationError ? error.message : "待办写入失败，事务已回滚；需重新预检" });
          }
        }
        await new OperationEventRepository().append(client, actor, {
          action: "sourcing.transfer_contract_todo.reconcile", entityType: "sourcing_transfer_contract_reconciliation", entityId: key,
          after: { contracts: selected, results }, reason,
        });
        return { statusCode: 200, response: { results } };
      });
      await client.query("COMMIT");
      return { ...result.response, reused: result.reused };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
