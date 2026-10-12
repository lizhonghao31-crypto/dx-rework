import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import type { WholeOrderReviewResponse } from "@dx-rework/contracts";

describe("whole-order-review read access contract", () => {
  it("admits review actors at the route before the service checks their current stage", async () => {
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

  it.each([
    { name: "N05 ordinary IE", stage: "pending_order_review", roles: ["ie_reviewer"], caps: ["process:review"], allowed: false },
    { name: "N05 tail", stage: "pending_order_review", roles: ["tail_supervisor"], caps: ["submission:audit"], allowed: true },
    { name: "N05 Root", stage: "pending_order_review", roles: ["root_superuser"], caps: [], allowed: true },
    { name: "N05 legitimate mixed roles", stage: "pending_order_review", roles: ["ie_reviewer", "tail_supervisor"], caps: ["process:review", "submission:audit"], allowed: true },
    { name: "N05 delegated IE", stage: "pending_order_review", roles: ["ie_reviewer"], caps: ["process:review"], delegation: "submission:audit", allowed: true },
    { name: "N05 absent or invalid delegation", stage: "pending_order_review", roles: ["ie_reviewer"], caps: ["process:review"], delegation: undefined, allowed: false },
    { name: "N05 missing tail role", stage: "pending_order_review", roles: ["worker"], caps: ["submission:audit"], allowed: false },
    { name: "N05 missing tail capability", stage: "pending_order_review", roles: ["tail_supervisor"], caps: [], allowed: false },
    { name: "N06 IE", stage: "pending_final_quantity_ie_review", roles: ["ie_reviewer"], caps: ["process:review"], allowed: true },
    { name: "N06 tail", stage: "pending_final_quantity_ie_review", roles: ["tail_supervisor"], caps: ["submission:audit"], allowed: false },
    { name: "N06 missing IE role", stage: "pending_final_quantity_ie_review", roles: ["worker"], caps: ["process:review"], allowed: false },
    { name: "N06 missing IE capability", stage: "pending_final_quantity_ie_review", roles: ["ie_reviewer"], caps: [], allowed: false },
  ])("keeps the actual formal read guard: $name", async ({ stage, roles, caps, allowed, delegation }) => {
    const orderId = "00000000-0000-4000-8000-000000000002";
    const actorId = "00000000-0000-4000-8000-000000000003";
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toMatch(/^\s*SELECT\b/i);
      if (sql.includes("FROM rework_orders WHERE rework_order_id=")) {
        expect(values).toEqual([orderId]);
        return { rows: [{ rework_order_id: orderId, status: stage, processing_factory_supplier_id: null }], rowCount: 1 };
      }
      if (sql.includes("FROM delegated_authorizations delegation")) {
        expect(values.slice(0, 3)).toEqual([actorId, values[1], orderId]);
        return { rows: [{ permitted: delegation !== undefined && delegation === values[1] }], rowCount: 1 };
      }
      throw new Error("Unexpected formal guard query");
    });
    const service = new WholeOrderReviewService({ query } as unknown as Pool);
    // Run the real get/order/capability/delegation guard; DTO queries are outside this paired guard test.
    const dto = vi.spyOn(service as unknown as { dto: (...args: unknown[]) => Promise<WholeOrderReviewResponse> }, "dto")
      .mockResolvedValue({ reworkOrderId: orderId } as WholeOrderReviewResponse);
    const result = service.get({ actorId, actorRoles: roles, authorizationCapability: caps[0] ?? "", authorizationCapabilities: caps, requestId: "synthetic-guard-test" }, orderId);
    if (allowed) {
      await expect(result).resolves.toEqual({ reworkOrderId: orderId });
      expect(dto).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "当前用户无权读取最终数量确认信息" });
      expect(dto).not.toHaveBeenCalled();
    }
  });
});
