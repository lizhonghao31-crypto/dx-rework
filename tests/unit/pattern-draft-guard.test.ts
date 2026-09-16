import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ ref: null as { current: unknown } | null, value: undefined as unknown, cleanup: undefined as (() => void) | undefined, confirm: vi.fn() }));
vi.mock("react", () => ({
  useRef: (value: unknown) => harness.ref ??= { current: value },
  useState: (init: () => unknown) => [harness.value ??= init()],
  useEffect: (effect: () => () => void) => { harness.cleanup ??= effect(); },
}));
vi.mock("../../apps/web/src/system-dialog.js", () => ({ confirmInApp: harness.confirm }));
import { usePatternDraftGuard } from "../../apps/web/src/use-pattern-draft-guard.js";
import { canLeaveInternalPage } from "../../apps/web/src/internal-navigation.js";

beforeEach(() => { harness.ref = null; harness.value = undefined; harness.cleanup = undefined; harness.confirm.mockReset(); vi.stubGlobal("window", new EventTarget()); });
afterEach(() => { harness.cleanup?.(); vi.unstubAllGlobals(); });

describe("pattern draft departure", () => {
  it("leaves an empty form without prompting and preserves a dirty form on cancel", async () => {
    usePatternDraftGuard("initial", false);
    expect(await canLeaveInternalPage()).toBe(true);
    expect(harness.confirm).not.toHaveBeenCalled();
    usePatternDraftGuard("changed", false);
    harness.confirm.mockResolvedValue(false);
    expect(await canLeaveInternalPage()).toBe(false);
    expect(await canLeaveInternalPage()).toBe(false);
    expect(harness.confirm).toHaveBeenCalledTimes(2);
    harness.confirm.mockResolvedValue(true);
    expect(await canLeaveInternalPage()).toBe(true);
    expect(await canLeaveInternalPage()).toBe(true);
    expect(harness.confirm).toHaveBeenCalledTimes(3);
  });
  it("blocks an in-flight upload but does not prompt after successful save", async () => {
    usePatternDraftGuard("initial", false);
    usePatternDraftGuard("changed", true);
    expect(await canLeaveInternalPage()).toBe(false);
    expect(harness.confirm).not.toHaveBeenCalled();
    const draft = usePatternDraftGuard("changed", true);
    draft.markSaved();
    expect(await canLeaveInternalPage()).toBe(true);
    usePatternDraftGuard("changed", false);
    expect(await canLeaveInternalPage()).toBe(true);
    expect(harness.confirm).not.toHaveBeenCalled();
  });
});
