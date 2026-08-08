import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("whole-order-review read access contract", () => {
  it("lets each N06 actor read the same server-backed review context they must act on", async () => {
    const routes = await readFile(
      "apps/api/src/rework/whole-order-review-routes.ts",
      "utf8",
    );

    expect(routes).toContain('user.businessRoles?.includes("tail_supervisor")');
    expect(routes).toContain('user.capabilities.includes("submission:audit")');
    expect(routes).toContain('user.businessRoles?.includes("order_merchandiser")');
    expect(routes).toContain('user.capabilities.includes("quantity:confirm")');
    expect(routes).toContain('businessActor(dependencies.root, user, request.id, "quantity:confirm")');
    expect(routes).toContain('user.businessRoles?.includes("ie_reviewer")');
    expect(routes).toContain('user.capabilities.includes("process:review")');
    expect(routes).toContain('businessActor(dependencies.root, user, request.id, "process:review")');
  });
});
