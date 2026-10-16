import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { TodoProjectionService } from "../todos/projection-service.js";
import { TodoService } from "../todos/service.js";

export const transferContractTodoPrefix = (caseId: string): string => `sourcing:${caseId}:transfer-return:`;
export const transferContractVersionPrefix = (caseId: string, documentId: string): string => `${transferContractTodoPrefix(caseId)}${documentId}:`;

type CurrentContract = {
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
  returned: boolean;
};

/** Reconcile only authoritative current-version facts under the existing order lock. */
export class SourcingTransferContractTodos {
  private readonly projection: TodoProjectionService;
  constructor(database: Pool, projection?: TodoProjectionService) {
    this.projection = projection ?? new TodoProjectionService(new TodoService(database));
  }

  async synchronize(client: PoolClient, actor: TrustedActorContext, caseId: string): Promise<void> {
    await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE", [caseId]);
    const current = (await client.query<CurrentContract>(`SELECT document.sourcing_contract_document_id,
        document.contract_version,document.status,document.pdf_attachment_id,
        decision.source_change_request_id,decision.supplier_name_snapshot,source.created_by,
        nullif(to_jsonb(source)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
        snapshot.operation_event_id,event.action AS source_action,
        EXISTS(SELECT 1 FROM sourcing_contract_return_submissions signed
          JOIN sourcing_contract_return_attachments link ON link.submission_id=signed.submission_id
          JOIN attachments file ON file.attachment_id=link.attachment_id AND file.status='ready'
          WHERE signed.sourcing_contract_document_id=document.sourcing_contract_document_id) AS returned
      FROM sourcing_cases source
      JOIN LATERAL (SELECT * FROM sourcing_contract_documents d WHERE d.sourcing_case_id=source.sourcing_case_id
        ORDER BY d.contract_version DESC LIMIT 1) document ON true
      JOIN sourcing_approval_snapshots snapshot ON snapshot.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
      JOIN sourcing_decisions decision ON decision.sourcing_decision_id=snapshot.sourcing_decision_id
      JOIN operation_events event ON event.event_id=snapshot.operation_event_id
      WHERE source.sourcing_case_id=$1 AND source.deleted_at IS NULL`, [caseId])).rows[0];
    const open = await client.query<{ dedupe_key: string; document_id: string | null }>(`SELECT dedupe_key,
        route_descriptor->'transferContract'->>'documentId' AS document_id
      FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1
        AND category='sourcing_transfer_contract_return' AND status IN ('pending','blocked_recipient')
      ORDER BY todo_id FOR UPDATE`, [caseId]);
    for (const todo of open.rows) {
      if (!current?.source_change_request_id || todo.document_id !== current.sourcing_contract_document_id) {
        await this.projection.cancelOpenByDedupeKey(client, actor, todo.dedupe_key, "合同版本已更新，旧版待签回事项失效");
      }
    }
    if (!current?.source_change_request_id) return;
    // Do not mislabel an obsolete first-contract task as a successful return.
    await this.projection.cancelOpenByDedupePrefix(client, actor, `sourcing:${caseId}:return:`, "转厂合同已换版，请办理当前合同");
    const prefix = transferContractVersionPrefix(caseId, current.sourcing_contract_document_id);
    if (current.returned) {
      await this.projection.completeOpenByDedupePrefix(client, actor, prefix, "当前版本合同已有效回传");
      return;
    }
    if (current.status !== "ready" || !current.pdf_attachment_id) return;
    for (const recipientUserId of new Set([current.created_by, current.additional_merchandiser_user_id].filter((id): id is string => !!id))) {
      await this.projection.actionableForNamedRecipient(client, actor, {
        category: "sourcing_transfer_contract_return",
        sourceEventId: current.operation_event_id,
        sourceAction: current.source_action,
        entityType: "sourcing_case", entityId: caseId,
        recipientUserId, requiredRole: "order_merchandiser", requiredCapability: "sourcing:contract:record",
        route: { routeName: "sourcing_detail", entityId: caseId, tab: "contract_return",
          transferContract: { documentId: current.sourcing_contract_document_id, version: current.contract_version,
            supplierName: current.supplier_name_snapshot } },
        policyKey: "sourcing_contract_return", dedupeKey: `${prefix}${recipientUserId}`,
      });
    }
  }
}
