import { describe, expect, it, vi } from "vitest";
import { IdempotencyRepository, MessageOutboxRepository } from "../../apps/api/src/tools/repositories.js";

describe("public tools repository guards", () => {
  it("rejects completion and outbox transitions when no row changes", async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    await expect(new IdempotencyRepository().complete(client as never, { scope: "s", actorKey: "a", key: "k", statusCode: 200, response: {} })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    await expect(new MessageOutboxRepository().markSent(client as never, "event")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    await expect(new MessageOutboxRepository().markFailed(client as never, "event", new Error("safe"), 10)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
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
});
