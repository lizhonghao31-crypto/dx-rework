import {effectiveSourcingMerchandiser} from "./current-merchandiser.js";
import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { TodoProjectionService } from "../todos/projection-service.js";
import { TodoService } from "../todos/service.js";
import { memberCanReceiveFact } from "../access/member-module-policy.js";

export const priceContractVersionPrefix=(caseId:string,documentId:string):string=>`sourcing:${caseId}:price-return:${documentId}:`;
export const transferContractTodoPrefix = (caseId: string): string => `sourcing:${caseId}:transfer-return:`;
export const transferContractVersionPrefix = (caseId: string, documentId: string): string => `${transferContractTodoPrefix(caseId)}${documentId}:`;

export type CurrentTransferContract = {
  sourcing_contract_document_id: string;
  contract_version: number;
  supplier_name_snapshot: string;
  status: string;
  pdf_attachment_id: string | null;
  source_change_request_id: string | null;
  created_by: string;
  additional_merchandiser_user_id: string | null;
  operation_event_id: string;
  source_action: string;
  price_change: boolean;
  returned: boolean;
  generated_at: Date | string | null;
  sourcing_approval_snapshot_id: string;
  return_cycle_id: string | null;
  cycle_generated_at: Date | string | null;
  cycle_due_at: Date | string | null;
  ambiguous_return: boolean;
};

/** Reconcile only authoritative current-version facts under the existing order lock. */
export class SourcingTransferContractTodos {
  private readonly projection: TodoProjectionService;
  constructor(database: Pool, projection?: TodoProjectionService) {
    this.projection = projection ?? new TodoProjectionService(new TodoService(database));
  }

  async inspect(client: PoolClient, caseId: string) {
    const current = (await client.query<CurrentTransferContract>(`SELECT document.sourcing_contract_document_id,
        document.contract_version,document.status,document.pdf_attachment_id,
        document.generated_at::text AS generated_at,document.sourcing_approval_snapshot_id,
        clock.return_cycle_id,clock.contract_generated_at AS cycle_generated_at,clock.contract_return_due_at AS cycle_due_at,
        decision.source_change_request_id,decision.supplier_name_snapshot,source.created_by,
        nullif(to_jsonb(source)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
        snapshot.operation_event_id,event.action AS source_action,decision.source_price_request_id IS NOT NULL AS price_change,
        CASE WHEN clock.return_cycle_id IS NOT NULL THEN clock.has_valid_return ELSE EXISTS(SELECT 1 FROM sourcing_contract_return_submissions signed
          JOIN sourcing_contract_return_attachments link ON link.submission_id=signed.submission_id
          JOIN attachments file ON file.attachment_id=link.attachment_id AND file.status='ready'
          WHERE signed.sourcing_contract_document_id=document.sourcing_contract_document_id) END AS returned,
        EXISTS(SELECT 1 FROM sourcing_contract_return_submissions signed
          WHERE signed.sourcing_case_id=source.sourcing_case_id AND signed.sourcing_contract_document_id IS NULL) AS ambiguous_return
      FROM sourcing_cases source
      JOIN LATERAL (SELECT d.* FROM sourcing_contract_documents d
        JOIN sourcing_approval_snapshots approved ON approved.sourcing_approval_snapshot_id=d.sourcing_approval_snapshot_id
          AND approved.sourcing_decision_id=d.sourcing_decision_id
        WHERE d.sourcing_case_id=source.sourcing_case_id
        ORDER BY d.contract_version DESC LIMIT 1) document ON true
      JOIN sourcing_approval_snapshots snapshot ON snapshot.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
      JOIN sourcing_decisions decision ON decision.sourcing_decision_id=snapshot.sourcing_decision_id
      JOIN operation_events event ON event.event_id=snapshot.operation_event_id
      LEFT JOIN LATERAL sourcing_contract_return_business_state(source.sourcing_case_id) clock ON true
      WHERE source.sourcing_case_id=$1 AND source.deleted_at IS NULL`, [caseId])).rows[0];
    const primary = current ? await effectiveSourcingMerchandiser(client,caseId,current.created_by) : null;
    const recipients = [];
    if (current) for (const userId of new Set([primary, current.additional_merchandiser_user_id].filter((id): id is string => !!id))) {
      const eligible = (await client.query<{ eligible: boolean }>(
        "SELECT todo_user_has_direct_role($1::uuid,'order_merchandiser','sourcing:contract:record') AS eligible", [userId],
      )).rows[0]?.eligible === true && await memberCanReceiveFact(client, userId, current.source_action, "sourcing_case", caseId);
      recipients.push({ userId, role: userId === primary ? "primary" : "additional", eligible,
        dedupeKey: `${current.price_change ? priceContractVersionPrefix(caseId,current.sourcing_contract_document_id) : transferContractVersionPrefix(caseId, current.sourcing_contract_document_id)}${userId}` });
    }
    const tasks = (await client.query<{ todo_id: string; dedupe_key: string; recipient_user_id: string; status: string }>(
      `SELECT todo_id,dedupe_key,recipient_user_id,status FROM rework_todos
       WHERE entity_type='sourcing_case' AND entity_id=$1 AND category IN ('sourcing_transfer_contract_return','sourcing_price_contract_return')
       ORDER BY todo_id`, [caseId],
    )).rows;
    return { current, recipients, tasks };
  }

  async synchronize(client: PoolClient, actor: TrustedActorContext, caseId: string, options: { historical?: boolean } = {}) {
    await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE", [caseId]);
    const { current, recipients, tasks } = await this.inspect(client, caseId);
    // An unfinished new PDF must not invalidate a still-actionable older version.
    if (!current?.return_cycle_id || current.status !== "ready" || !current.pdf_attachment_id)
      return { createdTodoIds: [] as string[] };
    const open = await client.query<{ dedupe_key: string; document_id: string | null }>(`SELECT dedupe_key,
        COALESCE(route_descriptor->'transferContract'->>'documentId',route_descriptor->'contractReturn'->>'documentId') AS document_id
      FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1
        AND category IN ('sourcing_transfer_contract_return','sourcing_price_contract_return') AND status IN ('pending','blocked_recipient')
      ORDER BY todo_id FOR UPDATE`, [caseId]);
    for (const todo of options.historical ? [] : open.rows) {
      if (todo.document_id !== current.sourcing_contract_document_id) {
        await this.projection.cancelOpenByDedupeKey(client, actor, todo.dedupe_key, "合同版本已更新，旧版待签回事项失效");
      }
    }
    // Do not mislabel an obsolete first-contract task as a successful return.
    if (!options.historical) await this.projection.cancelOpenByDedupePrefix(client, actor, `sourcing:${caseId}:return:`, "合同业务版本已更新，请办理当前合同");
    const prefix = current.price_change ? priceContractVersionPrefix(caseId,current.sourcing_contract_document_id) : transferContractVersionPrefix(caseId, current.sourcing_contract_document_id);
    if (current.returned) {
      await this.projection.completeOpenByDedupePrefix(client, actor, prefix, "当前版本合同已有效回传");
      return { createdTodoIds: [] as string[] };
    }
    for (const { userId: recipientUserId, eligible } of recipients) {
      if (options.historical && !eligible) continue;
      // Closed or blocked facts require explicit handling, never implicit reopening.
      if (tasks.some(todo => todo.dedupe_key.startsWith(prefix) && todo.recipient_user_id === recipientUserId)) continue;
      await this.projection.actionableForNamedRecipient(client, actor, {
        category: current.price_change ? "sourcing_price_contract_return" : "sourcing_transfer_contract_return",
        sourceEventId: current.operation_event_id,
        sourceAction: current.source_action,
        entityType: "sourcing_case", entityId: caseId,
        recipientUserId, requiredRole: "order_merchandiser", requiredCapability: "sourcing:contract:record",
        route: { routeName: "sourcing_detail", entityId: caseId, tab: "contract_return",
          ...(current.price_change ? {contractReturn:{documentId:current.sourcing_contract_document_id,version:current.contract_version,supplierName:current.supplier_name_snapshot,source:"price_reapplication" as const}}
            : {transferContract: { documentId: current.sourcing_contract_document_id, version: current.contract_version,supplierName: current.supplier_name_snapshot }}) },
        policyKey: "sourcing_contract_return", dedupeKey: `${prefix}${recipientUserId}`,
      });
    }
    return { createdTodoIds: (await client.query<{ todo_id: string }>(
      `SELECT todo_id FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1
       AND category IN ('sourcing_transfer_contract_return','sourcing_price_contract_return') AND NOT (todo_id=ANY($2::uuid[])) ORDER BY todo_id`,
      [caseId, tasks.map(todo => todo.todo_id)],
    )).rows.map(todo => todo.todo_id) };
  }
}
