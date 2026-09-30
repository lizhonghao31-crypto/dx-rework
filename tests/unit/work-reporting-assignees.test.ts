import { describe, expect, it, vi } from "vitest";

import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";

describe("work-reporting assignable people", () => {
  it("uses one guarded query for active temporary workers and eligible internal workers", async () => {
    const query = vi.fn(async () => ({
      rows: [
        { person_id: "person-internal", display_name: "内部工人", person_type: "internal", worker_eligible: true, tail_eligible: false },
        { person_id: "person-temporary", display_name: "临时工", person_type: "temporary", worker_eligible: true, tail_eligible: false },
      ],
    }));
    const service = new WorkReportingService({ query } as never);

    await expect(service.listAssignablePeople({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["tail_supervisor"],
      authorizationCapability: "work:assign",
      authorizationCapabilities: ["work:assign"],
      requestId: "assignable-people",
    })).resolves.toEqual([
      { personId: "person-internal", displayName: "内部工人", personType: "internal", eligibleExecutionKinds: ["worker"] },
      { personId: "person-temporary", displayName: "临时工", personType: "temporary", eligibleExecutionKinds: ["worker"] },
    ]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("JOIN app_users app_user");
    expect(sql).toContain("app_user.enabled=true");
    expect(sql).toContain("identity.provider='dingtalk'");
    expect(sql).toContain("identity.active=true");
    expect(sql).toContain("identity.employed=true");
    expect(sql).toContain("access_security_policy");
    expect(sql).toContain("assignment.role_code='worker'");
    expect(sql).toContain("assignment.role_code IN ('worker','tail_inspector')");
    expect(sql).toContain("capability.capability='tail_inspection:report'");
  });
});

