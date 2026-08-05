import { randomUUID } from "node:crypto";

import {
  ErpEmergencyReworkIntakeV1Schema,
  ErpReworkIntakeV1Schema,
  ErpReworkResultV1Schema,
} from "@dx-rework/contracts/erp-integration";
import { describe, expect, it } from "vitest";

const payload = {
  styleNo: "ST-100",
  orderNo: "SO-100",
  merchandiserUserId: randomUUID(),
  processingFactory: { type: "own_factory" as const },
  problemPart: "后中",
  problemDescription: "线迹不良",
  reworkQuantity: 12,
};

describe("ERP integration contract v1", () => {
  it("accepts the exact versioned inbound source contract", () => {
    const input = {
      contractVersion: "1",
      source: {
        sourceSystem: "erp",
        externalId: "ERP-RW-100",
        externalIdempotencyKey: "erp-rw-100-v1",
        erpNodeId: "N-100",
      },
      payload,
    };
    expect(ErpReworkIntakeV1Schema.parse(input)).toEqual(input);
    expect(() => ErpReworkIntakeV1Schema.parse({ ...input, contractVersion: "2" })).toThrow();
    expect(() => ErpReworkIntakeV1Schema.parse({ ...input, unexpected: true })).toThrow();
  });

  it("requires an explicit reason for emergency intake", () => {
    expect(ErpEmergencyReworkIntakeV1Schema.parse({
      contractVersion: "1",
      reason: "ERP临时不可用，需继续生产",
      payload,
    }).reason).toContain("ERP");
    expect(() => ErpEmergencyReworkIntakeV1Schema.parse({
      contractVersion: "1",
      reason: " ",
      payload,
    })).toThrow();
  });

  it("keeps the result contract read-only and reference-only", () => {
    const reworkOrderId = randomUUID();
    const result = ErpReworkResultV1Schema.parse({
      contractVersion: "1",
      source: {
        original: {
          sourceSystem: "erp",
          externalId: "ERP-RW-100",
          externalIdempotencyKey: "erp-rw-100-v1",
          erpNodeId: "N-100",
        },
        linkedErp: {
          sourceSystem: "erp",
          externalId: "ERP-RW-100",
          externalIdempotencyKey: "erp-rw-100-v1",
          erpNodeId: "N-100",
        },
        linkageStatus: "linked",
      },
      reworkOrder: {
        reworkOrderId,
        reworkNo: "RW-20260806-001",
        status: "completed",
        completedQuantity: "12.00",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      workerWages: { totalAmount: "20.00", items: [] },
      responsibility: {
        totalAmount: "10.00",
        ownFactoryAmount: "5.00",
        allocations: [],
      },
      deduction: {
        proposedAmount: "5.00",
        deductedAmount: "3.00",
        remainingAmount: "2.00",
      },
      approval: { ownFactory: null },
      attachments: [{
        attachmentId: randomUUID(),
        filename: "evidence.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        createdAt: "2026-08-06T00:00:00.000Z",
      }],
      asOf: "2026-08-06T00:00:00.000Z",
    });
    expect(result.attachments[0]).not.toHaveProperty("downloadUrl");
  });
});
