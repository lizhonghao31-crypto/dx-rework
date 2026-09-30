import { useEffect, useRef, useState } from "react";

import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";

export function useCuttingDraftGuard(signature: string, enabled: boolean) {
  const state = useRef({ signature, baseline: signature, enabled });
  state.current.signature = signature;
  state.current.enabled = enabled;
  const [baseline] = useState(() => ({ value: signature }));
  const dirty = enabled && signature !== baseline.value;

  useEffect(() => {
    const requestLeave = async () => {
      if (!state.current.enabled || state.current.signature === baseline.value) return true;
      const leave = await confirmInApp(
        "有未保存的裁床数量，确定放弃这些修改？",
        {
          title: "未保存修改",
          confirmLabel: "放弃修改",
          cancelLabel: "继续编辑",
        },
      );
      if (leave) baseline.value = state.current.signature;
      return leave;
    };
    const unregister = registerInternalNavigationGuard(requestLeave);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.current.enabled || state.current.signature === baseline.value) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [baseline]);

  return {
    dirty,
    markSaved: () => {
      baseline.value = state.current.signature;
      state.current.enabled = false;
    },
  };
}
