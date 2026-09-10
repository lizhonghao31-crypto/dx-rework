type LeaveGuard = () => Promise<boolean>;
const guards = new Set<LeaveGuard>();
let asking = false;
const POSITION = "dxInternalNavigationPosition";

export function registerInternalNavigationGuard(guard: LeaveGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export async function canLeaveInternalPage(): Promise<boolean> {
  if (asking) return false;
  asking = true;
  try {
    for (const guard of guards) if (!await guard()) return false;
    return true;
  } finally { asking = false; }
}

export function navigationRollbackDelta(current: unknown, target: unknown): number | null {
  return typeof current === "number" && typeof target === "number"
    && Number.isSafeInteger(current) && Number.isSafeInteger(target) && current !== target
    ? current - target : null;
}

/** Shared by App and the offline navigation regression fixture. */
export function installInternalNavigation(basePath: string, sync: () => void): () => void {
  let current = { href: window.location.href, state: window.history.state };
  let position = Number.isSafeInteger(current.state?.[POSITION]) ? Number(current.state[POSITION]) : 0;
  window.history.replaceState({ ...current.state, [POSITION]: position }, "");
  current = { href: window.location.href, state: window.history.state };
  let generation = 0;
  let restoring = false;
  const remember = () => {
    current = { href: window.location.href, state: window.history.state };
    position = Number.isSafeInteger(current.state?.[POSITION]) ? Number(current.state[POSITION]) : position;
    sync();
  };
  const pop = async () => {
    if (restoring && window.location.href === current.href) { restoring = false; return; }
    if (window.location.href === current.href) { remember(); return; }
    const attempt = ++generation;
    const target = { href: window.location.href, state: window.history.state };
    if (guards.size && !await canLeaveInternalPage()) {
      if (attempt !== generation) return;
      const delta = navigationRollbackDelta(current.state?.[POSITION], target.state?.[POSITION]);
      if (delta !== null) { restoring = true; window.history.go(delta); }
      else {
        // Entries created outside this router have no index. Preserve the draft
        // and current URL rather than guessing a traversal distance.
        window.history.pushState(current.state, "", current.href);
      }
      return;
    }
    if (attempt !== generation) return;
    remember();
  };
  const navigate = async (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const relativePath = basePath !== "" && url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || "/" : url.pathname;
    if (!(relativePath === "/" || relativePath.startsWith("/ui/") || relativePath.startsWith("/system/") || relativePath.startsWith("/auth/"))) return;
    event.preventDefault();
    if (guards.size && !await canLeaveInternalPage()) return;
    ++generation;
    position += 1;
    const sourcePath = basePath && window.location.pathname.startsWith(basePath) ? window.location.pathname.slice(basePath.length) : window.location.pathname;
    const returnTo = /^\/ui\/(tasks|my-tasks|responsibility)\/[^/]+$/.test(relativePath)
      ? { dxReworkReturnTo: /^\/ui\/(tasks|my-tasks|responsibility)\/[^/]+$/.test(sourcePath)
          ? window.history.state?.dxReworkReturnTo : `${sourcePath}${window.location.search}${window.location.hash}` } : {};
    window.history.pushState({ [POSITION]: position, ...returnTo }, "", `${url.pathname}${url.search}${url.hash}`);
    remember();
    if (url.hash) window.requestAnimationFrame(() => document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: "start" }));
    else window.scrollTo({ top: 0, left: 0 });
  };
  window.addEventListener("popstate", pop);
  document.addEventListener("click", navigate);
  return () => { ++generation; window.removeEventListener("popstate", pop); document.removeEventListener("click", navigate); };
}
