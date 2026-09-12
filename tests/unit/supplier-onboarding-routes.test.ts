import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerSupplierOnboardingRoutes, type SupplierOnboardingDependencies } from "../../apps/api/src/access/supplier-onboarding-routes.js";
import { SupplierOnboardingProfileSchema } from "@dx-rework/contracts/supplier-onboarding";
import { buildTodoDeepLink } from "../../apps/api/src/todos/deep-link.js";
import { todoModuleIdsForUser } from "../../apps/web/src/platform-access.js";

it.each(["order_merchandiser", "embroidery_washing_merchandiser", "owner_group", "production_management", "system_admin", "ie_reviewer", "root_superuser"])("enforces HTTP application roles for %s", async role => {
  const applicant = ["order_merchandiser", "embroidery_washing_merchandiser"].includes(role);
  const reviewer = ["owner_group", "production_management", "root_superuser"].includes(role);
  const submit = vi.fn().mockResolvedValue({ reused: false, statusCode: 200, response: {} });
  const decide = vi.fn().mockResolvedValue({ reused: false, statusCode: 200, response: {} });
  const get = vi.fn().mockResolvedValue({});
  const app = Fastify();
  registerSupplierOnboardingRoutes(app, {
    authenticate: async () => ({ id: "fixture", displayName: role, businessRoles: [role], capabilities: ["supplier_onboarding:request", "supplier_onboarding:approve"] }),
    root: { isRootUser: async () => role === "root_superuser" }, service: { submit, decide, get },
  } as unknown as SupplierOnboardingDependencies);
  try {
    expect((await app.inject({ method: "POST", url: "/supplier-onboarding/requests", payload: {} })).statusCode).toBe(applicant ? 200 : 403);
    expect((await app.inject({ method: "POST", url: "/supplier-onboarding/requests/00000000-0000-4000-8000-000000000001/approve", payload: {} })).statusCode).toBe(reviewer ? 200 : 403);
    const response = await app.inject({ method: "GET", url: "/supplier-onboarding/requests/00000000-0000-4000-8000-000000000001" });
    expect(response.statusCode).toBe(applicant || reviewer ? 200 : 403);
    if (response.statusCode === 200) expect(response.headers["cache-control"]).toBe("no-store");
  } finally { await app.close(); }
});
it("requires capability, preserves direct maintenance priority for mixed roles, and rejects unexpected fields", async () => {
  let roles = ["order_merchandiser"], caps: string[] = [];
  const submit = vi.fn(); const app = Fastify();
  registerSupplierOnboardingRoutes(app, { authenticate: async () => ({ id: "fixture", displayName: "用户", businessRoles: roles, capabilities: caps }), root: { isRootUser: async () => false }, service: { submit } } as unknown as SupplierOnboardingDependencies);
  try {
    expect((await app.inject({ method: "POST", url: "/supplier-onboarding/requests", payload: {} })).statusCode).toBe(403);
    roles = ["order_merchandiser", "owner_group"]; caps = ["supplier_onboarding:request"];
    expect((await app.inject({ method: "POST", url: "/supplier-onboarding/requests", payload: {} })).statusCode).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  } finally { await app.close(); }
  expect(SupplierOnboardingProfileSchema.safeParse({ supplierCode: "CLIENT_CODE", bankAccount: 123 }).success).toBe(false);
});
it("routes supplier todos into their own module and preserves the deployment base path", () => {
  expect(buildTodoDeepLink("/acceptance/", { routeName: "supplier_onboarding", entityId: "00000000-0000-4000-8000-000000000002", todoId: "00000000-0000-4000-8000-000000000001" })).toBe("/acceptance/ui/suppliers/requests/00000000-0000-4000-8000-000000000002?todo=00000000-0000-4000-8000-000000000001");
  expect(todoModuleIdsForUser({ businessRoles: ["embroidery_washing_merchandiser"], capabilities: ["todo:view", "supplier_onboarding:request"] })).toContain("suppliers");
  expect(todoModuleIdsForUser({ businessRoles: ["system_admin"], capabilities: ["todo:view", "supplier_onboarding:request"] })).not.toContain("suppliers");
});
