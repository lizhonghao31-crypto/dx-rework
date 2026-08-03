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
      this.withTruthfulDeliveryState(await this.service.get(actor, orderId)),
      orderId,
    );
  }

  async approve(
    actor: TrustedActorContext,
    approvalId: string,
    input: ApproveOwnFactoryApproval,
    key: string,
  ) {
    const result = await this.service.approve(actor, approvalId, input, key);
    return {
      ...result,
      value: this.withTruthfulDeliveryState(result.value),
    };
  }

  async reject(
    actor: TrustedActorContext,
    approvalId: string,
    input: RejectOwnFactoryApproval,
    key: string,
  ) {
    const result = await this.service.reject(actor, approvalId, input, key);
    return {
      ...result,
      value: this.withTruthfulDeliveryState(result.value),
    };
  }

  /**
   * PR-10 creates an outbox intent but does not own delivery receipts.
   * Until the notification delivery integration records a sent state, the
   * public API must not claim that another owner has been notified.
   */
  private withTruthfulDeliveryState(
    response: OwnFactoryApprovalResponse,
  ): OwnFactoryApprovalResponse {
    return {
      ...response,
      approval: response.approval
        ? {
            ...response.approval,
            decision: response.approval.decision
              ? {
                  ...response.approval.decision,
                  otherOwnersNotified: false,
                }
              : null,
          }
        : null,
      history: response.history.map((item) => ({
        ...item,
        decision: item.decision
          ? { ...item.decision, otherOwnersNotified: false }
          : null,
      })),
    };
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
