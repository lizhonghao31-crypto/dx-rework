import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { SourcingTransferContractTodos } from "./sourcing-transfer-contract-todos.js";

type Selection = { caseId: string; documentId: string };
const conflict = (message: string): never => { throw new ApplicationError("CONFLICT", message, 409); };

/** Explicit Root-only recovery; never run during startup or migration. */
export class SourcingTransferContractReconciliation {
  constructor(private readonly database: Pool, private readonly projection = new SourcingTransferContractTodos(database)) {}

  private assertRoot(actor: TrustedActorContext): void {
    if (!isRootActor(actor)) throw new ApplicationError("FORBIDDEN", "仅 Root 可盘点或补录转厂合同待签回", 403);
  }

  private async candidates(client: PoolClient, caseIds: readonly string[], limit: number) {
    return (await client.query<Selection & { version: number; supplierName: string; primaryUserId: string; additionalUserId: string | null }>(
      `SELECT source.sourcing_case_id AS "caseId",document.sourcing_contract_document_id AS "documentId",
        document.contract_version AS version,decision.supplier_name_snapshot AS "supplierName",
        source.created_by AS "primaryUserId",source.additional_merchandiser_user_id AS "additionalUserId"
      FROM sourcing_cases source
      JOIN LATERAL (SELECT * FROM sourcing_contract_documents d WHERE d.sourcing_case_id=source.sourcing_case_id
        ORDER BY d.contract_version DESC LIMIT 1) document ON true
      JOIN sourcing_decisions decision ON decision.sourcing_decision_id=document.sourcing_decision_id
      WHERE source.deleted_at IS NULL AND ($1::uuid[]='{}' OR source.sourcing_case_id=ANY($1::uuid[]))
        AND decision.source_change_request_id IS NOT NULL AND document.status='ready' AND document.pdf_attachment_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM sourcing_contract_return_submissions signed
          JOIN sourcing_contract_return_attachments link USING(submission_id)
          JOIN attachments file ON file.attachment_id=link.attachment_id AND file.status='ready'
          WHERE signed.sourcing_contract_document_id=document.sourcing_contract_document_id)
      ORDER BY source.sourcing_case_id LIMIT $2`, [caseIds, limit])).rows;
  }

  async preview(actor: TrustedActorContext, caseIds: readonly string[] = [], limit = 200) {
    this.assertRoot(actor);
    const client=await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const candidates=await this.candidates(client,caseIds,limit+1);
      await client.query("COMMIT");
      return { mode:"dry_run" as const,truncated:candidates.length>limit,results:candidates.slice(0,limit) };
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async apply(actor: TrustedActorContext, selected: readonly Selection[], reason: string, key: string) {
    this.assertRoot(actor);
    if (!selected.length || selected.length>100 || new Set(selected.map(item=>item.caseId)).size!==selected.length
      || !reason.trim() || reason.length>300) conflict("请选择不重复的订单及当前合同版本，并填写补录原因");
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      const result=await new IdempotencyService().execute(client,{
        scope:"sourcing.transfer-contract-todo.reconcile",actorKey:actor.actorId,key,
        requestHash:createHash("sha256").update(JSON.stringify({selected,reason})).digest("hex"),
        expiresAt:new Date(Date.now()+86400000),
      },async()=>{
        for (const item of [...selected].sort((a,b)=>a.caseId.localeCompare(b.caseId))) {
          await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE",[item.caseId]);
        }
        const candidates=await this.candidates(client,selected.map(item=>item.caseId),100);
        if (candidates.length!==selected.length || selected.some(item=>!candidates.some(row=>row.caseId===item.caseId && row.documentId===item.documentId)))
          conflict("合同版本、生成或回签状态已变化，请重新盘点；本次未补录任何待办");
        for (const item of candidates) await this.projection.synchronize(client,actor,item.caseId);
        await new OperationEventRepository().append(client,actor,{
          action:"sourcing.transfer_contract_todo.reconcile",entityType:"sourcing_transfer_contract_reconciliation",entityId:key,
          after:{contracts:selected},reason,
        });
        return {statusCode:200,response:{reconciled:selected}};
      });
      await client.query("COMMIT");
      return {...result.response,reused:result.reused};
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
