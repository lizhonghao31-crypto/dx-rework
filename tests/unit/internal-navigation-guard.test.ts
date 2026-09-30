import { describe, expect, it, vi } from "vitest";
import { canLeaveInternalPage, navigationRollbackDelta, registerInternalNavigationGuard } from "../../apps/web/src/internal-navigation.js";

describe("internal navigation leave guard", () => {
  it("leaves ordinary pages unchanged and requires a registered confirmation", async () => {
    expect(await canLeaveInternalPage()).toBe(true);
    const guard = vi.fn().mockResolvedValue(false);
    const unregister = registerInternalNavigationGuard(guard);
    try {
      expect(await canLeaveInternalPage()).toBe(false);
      guard.mockResolvedValue(true);
      expect(await canLeaveInternalPage()).toBe(true);
    } finally { unregister(); }
    expect(await canLeaveInternalPage()).toBe(true);
  });

  it("does not queue a second navigation while a confirmation is outstanding", async () => {
    let resolve!: (value: boolean) => void;
    const unregister = registerInternalNavigationGuard(() => new Promise<boolean>((done) => { resolve = done; }));
    try {
      const first = canLeaveInternalPage();
      expect(await canLeaveInternalPage()).toBe(false);
      resolve(false);
      expect(await first).toBe(false);
    } finally { unregister(); }
  });

  it("restores managed Back/Forward distances without guessing unknown history", () => {
    expect(navigationRollbackDelta(3, 1)).toBe(2);
    expect(navigationRollbackDelta(1, 3)).toBe(-2);
    expect(navigationRollbackDelta(1, undefined)).toBeNull();
    expect(navigationRollbackDelta(1, 1)).toBeNull();
  });
});
