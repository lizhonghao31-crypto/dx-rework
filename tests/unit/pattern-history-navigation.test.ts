import { afterEach, describe, expect, it, vi } from "vitest";
import { PatternRoomOrderDetailPage } from "../../apps/web/src/pattern-room-orders-page.js";
import { installInternalNavigation, navigateInternalPage } from "../../apps/web/src/internal-navigation.js";

afterEach(() => vi.unstubAllGlobals());
describe("pattern historical workspace SPA identity", () => {
  it("remounts the actual workspace on node/round changes and return/back, preserving list context", async () => {
    const orderId = "00000000-0000-4000-8000-000000000001";
    const path = `/rework/ui/pattern-room/orders/${orderId}`;
    let location = new URL(`https://local.test${path}?returnTo=%2Fui%2Fmy-tasks%3Fpage%3D2`);
    const win = new EventTarget(), doc = new EventTarget();
    let index = 0;
    const entries = [{ href: location.href, state: {} as Record<string, unknown> }];
    const history = {
      get state() { return entries[index]!.state; },
      replaceState(state: Record<string, unknown>, _unused: string, href?: string) { location = new URL(href ?? location.href, location); entries[index] = { state, href: location.href }; },
      pushState(state: Record<string, unknown>, _unused: string, href: string) { location = new URL(href, location); entries.splice(++index); entries.push({ state, href: location.href }); },
      go(delta: number) { index += delta; location = new URL(entries[index]!.href); win.dispatchEvent(new Event("popstate")); },
    };
    vi.stubGlobal("window", { get location() { return location; }, history, scrollY: 0, scrollTo: vi.fn(), requestAnimationFrame: vi.fn(), addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win) });
    vi.stubGlobal("document", doc);
    const workspace = () => PatternRoomOrderDetailPage({ orderId });
    const original = workspace(), keys = [original.key];
    const stop = installInternalNavigation("/rework", () => { keys.push(workspace().key); });
    try {
      await navigateInternalPage(`${path}?node=pending_assignment&returnTo=%2Fui%2Fmy-tasks%3Fpage%3D2`);
      const assignmentKey = keys.at(-1);
      expect(assignmentKey).not.toBe(original.key);
      await navigateInternalPage(`${path}?node=in_progress&returnTo=%2Fui%2Fmy-tasks%3Fpage%3D2`);
      expect(keys.at(-1)).not.toBe(assignmentKey);
      await navigateInternalPage(`${path}?round=00000000-0000-4000-8000-000000000002&node=in_progress&returnTo=%2Fui%2Fmy-tasks%3Fpage%3D2`);
      const priorRoundKey = keys.at(-1);
      expect(priorRoundKey).not.toBe(keys.at(-2));
      await navigateInternalPage(`${path}?returnTo=%2Fui%2Fmy-tasks%3Fpage%3D2`);
      expect(keys.at(-1)).toBe(original.key);
      history.go(-1);
      await vi.waitFor(() => expect(keys.at(-1)).toBe(priorRoundKey));
      expect(location.searchParams.get("returnTo")).toBe("/ui/my-tasks?page=2");
      expect(workspace().type).toBe(original.type);
    } finally { stop(); }
  });
});
