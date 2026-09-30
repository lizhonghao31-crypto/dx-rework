import { randomUUID } from "node:crypto";

import type { AllocateExternalSuppliers } from "@dx-rework/contracts/external-responsibility";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalResponsibilityAllocationService } from "../../apps/api/src/rework/external-responsibility-allocation-service.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../../apps/api/src/tools/repositories.js";

const orderId = randomUUID();
const batchId = randomUUID();
const itemId = randomUUID();
const supplierId = randomUUID();
const actorId = randomUUID();
const eventId = randomUUID();

const actor: TrustedActorContext = {
  actorId,
  actorRoles: ["order_merchandiser"],
  authorizationCapability: "external_responsibility:sign",
  authorizationCapabilities: ["external_responsibility:sign"],
  requestId: "own-factory-override-test",
};

const input = (
  processingFactoryOverrideReason?: string,
): AllocateExternalSuppliers => ({
  expectedBatchVersion: 1,
  allocations: [{
    responsibilityType: "processing_factory",
    supplierId,
    externalItemIds: [itemId],
    ...(processingFactoryOverrideReason
      ? { processingFactoryOverrideReason }
      : {}),
  }],
});

const databaseFixture = () => {
  let caseInsertParameters: unknown[] | undefined;
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM rework_external_responsibility_batches")) {
      return {
        rows: [{
          rework_order_id: orderId,
          batch_version: 1,
          status: "active",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM rework_orders")) {
      return {
        rows: [{
          rework_order_id: orderId,
          rework_no: "RW-OWN-FACTORY",
          status: "pending_responsibility_action",
          version: 8,
          style_no: "STYLE",
          order_no: null,
          merchandiser_user_id: actorId,
          processing_factory_type: "own_factory",
          processing_factory_supplier_id: null,
          processing_factory_supplier_version: null,
          problem_part: "袖口",
          problem_description: "本厂订单改由外部加工厂承担",
          rework_quantity: 1,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("set_config(")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM rework_external_responsibility_items item")) {
      return {
        rows: [{
          external_item_id: itemId,
          responsibility_type: "processing_factory",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM rework_external_responsibility_case_items")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("external_responsibility_can_sign")) {
      return { rows: [{ permitted: true }], rowCount: 1 };
    }
    if (sql.includes("FROM current_supplier_catalog")) {
      return {
        rows: [{
          supplier_code: "EXTFAC01",
          supplier_name: "External Factory",
          supplier_type: "factory",
          version: 1,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("COALESCE(sum(proposed_amount)")) {
      return { rows: [{ total: "1.00" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO rework_external_responsibility_cases")) {
      caseInsertParameters = parameters;
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes("INSERT INTO rework_external_responsibility_case_items")
      || sql.includes("UPDATE rework_external_responsibility_batches")
    ) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in fixture: ${sql}`);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const database = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return {
    database,
    query,
    caseInsertParameters: () => caseInsertParameters,
  };
};

describe("ExternalResponsibilityAllocationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an external processing factory without a reason for an own-factory order", async () => {
    vi.spyOn(IdempotencyService.prototype, "execute")
      .mockImplementation(async (_client, _request, work) => ({
        ...await work(),
        reused: false,
      }));
    vi.spyOn(OperationEventRepository.prototype, "append")
      .mockResolvedValue(eventId);
    vi.spyOn(MessageOutboxRepository.prototype, "enqueue")
      .mockResolvedValue(randomUUID());
    const fixture = databaseFixture();
    const service = new ExternalResponsibilityAllocationService(
      fixture.database,
      { get: vi.fn().mockResolvedValue(null) },
    );

    await expect(service.allocateSuppliers(
      actor,
      batchId,
      input(),
      "own-factory-missing-reason",
    )).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(fixture.caseInsertParameters()).toBeUndefined();
    expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("persists the reason when an own-factory order selects an external factory", async () => {
    vi.spyOn(IdempotencyService.prototype, "execute")
      .mockImplementation(async (_client, _request, work) => ({
        ...await work(),
        reused: false,
      }));
    vi.spyOn(OperationEventRepository.prototype, "append")
      .mockResolvedValue(eventId);
    const enqueue = vi.spyOn(MessageOutboxRepository.prototype, "enqueue")
      .mockResolvedValue(randomUUID());
    const fixture = databaseFixture();
    const service = new ExternalResponsibilityAllocationService(
      fixture.database,
      { get: vi.fn().mockResolvedValue(null) },
    );

    await service.allocateSuppliers(
      actor,
      batchId,
      input("本厂原加工订单改由外部加工厂承担扣款"),
      "own-factory-with-reason",
    );

    expect(fixture.caseInsertParameters()?.[12]).toBe(
      "本厂原加工订单改由外部加工厂承担扣款",
    );
    const caseInsert = fixture.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO rework_external_responsibility_cases")
    );
    expect(caseInsert?.[0]).toContain(
      "'pending_payables_confirmation',CURRENT_TIMESTAMP",
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: "rework.external_responsibility.pending_payables",
        recipientKey: "factory_payables",
      }),
    );
    expect(fixture.query).toHaveBeenCalledWith("COMMIT");
  });
});
