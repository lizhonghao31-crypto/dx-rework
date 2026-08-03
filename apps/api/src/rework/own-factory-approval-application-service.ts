import type {
  ApproveOwnFactoryApproval,
  OwnFactoryApprovalResponse,
  RejectOwnFactoryApproval,
} from "@dx-rework/contracts";
import type { Pool } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import { OwnFactoryApprovalService } from "./own-factory-approval-service.js";

export class OwnFactoryApprovalApplicationService {
  private readonly service: OwnFactoryApprovalService;

  constructor(private readonly database: Pool) {
    this.service = new OwnFactoryApprovalService(database);
  }

  listQueue(...args: Parameters<OwnFactoryApprovalService["listQueue"]>) {
    return this.service.listQueue(...args);
  }

  async get(
    actor: TrustedActorContext,
    orderId: string,
  ): Promise<OwnFactoryApprovalResponse> {
    return this.onlyCurrent(
      await this.service.get(actor, orderId),
      orderId,
    );
  }

  approve(
    actor: TrustedActorContext,
    approvalId: string,
    input: ApproveOwnFactoryApproval,
    key: string,
  ) {
    return this.service.approve(actor, approvalId, input, key);
  }

  reject(
    actor: TrustedActorContext,
    approvalId: string,
    input: RejectOwnFactoryApproval,
    key: string,
  ) {
    return this.service.reject(actor, approvalId, input, key);
  }

  private async onlyCurrent(
    response: OwnFactoryApprovalResponse,
    orderId: string,
  ): Promise<OwnFactoryApprovalResponse> {
    if (!response.approval) return response;
    const current = await this.database.query<{ determination_id: string }>(
      `SELECT determination.determination_id
       FROM rework_responsibility_determinations determination
       WHERE determination.rework_order_id=$1
         AND determination.stage='finalized'
         AND NOT EXISTS(
           SELECT 1
           FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=determination.determination_id
         )
       ORDER BY determination.determination_version DESC
       LIMIT 1`,
      [orderId],
    );
    if (
      current.rows[0]?.determination_id ===
      response.approval.finalizedDeterminationId
    ) {
      return response;
    }
    return { ...response, approval: null };
  }
}
