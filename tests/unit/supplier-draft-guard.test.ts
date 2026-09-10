import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupplierDraftGuard } from "../../apps/web/src/supplier-draft-guard.js";
import { installInternalNavigation, registerInternalNavigationGuard } from "../../apps/web/src/internal-navigation.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const state = { creating: true, editing: true, draft: "未保存供应商", selected: "", blocked: false };
  const confirm = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const discard = vi.fn(() => { state.creating = false; state.editing = false; state.draft = ""; });
  const guard = createSupplierDraftGuard({ isBlocked: () => state.blocked, confirm, discard });
  guard.setDirty(true);
  return { state, confirm, discard, guard };
}

/** Exercise the real router with deterministic History/DOM event doubles. No browser claim. */
function historyFixture() {
  const clicks = new Map<string, (event: unknown) => Promise<void>>();
  const events = new Map<string, () => Promise<void>>();
  const entries = [{ href: "https://fixture.test/ui/suppliers", state: { dxInternalNavigationPosition: 0 } },
    { href: "https://fixture.test/ui/suppliers/manage", state: { dxInternalNavigationPosition: 1 } }];
  let index = 1;
  const location = { get href() { return entries[index]!.href; }, origin: "https://fixture.test" };
  const history = {
    get state() { return entries[index]!.state; },
    replaceState(state: typeof entries[0]["state"]) { entries[index]!.state = state; },
    pushState(state: typeof entries[0]["state"], _unused: string, href: string) {
      entries.splice(index + 1); entries.push({ href: new URL(href, location.href).href, state }); index += 1;
    },
    async go(delta: number) { index += delta; await events.get("popstate")?.(); },
  };
  class Element { closest() { return this; } }
  class Anchor extends Element { target = ""; constructor(public href: string) { super(); } hasAttribute() { return false; } }
  vi.stubGlobal("Element", Element); vi.stubGlobal("HTMLAnchorElement", Anchor);
  vi.stubGlobal("window", {
    location, history, scrollTo: vi.fn(),
    addEventListener: (name: string, callback: () => Promise<void>) => events.set(name, callback),
    removeEventListener: (name: string) => events.delete(name),
  });
  vi.stubGlobal("document", {
    addEventListener: (name: string, callback: (event: unknown) => Promise<void>) => clicks.set(name, callback),
    removeEventListener: (name: string) => clicks.delete(name),
  });
  return {
    location, history, entries,
    click: (href: string) => clicks.get("click")!({ target: new Anchor(new URL(href, location.href).href), button: 0, preventDefault: vi.fn() }),
  };
}

describe("supplier draft departure", () => {
  it.each(["create", "edit"])("preserves %s draft on cancel and cleans it once before leaving", async mode => {
    const { state, guard, confirm, discard } = fixture();
    if (mode === "edit") { state.creating = false; state.selected = "supplier-a"; }
    const original = { ...state };
    expect(await guard.requestLeave()).toBe(false);
    expect(state).toEqual(original);
    expect(discard).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    expect(await guard.requestLeave()).toBe(true);
    expect(state).toMatchObject({ creating: false, editing: false, draft: "" });
    expect(guard.shouldBlock).toBe(false);
    expect(await guard.requestLeave()).toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("does not queue duplicate confirmations or leave during a write", async () => {
    const { state, guard, confirm, discard } = fixture();
    let resolve!: (value: boolean) => void;
    confirm.mockImplementation(() => new Promise(done => { resolve = done; }));
    const first = guard.requestLeave();
    expect(guard.pending).toBe(true);
    expect(await guard.requestLeave()).toBe(false);
    state.blocked = true;
    resolve(true);
    expect(await first).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("allows departure after a committed save even if reading the saved record failed", async () => {
    const { guard, confirm, state } = fixture();
    state.blocked = true;
    guard.markClean();
    expect(await guard.requestLeave()).toBe(false);
    state.blocked = false;
    expect(guard.shouldBlock).toBe(false);
    expect(await guard.requestLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["/ui/suppliers", "/ui/production-dashboard"])("confirms Tab/left navigation to %s once", async destination => {
    const { guard, state, confirm } = fixture();
    const history = historyFixture();
    const sync = vi.fn();
    const uninstall = installInternalNavigation("", sync);
    const unregister = registerInternalNavigationGuard(guard.requestLeave);
    try {
      await history.click(destination);
      expect(history.location.href).toBe("https://fixture.test/ui/suppliers/manage");
      expect(state.draft).toBe("未保存供应商");
      expect(sync).not.toHaveBeenCalled();
      confirm.mockResolvedValue(true);
      await history.click(destination);
      expect(history.location.href).toBe(`https://fixture.test${destination}`);
      expect(state).toMatchObject({ creating: false, editing: false, draft: "" });
      expect(history.entries).toHaveLength(3);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(2);
    } finally { unregister(); uninstall(); }
  });

  it("restores Back on continue editing, then permits Back without a second prompt on discard", async () => {
    const { guard, confirm, state } = fixture();
    const history = historyFixture();
    const sync = vi.fn();
    const uninstall = installInternalNavigation("", sync);
    const unregister = registerInternalNavigationGuard(guard.requestLeave);
    try {
      await history.history.go(-1);
      expect(history.location.href).toBe("https://fixture.test/ui/suppliers/manage");
      expect(state.draft).toBe("未保存供应商");
      expect(sync).not.toHaveBeenCalled();
      confirm.mockResolvedValue(true);
      await history.history.go(-1);
      expect(history.location.href).toBe("https://fixture.test/ui/suppliers");
      expect(state.creating).toBe(false);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(2);
    } finally { unregister(); uninstall(); }
  });
});
