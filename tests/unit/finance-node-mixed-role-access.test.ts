import { describe, expect, it } from "vitest";
import { canOperateReworkNode } from "../../apps/web/src/rework-node-access.js";

describe("finance reader at the visible N05 quantity-adjustment node", () => {
  it.each(["quantity:confirm", "process:review", "quantity:adjust", "submission:audit"])(
    "retains the existing workspace when a second role grants %s", capability => {
      expect(canOperateReworkNode(["rework:finance_nodes:read", capability], "whole_order_review")).toBe(true);
    },
  );
  it("keeps the finance-only account read-only and does not borrow an unrelated operation", () => {
    expect(canOperateReworkNode(["rework:finance_nodes:read"], "whole_order_review")).toBe(false);
    expect(canOperateReworkNode(["rework:finance_nodes:read", "quantity:confirm"], "owner_signature")).toBe(false);
  });
});
