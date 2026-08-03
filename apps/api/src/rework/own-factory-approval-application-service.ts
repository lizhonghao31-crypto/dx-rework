import type {
  ApproveOwnFactoryApproval,
  RejectOwnFactoryApproval,
} from "@dx-rework/contracts";
import type { Pool } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import { OwnFactoryApprovalService } from "./own-factory-approval-service.js";

export class OwnFactoryApprovalApplicationService {
  private readonly service: OwnFactoryApprovalService;

  constructor(database: Pool) {
    this.service = new OwnFactoryApprovalService(database);
  }

  listQueue(...args: Parameters<OwnFactoryApprovalService["listQueue"]>) {
    return this.service.listQueue(...args);
  }

  get(...args: Parameters<OwnFactoryApprovalService["get"]>) {
    return this.service.get(...args);
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
}
