import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { TodoService } from "./service.js";

type Selection = { todoId: string; evidenceHash: string };
type Candidate = {
  todoId: string; caseId: string; dedupeKey: string; recipientId: string;
  status: string; category: string; sourceEventId: string; sourceAction: string;
  requiredRole: string; requiredCapability: string; route: Record<string,string>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const denied = (): never => { throw new ApplicationError("FORBIDDEN","仅 Root 可盘点或补偿外发失效待办",403); };
const conflict = (message: string): never => { throw new ApplicationError("CONFLICT",message,409); };
const policies = {
  sourcing_ie_quote: { node:"pending_ie_quote", prefix:"ie_quote", role:"ie_reviewer", capability:"sourcing:price:quote",
    exitAction:"ie_price_quoted", eventAction:"sourcing.ie_price.quote", next:"pending_management_decision", table:"sourcing_ie_quotes" },
  sourcing_management_decision: { node:"pending_management_decision", prefix:"management", role:"production_management", capability:"sourcing:decision:record",
    exitAction:"management_decision_recorded", eventAction:"sourcing.management_decision.record", next:"pending_owner_approval", table:"sourcing_decisions" },
} as const;

/** Operator-invoked only. A non-current node alone is never proof of invalidity. */
export class SourcingTodoReconciliationService {
  constructor(private readonly database: Pool, private readonly todos = new TodoService(database)) {}

  private async inspect(client: PoolClient, todo: Candidate) {
    const policy = policies[todo.category as keyof typeof policies];
    const skipped = (reason: string) => ({ todoId:todo.todoId,caseId:todo.caseId,eligible:false as const,reason });
    if (!policy || !["pending","blocked_recipient"].includes(todo.status)) return skipped("待办已终结或不属于本次范围");
    const prefix = `sourcing:${todo.caseId}:${policy.prefix}:`;
    const identity = todo.dedupeKey.slice(prefix.length);
    if (!todo.dedupeKey.startsWith(prefix) || !new RegExp(`^(?:transition:)?[1-9][0-9]*:${todo.recipientId}$`).test(identity)
      || todo.requiredRole!==policy.role || todo.requiredCapability!==policy.capability
      || todo.route.routeName!=="sourcing_detail" || todo.route.entityId!==todo.caseId || todo.route.todoId!==todo.todoId)
      return skipped("待办身份、岗位或路由不符合已知投影规则");
    const entry = (await client.query(`SELECT t.*,e.action,e.entity_type,e.entity_id FROM sourcing_case_transitions t
      JOIN operation_events e ON e.event_id=t.operation_event_id
      WHERE t.sourcing_case_id::text=$1 AND t.operation_event_id=$2`,[todo.caseId,todo.sourceEventId])).rows[0];
    if (!entry || entry.to_status!==policy.node || entry.action!==todo.sourceAction
      || entry.entity_type!=="sourcing_case" || entry.entity_id!==todo.caseId)
      return skipped("缺少匹配的原始节点进入事实");
    const exit = (await client.query(`SELECT t.*,e.action,e.entity_type,e.entity_id FROM sourcing_case_transitions t
      JOIN operation_events e ON e.event_id=t.operation_event_id
      WHERE t.sourcing_case_id::text=$1 AND t.sequence=$2`,[todo.caseId,Number(entry.sequence)+1])).rows[0];
    if (!exit || exit.from_status!==policy.node || exit.to_status!==policy.next || exit.business_action!==policy.exitAction
      || exit.action!==policy.eventAction || exit.entity_type!=="sourcing_case" || exit.entity_id!==todo.caseId)
      return skipped("该轮没有可证明的合法办结事实；当前节点或退回不足以关闭");
    // Table names are fixed by the two policies, never supplied by the request.
    const facts = await client.query(`SELECT operation_event_id,request_id FROM ${policy.table}
      WHERE sourcing_case_id::text=$1 AND operation_event_id=$2`,[todo.caseId,exit.operation_event_id]);
    if (facts.rows.length!==1 || facts.rows[0].request_id!==exit.request_id) return skipped("业务事实与办结审计不一致");
    const current = (await client.query("SELECT sequence,to_status FROM sourcing_case_transitions WHERE sourcing_case_id::text=$1 ORDER BY sequence DESC LIMIT 1",[todo.caseId])).rows[0];
    const evidence = { todoId:todo.todoId,caseId:todo.caseId,dedupeKey:todo.dedupeKey,recipientId:todo.recipientId,
      sourceEventId:todo.sourceEventId,entrySequence:Number(entry.sequence),entryEventId:entry.operation_event_id,
      exitSequence:Number(exit.sequence),exitEventId:exit.operation_event_id,factEventId:facts.rows[0].operation_event_id,
      category:todo.category,currentSequence:Number(current.sequence),currentStatus:current.to_status };
    return { ...evidence,eligible:true as const,evidenceHash:digest(evidence),reason:"原始进入轮次已有对应报价或总监决定，待办投影遗漏终态" };
  }

  private async candidates(client: PoolClient, caseIds: readonly string[], limit: number, todoIds?: readonly string[]) {
    return (await client.query<Candidate>(`SELECT todo_id AS "todoId",entity_id AS "caseId",dedupe_key AS "dedupeKey",
      recipient_user_id AS "recipientId",status,category,source_event_id AS "sourceEventId",source_action AS "sourceAction",
      required_role AS "requiredRole",required_capability AS "requiredCapability",route_descriptor AS route
      FROM rework_todos WHERE todo_type='business_action' AND entity_type='sourcing_case'
      AND category IN ('sourcing_ie_quote','sourcing_management_decision')
      AND ($1::text[]='{}' OR entity_id=ANY($1::text[]))
      AND ($3::uuid[] IS NOT NULL AND todo_id=ANY($3::uuid[]) OR $3::uuid[] IS NULL AND status IN ('pending','blocked_recipient'))
      ORDER BY entity_id,todo_id LIMIT $2`,[caseIds,limit,todoIds??null])).rows;
  }

  async preview(actor: TrustedActorContext, caseIds: readonly string[] = [], limit = 200) {
    if (!isRootActor(actor)) denied();
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = await this.candidates(client,caseIds,limit+1);
      const results = [];
      for (const todo of rows.slice(0,limit)) results.push(await this.inspect(client,todo));
      await client.query("COMMIT");
      return { mode:"dry_run" as const,truncated:rows.length>limit,results };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async apply(actor: TrustedActorContext, selected: readonly Selection[], reason: string, key: string) {
    if (!isRootActor(actor)) denied();
    if (!reason.trim() || reason.length>300) conflict("补偿必须保留不超过300字的原因");
    if (!selected.length || selected.length>100 || new Set(selected.map(item=>item.todoId)).size!==selected.length)
      conflict("请选择不重复的、已经盘点的明确待办");
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await new IdempotencyService().execute(client,{scope:"sourcing.todo-reconciliation.apply",actorKey:actor.actorId,key,
        requestHash:digest({selected,reason}),expiresAt:new Date(Date.now()+86400000)},async()=>{
        const candidates = await this.candidates(client,[],100,selected.map(item=>item.todoId));
        if (candidates.length!==selected.length) conflict("待办不属于本次可核查范围");
        for (const caseId of [...new Set(candidates.map(todo=>todo.caseId))].sort()) {
          const locked = await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id::text=$1 AND deleted_at IS NULL FOR UPDATE",[caseId]);
          if (!locked.rowCount) conflict("外发单不存在或已删除");
        }
        await client.query("SELECT todo_id FROM rework_todos WHERE todo_id=ANY($1::uuid[]) ORDER BY todo_id FOR UPDATE",[selected.map(item=>item.todoId)]);
        const refreshed = await this.candidates(client,[],100,selected.map(item=>item.todoId));
        const proofs = [];
        for (const todo of refreshed) {
          const proof = await this.inspect(client,todo);
          if (!proof.eligible) throw new ApplicationError("CONFLICT","该轮缺少办结证据；本次未关闭任何项",409);
          if (proof.evidenceHash!==selected.find(item=>item.todoId===todo.todoId)!.evidenceHash)
            conflict("盘点证据或待办已变化，请重新 dry-run；本次未关闭任何项");
          proofs.push(proof);
        }
        await new OperationEventRepository().append(client,actor,{action:"sourcing.todo.reconcile",entityType:"sourcing_todo_reconciliation",
          entityId:key,after:{proofs},reason});
        for (const proof of proofs) if (!await this.todos.completeOpenByDedupeKey(client,actor,proof.dedupeKey,
          `历史待办补偿：${reason}；节点 ${proof.entrySequence}→${proof.exitSequence}；证据 ${proof.evidenceHash}`))
          conflict("待办状态发生变化");
        return {statusCode:200,response:{completedTodoIds:proofs.map(proof=>proof.todoId)}};
      });
      await client.query("COMMIT");
      return {...result.response,reused:result.reused};
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
