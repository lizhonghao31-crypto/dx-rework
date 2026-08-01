import { describe, expect, it, vi } from "vitest";
import { ExportJobService } from "../../apps/api/src/tools/exports.js";
import { IdempotencyRepository, MessageOutboxRepository, OperationEventRepository } from "../../apps/api/src/tools/repositories.js";

describe("public tools repository guards", () => {
  it("rejects completion and outbox transitions when no row changes", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    await expect(new IdempotencyRepository().complete(client as never, { scope: "s", actorKey: "a", key: "k", acquisitionToken: "acquisition", statusCode: 200, response: {} })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    await expect(new MessageOutboxRepository().markSent(client as never, "event", "lease")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    await expect(new MessageOutboxRepository().markFailed(client as never, "event", "lease", new Error("safe"), 10)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    expect(client.query.mock.calls[0]![0]).toContain("acquisition_token=$6");
    expect(client.query.mock.calls[1]![0]).toContain("claim_token=$2");
    expect(client.query.mock.calls[2]![0]).toContain("claim_token=$2");
  });

  it("bounds leases and emits recovery/semantic comparison SQL", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    const repository = new MessageOutboxRepository();
    await expect(repository.claim(client as never, 1, 29)).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    await repository.claim(client as never, 1, 300);
    expect(client.query.mock.calls[0]![0]).toContain("status='processing' AND claimed_at <=");
    expect(client.query.mock.calls[0]![0]).toContain("SKIP LOCKED");
    await expect(repository.enqueue(client as never, { topic: "t", aggregateType: "a", aggregateId: "1", payload: {}, recipientKey: "r", idempotencyKey: "k" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(client.query.mock.calls[1]![0]).toContain("message_outbox.payload=EXCLUDED.payload");
  });

  it("rejects empty or malformed audit role snapshots before issuing SQL", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
    const repository = new OperationEventRepository();
    const input = { action: "test", entityType: "test", entityId: "1" };
    await expect(repository.append(client as never, {
      actorId: "00000000-0000-4000-8000-000000000099",
      actorRoles: [],
      authorizationCapability: "tools:user",
      requestId: "request",
    }, input)).rejects.toMatchObject({ code: "NO_BUSINESS_ROLE", statusCode: 403 });
    await expect(repository.append(client as never, {
      actorId: "00000000-0000-4000-8000-000000000099",
      actorRoles: ["bad role"],
      authorizationCapability: "tools:user",
      requestId: "request",
    }, input)).rejects.toMatchObject({ code: "NO_BUSINESS_ROLE", statusCode: 403 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects invalid retry delays before issuing SQL", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
    const repository = new MessageOutboxRepository();
    await expect(repository.markFailed(client as never, "event", "lease", new Error("safe"), 0)).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    await expect(repository.markFailed(client as never, "event", "lease", new Error("safe"), 86_401)).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("returns all routing fields required by a generic outbox worker", async () => {
    const row = {
      event_id: "event-1",
      topic: "rework.created",
      aggregate_type: "rework",
      aggregate_id: "rework-1",
      payload: { quantity: 7 },
      recipient_key: "user-1",
      idempotency_key: "delivery-1",
      claim_token: "claim-1",
      attempts: 2,
    };
    const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [row] })) };
    await expect(new MessageOutboxRepository().claim(client as never)).resolves.toEqual([{
      eventId: "event-1",
      topic: "rework.created",
      aggregateType: "rework",
      aggregateId: "rework-1",
      payload: { quantity: 7 },
      recipientKey: "user-1",
      idempotencyKey: "delivery-1",
      claimToken: "claim-1",
      attempts: 2,
    }]);
    expect(client.query.mock.calls[0]![0]).toContain("o.recipient_key,o.idempotency_key");
  });

  it("requires a ready, authorized result attachment before export completion", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    const service = new ExportJobService({} as never);
    await expect(service.complete(client as never, "export-1", "claim-1", "attachment-1")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    expect(client.query.mock.calls[0]![0]).toContain("a.status='ready'");
    expect(client.query.mock.calls[0]![0]).toContain("a.uploaded_by=j.requested_by");
    expect(client.query.mock.calls[0]![0]).toContain("a.entity_type='export_job'");
    expect(client.query.mock.calls[0]![0]).toContain("j.claim_token=$2");
  });
});
