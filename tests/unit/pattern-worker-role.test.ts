import { describe, expect, it } from "vitest";
import { canUsePatternOrder, PATTERN_ORDER_ROLES } from "@dx-rework/contracts/pattern-orders";
import { accessModuleIdsForRole, todoModuleIdsForUser } from "../../apps/web/src/platform-access.js";

describe("separate board worker role", () => {
  const capabilities = ["pattern_room:orders:view", "pattern_room:orders:complete", "todo:view", "tools:user"];
  it("grants only own board execution and preserves Root", () => {
    for (const capability of Object.keys(PATTERN_ORDER_ROLES) as Array<keyof typeof PATTERN_ORDER_ROLES>) {
      expect(canUsePatternOrder(["pattern_room_worker"], Object.keys(PATTERN_ORDER_ROLES), capability)).toBe(["pattern_room:orders:view", "pattern_room:orders:complete"].includes(capability));
      expect(canUsePatternOrder(["worker"], Object.keys(PATTERN_ORDER_ROLES), capability)).toBe(false);
      expect(canUsePatternOrder(["root_superuser"], [], capability)).toBe(true);
    }
    expect(canUsePatternOrder(["pattern_room_worker"], [], "pattern_room:orders:complete")).toBe(false);
  });
  it("labels board personnel separately in employee access and task navigation", () => {
    expect(accessModuleIdsForRole("pattern_room_worker", capabilities)).toEqual(["pattern_room"]);
    expect(todoModuleIdsForUser({ capabilities, businessRoles: ["pattern_room_worker"] })).toContain("pattern_room");
    expect(todoModuleIdsForUser({ capabilities, businessRoles: ["worker"] })).not.toContain("pattern_room");
  });
});
