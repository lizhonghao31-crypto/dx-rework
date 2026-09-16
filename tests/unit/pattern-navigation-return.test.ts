import { afterEach, describe, expect, it, vi } from "vitest";
import { installInternalNavigation, navigateInternalPage, registerInternalNavigationGuard } from "../../apps/web/src/internal-navigation.js";
import { patternReturnPath } from "../../apps/web/src/pattern-order-query.js";
import { preparePatternNavigation } from "../../apps/web/src/pattern-navigation.js";

const board = "/ui/pattern-room/orders?q=TEST&kind=misc&page=3";
const detail = "/ui/pattern-room/orders/00000000-0000-4000-8000-000000000001";
afterEach(() => vi.unstubAllGlobals());

describe("pattern return context", () => {
  it.each([board, "/ui/my-tasks?q=TEST&module=pattern_room&page=2", "/ui/wages?from=2026-09-01&to=2026-09-16&wageSource=pattern_room&page=2", "/ui/pattern-room/prices"])("preserves the allowlisted origin %s", source => {
    const created = preparePatternNavigation(source, "/ui/pattern-room/create?kind=misc", null, 630);
    expect(patternReturnPath(new URL(created.target, "https://local.test").search)).toBe(source);
    const saved = preparePatternNavigation(created.target, detail, created.origin, 50);
    expect(saved.origin).toEqual({ path: source, top: 630 });
    expect(preparePatternNavigation(saved.target, source, saved.origin, 0).restoreTop).toBe(630);
  });
  it("rejects external, traversal and nested create origins without losing round links", () => {
    for (const returnTo of ["https://evil.test", "//evil.test", "/ui/pattern-room/orders/../admin", "/ui/pattern-room/orders\\evil"]) {
      const result = preparePatternNavigation("/ui/admin", `${detail}?${new URLSearchParams({ returnTo, round: "test" })}`, null, 0);
      expect(result.origin?.path).toBe("/ui/pattern-room/orders");
      expect(new URL(result.target, "https://local.test").searchParams.get("round")).toBe("test");
    }
    expect(patternReturnPath(`?${new URLSearchParams({ returnTo: "/ui/pattern-room/create" })}`)).toBe("/ui/pattern-room/orders");
  });
  it("uses SPA navigation, replaces the submitted form, preserves history ownership and restores a return position", async () => {
    const win = new EventTarget(), doc = new EventTarget();
    let location = new URL(`https://local.test/rework${board}`), index = 0;
    const entries = [{ href: location.href, state: { dxTodoQueryUser: "test-user" } as Record<string, unknown> }];
    const history = {
      get state() { return entries[index]!.state; },
      replaceState(state: Record<string, unknown>, _unused: string, href?: string) { location = new URL(href ?? location.href, location); entries[index] = { state, href: location.href }; },
      pushState(state: Record<string, unknown>, _unused: string, href: string) { location = new URL(href, location); entries.splice(++index); entries.push({ state, href: location.href }); },
      go(delta: number) { index += delta; location = new URL(entries[index]!.href); win.dispatchEvent(new Event("popstate")); },
    };
    const fakeWindow = { get location() { return location; }, history, scrollY: 630,
      scrollTo: vi.fn(), requestAnimationFrame: vi.fn(), addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win) };
    vi.stubGlobal("window", fakeWindow); vi.stubGlobal("document", doc);
    const sync = vi.fn(), stop = installInternalNavigation("/rework", sync);
    try {
      const removeGuard = registerInternalNavigationGuard(async () => false);
      expect(await navigateInternalPage("/rework/ui/pattern-room/create")).toBe(false);
      expect(entries).toHaveLength(1); removeGuard();
      expect(await navigateInternalPage("https://evil.test/ui/pattern-room/create")).toBe(false);
      let decide!: (value: boolean) => void;
      const unregister = registerInternalNavigationGuard(() => new Promise<boolean>(resolve => { decide = resolve; }));
      const first = navigateInternalPage("/rework/ui/pattern-room/create");
      expect(await navigateInternalPage("/rework/ui/pattern-room/create")).toBe(false);
      decide(true);
      expect(await first).toBe(true); unregister();
      expect(entries).toHaveLength(2);
      expect(history.state.dxTodoQueryUser).toBe("test-user");
      expect(history.state.dxPatternOrigin).toEqual({ path: board, top: 630 });
      await navigateInternalPage(`/rework${detail}`, { replace: true });
      expect(entries).toHaveLength(2);
      expect(entries.some(entry => new URL(entry.href).pathname.endsWith("/create"))).toBe(false);
      expect(history.state.dxInternalNavigationPosition).toBe(1);
      await navigateInternalPage(`/rework${board}`);
      expect(history.state.dxInternalRestoreScroll).toEqual({ path: `/rework${board}`, top: 630 });
      expect(sync).toHaveBeenCalledTimes(3);
      expect(await navigateInternalPage("/rework")).toBe(true);
      expect(location.pathname).toBe("/rework/");
    } finally { stop(); }
  });
});
