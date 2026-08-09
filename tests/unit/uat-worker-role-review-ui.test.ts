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

    expect(panel).toContain('data.reworkStatus === "pending_task_assignment"');
    expect(panel).toContain("return null;");
  });
});
