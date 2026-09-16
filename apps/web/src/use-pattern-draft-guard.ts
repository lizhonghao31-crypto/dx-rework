import { useEffect, useRef, useState } from "react";
import { createSupplierDraftGuard } from "./supplier-draft-guard.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";

export function usePatternDraftGuard(signature: string, blocked: boolean) {
  const state = useRef({ signature, baseline: signature, blocked });
  state.current.signature = signature;
  state.current.blocked = blocked;
  const [guard] = useState(() => createSupplierDraftGuard({
    isBlocked: () => state.current.blocked,
    confirm: () => confirmInApp("有未保存的订单内容，确定放弃这些修改？", { title: "未保存修改", confirmLabel: "放弃修改", cancelLabel: "继续编辑" }),
    discard: () => { state.current.baseline = state.current.signature; },
  }));
  guard.setDirty(signature !== state.current.baseline);
  useEffect(() => {
    const unregister = registerInternalNavigationGuard(() => guard.requestLeave());
    const before = (event: BeforeUnloadEvent) => { if (guard.shouldBlock) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", before);
    return () => { unregister(); window.removeEventListener("beforeunload", before); };
  }, [guard]);
  return { requestLeave: () => guard.requestLeave(), markSaved: () => {
    state.current.baseline = state.current.signature;
    state.current.blocked = false;
    guard.markClean();
  } };
}
