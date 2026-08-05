import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { AdminConsoleService } from "../../apps/api/src/admin-console-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor = (): TrustedActorContext => ({
  actorId: randomUUID(),
  actorRoles: ["system_admin"],
  authorizationCapability: "admin:exception:manage",
  authorizationCapabilities: ["admin:read", "admin:exception:manage"],
  requestId: `admin-test-${randomUUID()}`,
});

describe("admin console service safety", () => {
  it("does not advertise export jobs as retryable before an export retry path exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminConsoleService({ query } as unknown as Pool);

    await expect(service.exceptions({ limit: 50 })).resolves.toEqual({ items: [], nextCursor: null });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("'export_job_failed'");
    expect(sql).toMatch(/'export_job_failed'.*last_error,false,NULL::text/s);
  });

  it("rejects an actively claimed processing outbox row without clearing its worker fence", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          status: "processing",
          attempts: 2,
          last_error: null,
          claimed_at: new Date(),
          stale_processing: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
    const service = new AdminConsoleService(db);

    await expect(service.retry(
      actor(),
      "message_outbox_failed",
      randomUUID(),
      { expectedVersion: 2, reason: "retry only after claim expiry" },
      "active-claim",
    )).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE message_outbox SET status='pending'"))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
