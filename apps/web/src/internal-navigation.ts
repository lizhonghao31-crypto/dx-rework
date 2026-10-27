import { preparePatternNavigation } from "./pattern-navigation.js";

type LeaveGuard = () => Promise<boolean>;
const guards = new Set<LeaveGuard>();
let asking = false;
const POSITION = "dxInternalNavigationPosition";
type NavigateOptions = { replace?: boolean };
let activeNavigate: ((href: string, options?: NavigateOptions) => Promise<boolean>) | undefined;

export async function navigateInternalPage(href: string, options?: NavigateOptions): Promise<boolean> {
  if (activeNavigate) return activeNavigate(href, options);
  if (!await canLeaveInternalPage()) return false;
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin) return false;
  if (options?.replace) window.location.replace(target.href); else window.location.assign(target.href);
  return true;
}

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
  const appPath = (pathname: string) => basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`)) ? pathname.slice(basePath.length) || "/" : pathname;
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
  // Filters, chapters and versions intentionally replace the current entry
  // without remounting its editor. Track that URL for a later cancelled pop.
  const originalReplace=window.history.replaceState;
  const replace:History['replaceState']=function(this:History,...args){
    originalReplace.apply(this,args);
    if(this===window.history){
      current={href:window.location.href,state:window.history.state};
      position=Number.isSafeInteger(current.state?.[POSITION])?Number(current.state[POSITION]):position;
    }
  };
  window.history.replaceState=replace;
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
  const go = async (href: string, options: NavigateOptions = {}) => {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return false;
    const relativePath = appPath(url.pathname);
    if (!(relativePath === "/" || relativePath.startsWith("/ui/") || relativePath.startsWith("/system/") || relativePath.startsWith("/auth/"))) return false;
    const attempt = generation;
    if (guards.size && !await canLeaveInternalPage()) return false;
    if (attempt !== generation) return false;
    ++generation;
    const sourcePath = appPath(window.location.pathname);
    const pattern = preparePatternNavigation(`${sourcePath}${window.location.search}`, `${relativePath}${url.search}${url.hash}`, window.history.state?.dxPatternOrigin, window.scrollY);
    const destination = new URL(`${basePath}${pattern.target}`, window.location.origin);
    const sourceScroll = { path: `${window.location.pathname}${window.location.search}`, top: window.scrollY };
    window.history.replaceState({ ...window.history.state, dxInternalRestoreScroll: sourceScroll }, "");
    if (!options.replace) position += 1;
    const returnTo = /^\/ui\/(tasks|my-tasks|responsibility)\/[^/]+$/.test(relativePath)
      ? { dxReworkReturnTo: /^\/ui\/(tasks|my-tasks|responsibility)\/[^/]+$/.test(sourcePath)
          ? window.history.state?.dxReworkReturnTo : `${sourcePath}${window.location.search}${window.location.hash}` } : {};
    const todoQueryUser = window.history.state?.dxTodoQueryUser;
    const state = { [POSITION]: position, ...returnTo,
      ...(pattern.origin ? { dxPatternOrigin: pattern.origin } : {}),
      ...(pattern.restoreTop !== undefined ? { dxInternalRestoreScroll: { path: `${destination.pathname}${destination.search}`, top: pattern.restoreTop } } : {}),
      ...(typeof todoQueryUser === "string" ? { dxTodoQueryUser: todoQueryUser } : {}) };
    window.history[options.replace ? "replaceState" : "pushState"](state, "", `${destination.pathname}${destination.search}${destination.hash}`);
    remember();
    if (url.hash) window.requestAnimationFrame(() => document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: "start" }));
    else window.scrollTo({ top: 0, left: 0 });
    return true;
  };
  activeNavigate = go;
  const navigate = async (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const relativePath = appPath(url.pathname);
    if (!(relativePath === "/" || relativePath.startsWith("/ui/") || relativePath.startsWith("/system/") || relativePath.startsWith("/auth/"))) return;
    event.preventDefault();
    await go(url.href);
  };
  window.addEventListener("popstate", pop);
  document.addEventListener("click", navigate);
  return () => { ++generation; if (activeNavigate === go) activeNavigate = undefined; if(window.history.replaceState===replace)window.history.replaceState=originalReplace; window.removeEventListener("popstate", pop); document.removeEventListener("click", navigate); };
}
