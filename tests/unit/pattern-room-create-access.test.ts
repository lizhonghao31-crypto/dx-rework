import { describe, expect, it } from "vitest";
import { canCreatePatternRoomOrders, patternRoomCreateRequirements } from "../../apps/web/src/pattern-room-access.js";
import { hasPageAccess } from "../../apps/web/src/auth.js";

describe("board-room creation navigation", () => {
  const user = (role: string, capabilities: string[]) => ({ id: "fixture", businessRoles: [role], capabilities });
  it("opens creation for each authorized creator and Root", () => {
    expect(canCreatePatternRoomOrders(user("sample_designer", ["pattern_room:orders:create"]))).toBe(true);
    expect(canCreatePatternRoomOrders(user("order_merchandiser", ["pattern_room:misc:create"]))).toBe(true);
    expect(canCreatePatternRoomOrders({ id: "root", isRoot: true, capabilities: [] })).toBe(true);
  });
  it("keeps read-only users out even when a write capability is accidentally assigned", () => {
    for (const role of ["worker", "pattern_room_supervisor", "finance_read", "finance_director", "owner_group"]) {
      const reader = user(role, ["pattern_room:orders:view", "pattern_room:orders:create", "pattern_room:misc:create"]);
      expect(canCreatePatternRoomOrders(reader)).toBe(false);
      expect(patternRoomCreateRequirements.some(requirement => hasPageAccess(reader, requirement))).toBe(false);
    }
    expect(canCreatePatternRoomOrders(user("sample_designer", ["pattern_room:orders:view"]))).toBe(false);
  });
});
