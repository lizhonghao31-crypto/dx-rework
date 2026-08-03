import { randomUUID } from "node:crypto";

import type { OwnFactoryApprovalResponse } from "@dx-rework/contracts";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OwnFactoryApprovalApplicationService } from "../../apps/api/src/rework/own-factory-approval-application-service.js";
import { OwnFactoryApprovalService } from "../../apps/api/src/rework/own-factory-approval-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const orderId = randomUUID();
const approvalId = randomUUID();
const decisionId = randomUUID();
const finalizedId = randomUUID();
const currentFinalizedId = randomUUID();
const configurationItemId = randomUUID();
const workReportId = randomUUID();
const personId = randomUUID();
const actorId = randomUUID();
const reviewId = randomUUID();

const actor: TrustedActorContext = {
  actorId,
  actorRoles: ["owner_group"],
  authorizationCapability: "own_factory:view",
  authorizationCapabilities: ["own_factory:view", "own_factory:approve"],
  requestId: "own-factory-application-test",
};

const decision = {
  decisionId,
  decision: "rejected" as const,
  actedBy: actorId,
  actorRoleSnapshot: ["owner_group"],
  opinion: "重新核对",
  decidedAt: "2026-08-03T00:01:00.000Z",
  otherOwnersNotified: true,
};

const response: OwnFactoryApprovalResponse = {
  reworkOrderId: orderId,
  reworkStatus: "pending_responsibility_action",
  orderVersion: 10,
  canView: true,
  canDecide: false,
  approval: {
    approvalId,
    finalizedDeterminationId: finalizedId,
    finalizedDeterminationVersion: 2,
    approvalVersion: 2,
    status: "rejected",
    ownFactoryTotalAmount: "1.00",
    createdAt: "2026-08-03T00:00:00.000Z",
    decision,
    sourceSnapshot: {
      finalizedDetermination: {
        determinationId: finalizedId,
        determinationVersion: 2,
        sourceOrderReviewId: reviewId,
        calculationTotal: "1.00",
        determinedBy: actorId,
        highMultiplierConfirmation: null,
      },
      qualityControl: {
        initiatedBy: actorId,
        initiatedAt: "2026-08-03T00:00:00.000Z",
      },
      wholeOrderReview: {
        orderReviewId: reviewId,
        reviewedBy: actorId,
        reviewedAt: "2026-08-03T00:00:00.000Z",
        reviewSnapshot: {},
      },
      order: {
        reworkOrderId: orderId,
        reworkNo: "RW-TEST",
        styleNo: "STYLE",
        orderNo: null,
        problemPart: "袖口",
        problemDescription: "测试",
      },
      processes: [{
        configurationItemId,
        processName: "返查",
        pricingUnit: "piece",
        baseAmount: "1.00000000",
        responsibilityAmount: "1.00",
        multiplier: "1.000",
        ownFactoryShareBps: 10000,
        ownFactoryRoundedAmount: "1.00",
      }],
      amountLines: [{
        configurationItemId,
        workReportId,
        personId,
        baseMemberShareAmount: "1.00000000",
        multiplier: "1.000",
        shareBps: 10000,
        roundedAmount: "1.00",
        workerDisplayName: "Worker",
        taskMode: "individual",
        memberSnapshot: {},
        reportSnapshot: {},
      }],
    },
  },
  history: [{
    approvalId,
    finalizedDeterminationId: finalizedId,
    finalizedDeterminationVersion: 2,
    approvalVersion: 2,
    status: "rejected",
    ownFactoryTotalAmount: "1.00",
    createdAt: "2026-08-03T00:00:00.000Z",
    decision,
  }],
};

const deliverySafeResponse: OwnFactoryApprovalResponse = {
  ...response,
  approval: response.approval
    ? {
        ...response.approval,
        decision: response.approval.decision
          ? { ...response.approval.decision, otherOwnersNotified: false }
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

describe("OwnFactoryApprovalApplicationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps only the current approval and never claims outbox delivery", async () => {
    vi.spyOn(OwnFactoryApprovalService.prototype, "get")
      .mockResolvedValue(response);
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{ determination_id: finalizedId }],
      }),
    } as unknown as Pool;
    const service = new OwnFactoryApprovalApplicationService(database);

    await expect(service.get(actor, orderId)).resolves.toEqual(
      deliverySafeResponse,
    );
  });

  it("moves a superseded approval to history when the current leaf changed", async () => {
    vi.spyOn(OwnFactoryApprovalService.prototype, "get")
      .mockResolvedValue(response);
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{ determination_id: currentFinalizedId }],
      }),
    } as unknown as Pool;
    const service = new OwnFactoryApprovalApplicationService(database);

    const result = await service.get(actor, orderId);

    expect(result.approval).toBeNull();
    expect(result.history).toEqual(deliverySafeResponse.history);
  });

  it("keeps idempotent command payloads stable while suppressing false delivery claims", async () => {
    const stored = { value: response, reused: true };
    const approve = vi
      .spyOn(OwnFactoryApprovalService.prototype, "approve")
      .mockResolvedValue(stored);
    const query = vi.fn();
    const service = new OwnFactoryApprovalApplicationService(
      { query } as unknown as Pool,
    );

    const result = await service.approve(
      actor,
      approvalId,
      { expectedOrderVersion: 10, expectedApprovalVersion: 1 },
      "stable-approval-key",
    );

    expect(result).toEqual({ value: deliverySafeResponse, reused: true });
    expect(approve).toHaveBeenCalledWith(
      actor,
      approvalId,
      { expectedOrderVersion: 10, expectedApprovalVersion: 1 },
      "stable-approval-key",
    );
    expect(query).not.toHaveBeenCalled();
  });
});
