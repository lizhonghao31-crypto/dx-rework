import { patternReturnPath, validPatternReturnPath } from "./pattern-order-query.js";

type Origin = { path: string; top: number };
const isEditor = (path: string) => path === "/ui/pattern-room/create" || /^\/ui\/pattern-room\/orders\/[^/]+$/.test(path);
const scrollTop = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Only same-app, allowlisted origins; never return to an already submitted form. */
export function preparePatternNavigation(source: string, target: string, prior: unknown, top: number): { target: string; origin?: Origin; restoreTop?: number } {
  const from = new URL(source, "https://internal.invalid"), to = new URL(target, "https://internal.invalid");
  const saved = prior as Partial<Origin> | null;
  const previous = saved && typeof saved.path === "string" && validPatternReturnPath(saved.path) === saved.path
    ? { path: saved.path, top: scrollTop(saved.top) } : null;
  if (isEditor(to.pathname)) {
    const sourcePath = `${from.pathname}${from.search}`;
    const path = to.searchParams.has("returnTo") ? patternReturnPath(to.search)
      : isEditor(from.pathname) ? patternReturnPath(from.search)
      : validPatternReturnPath(sourcePath) ?? "/ui/pattern-room/orders";
    const origin = { path, top: !isEditor(from.pathname) && validPatternReturnPath(sourcePath) === path ? scrollTop(top) : previous?.path === path ? previous.top : 0 };
    to.searchParams.set("returnTo", path);
    return { target: `${to.pathname}${to.search}${to.hash}`, origin };
  }
  return { target, ...(previous && validPatternReturnPath(`${to.pathname}${to.search}`) === previous.path ? { restoreTop: previous.top } : {}) };
}
