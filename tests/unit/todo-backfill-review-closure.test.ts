import { describe, expect, it, vi } from "vitest";

import { TodoBackfillService } from "../../apps/api/src/todos/backfill-service.js";

type InternalBackfill = {
  projectedTodos(client: { query: ReturnType<typeof vi.fn> }, candidate: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  candidateStillApplicable(client: { query: ReturnType<typeof vi.fn> }, candidate: Record<string, unknown>): Promise<boolean>;
  pendingResponsibility(watermark: { createdAt: string; eventId: string }): Promise<Array<Record<string, unknown>>>;
};

const serviceWithQuery = (query: ReturnType<typeof vi.fn>): InternalBackfill =>
  new TodoBackfillService({ query } as never) as unknown as InternalBackfill;

describe("PR-13 backfill review closure", () => {
  it("recognizes every suffixed todo created by a parallel projection", async () => {
    const rows = [
      {
        status: "pending",
        created_request_id: "request-1",
        dedupe_key: "own-factory:approval-1:owner-1",
      },
      {
        status: "pending",
        created_request_id: "request-1",
        dedupe_key: "own-factory:approval-1:owner-2",
      },
    ];
    const query = vi.fn().mockResolvedValue({ rows });
    const service = serviceWithQuery(vi.fn());
    const candidate = {
      dedupeKey: "own-factory:approval-1",
      sourceEventId: "00000000-0000-4000-8000-000000000001",
      sourceAction: "rework.own_factory_approval.create",
      entityType: "rework_order",
      entityId: "00000000-0000-4000-8000-000000000002",
      category: "own_factory_approval",
    };

    await expect(service.projectedTodos({ query }, candidate)).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("dedupe_key LIKE $2"),
      [
        candidate.dedupeKey,
        `${candidate.dedupeKey}:%`,
        candidate.sourceEventId,
        candidate.sourceAction,
        candidate.entityType,
        candidate.entityId,
        candidate.category,
      ],
    );
  });

  it("keeps the responsibility-handler candidate after high-multiplier confirmation", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        determination_id: "00000000-0000-4000-8000-000000000010",
        rework_order_id: "00000000-0000-4000-8000-000000000011",
        determination_version: 3,
        handler_user_id: "00000000-0000-4000-8000-000000000012",
        created_by: "00000000-0000-4000-8000-000000000013",
        source_event_id: "00000000-0000-4000-8000-000000000014",
        actor_roles: ["production_management"],
        has_high_multiplier: true,
        high_multiplier_confirmed: true,
      }],
    });
    const service = serviceWithQuery(query);

    const candidates = await service.pendingResponsibility({
      createdAt: "2026-08-04T00:00:00.000Z",
      eventId: "00000000-0000-4000-8000-000000000015",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "responsibility_determination",
      authorityId: "00000000-0000-4000-8000-000000000010",
      authorityVersion: 3,
    });
  });

  it("rejects a candidate whose authoritative state changed before projection", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = serviceWithQuery(vi.fn());

    await expect(service.candidateStillApplicable({ query }, {
      kind: "process_configuration",
      authorityId: "00000000-0000-4000-8000-000000000020",
      authorityVersion: 4,
      sourceEventId: "00000000-0000-4000-8000-000000000021",
      sourceAction: "rework.submit",
      entityType: "rework_order",
      entityId: "00000000-0000-4000-8000-000000000020",
    })).resolves.toBe(false);
    expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  });
});
