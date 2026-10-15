import { createContext,useContext,useEffect, useRef, type RefObject } from "react";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";

export const DocumentGuardContext=createContext<Set<()=>Promise<boolean>>|null>(null);

/** Protect query navigation and browser history as well as the detail's Return button. */
export function useDigitalDetailNavigationGuard(dirty: boolean, busy: boolean, writing: RefObject<boolean>, message: string) {
  const local=useContext(DocumentGuardContext);
  const current = useRef({ dirty, busy, message });
  current.current = { dirty, busy, message };
  useEffect(() => {
    const blocked = () => current.current.busy || writing.current;
    const guard=async () => {
      if (blocked()) return false;
      if (!current.current.dirty) return true;
      const leave = await confirmInApp(current.current.message);
      // Autosave can start while the confirmation is open; do not abandon an in-flight write.
      return leave && !blocked();
    };
    const unregister=registerInternalNavigationGuard(guard);
    local?.add(guard);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!current.current.dirty && !blocked()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { unregister();local?.delete(guard); window.removeEventListener("beforeunload", beforeUnload); };
  }, [writing,local]);
}
