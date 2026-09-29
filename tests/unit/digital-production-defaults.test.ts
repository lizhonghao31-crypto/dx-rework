import { expect, it } from "vitest";
import { initialDigitalProductGroup } from "../../apps/web/src/digital-production-defaults.js";
it("initializes source confirmation to the customer's allowed group", () => {
  const customers = [{ code: "HO", name: "HOTSHOTS", productGroups: ["女童"] }, { code: "FL", name: "FILANTO", productGroups: ["女装"] }, { code: "GM", name: "GAMESTER", productGroups: ["男童"] }];
  expect(initialDigitalProductGroup(customers, "HO")).toBe("女童");
  expect(initialDigitalProductGroup(customers, "FL")).toBe("女装");
  expect(initialDigitalProductGroup(customers, "GM")).toBe("男童");
  expect(initialDigitalProductGroup(customers, null)).toBe("男装");
});
