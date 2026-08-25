import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("single-user UAT worker grant and review visibility", () => {
  it("uses canonical business actor construction for employee access mutations", async () => {
    const routes = await readFile(
      new URL("../../apps/api/src/access/employee-access-routes.ts", import.meta.url),
      "utf8",
    );

    expect(routes).toContain('import { businessActor } from "./business-authority.js";');
    expect(routes).toContain("return businessActor(");
    expect(routes).toContain('"access:admin"');
    expect(routes).not.toContain("actorRoles: user.businessRoles ?? []");
  });

  it("does not show whole-order close-out controls before work is assigned", async () => {
    const panel = await readFile(
      new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url),
      "utf8",
    );

    expect(panel).toContain('["draft", "pending_process_configuration", "pending_ie_review", "pending_task_assignment"].includes(data.reworkStatus)');
    expect(panel).toContain("return null;");
    expect(panel).toContain('tailStage && data.canReview');
  });
});

