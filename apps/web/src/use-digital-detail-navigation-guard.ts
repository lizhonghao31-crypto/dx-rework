import { useEffect, useRef, type RefObject } from "react";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";

/** Protect query navigation and browser history as well as the detail's Return button. */
export function useDigitalDetailNavigationGuard(dirty: boolean, busy: boolean, writing: RefObject<boolean>, message: string) {
  const current = useRef({ dirty, busy, message });
  current.current = { dirty, busy, message };
  useEffect(() => {
    const blocked = () => current.current.busy || writing.current;
    const unregister = registerInternalNavigationGuard(async () => {
      if (blocked()) return false;
      if (!current.current.dirty) return true;
      const leave = await confirmInApp(current.current.message);
      // Autosave can start while the confirmation is open; do not abandon an in-flight write.
      return leave && !blocked();
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!current.current.dirty && !blocked()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { unregister(); window.removeEventListener("beforeunload", beforeUnload); };
  }, [writing]);
}
