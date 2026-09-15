import { describe, expect, it } from "vitest";
import { memberWriteRouteModule } from "../../apps/api/src/access/member-module-http.js";
import { moduleCanWrite } from "../../apps/web/src/member-module-policy.js";

describe("member module read and action boundaries", () => {
  it("retains Root priority and default behavior, while the bound member cannot use either module", () => {
    const limited = { readOnlyModules: ["rework", "sourcing"] as const };
    expect(moduleCanWrite(limited, "rework")).toBe(false);
    expect(moduleCanWrite(limited, "sourcing")).toBe(false);
    expect(moduleCanWrite({ ...limited, isRoot: true }, "rework")).toBe(true);
    expect(moduleCanWrite({ ...limited, isRoot: true }, "sourcing")).toBe(true);
    expect(moduleCanWrite({}, "rework")).toBe(true);
    expect(moduleCanWrite(null, "rework")).toBe(false);
  });
  it.each([
    ["POST", "/rework-orders/:reworkOrderId/responsibility-owner-signature/approve", "rework"],
    ["PUT", "/rework-orders/:reworkOrderId/draft", "rework"],
    ["POST", "/external-responsibility-batches/:batchId/allocate-suppliers", "rework"],
    ["POST", "/external-responsibility-revision-requests/:requestId/approve", "rework"],
    ["POST", "/sourcing/cases/:id/factory-changes", "sourcing"],
    ["POST", "/production-reporting/:id/reports", "sourcing"],
    ["GET", "/rework-orders/:id", null],
    ["POST", "/master-data/suppliers", null],
    ["POST", "/sample/orders", null],
    ["POST", "/production-closure/alerts/:id/read", null],
    ["POST", "/rework-orders/inspection-report-extractions", null],
    ["POST", "/auth/session/refresh", null],
  ])("classifies %s %s without blocking independent modules or technical reads", (method, path, expected) => {
    expect(memberWriteRouteModule(method, path)).toBe(expected);
  });
});
