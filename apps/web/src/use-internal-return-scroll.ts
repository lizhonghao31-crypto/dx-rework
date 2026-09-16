import { useEffect } from "react";

/** Restore only after the source list has loaded, not against an empty skeleton. */
export function useInternalReturnScroll(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const saved = window.history.state?.dxInternalRestoreScroll;
    const path = `${window.location.pathname}${window.location.search}`;
    if (!saved || saved.path !== path || typeof saved.top !== "number" || !Number.isFinite(saved.top) || saved.top < 0) return;
    const frame = window.requestAnimationFrame(() => {
      if (`${window.location.pathname}${window.location.search}` !== path) return;
      window.scrollTo({ top: saved.top, left: 0 });
      const state = { ...window.history.state };
      delete state.dxInternalRestoreScroll;
      window.history.replaceState(state, "");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);
}
