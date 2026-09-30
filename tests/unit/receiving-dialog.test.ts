import { createElement } from "react";
import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  setup: undefined as undefined | (() => void | (() => void)),
  dialog: { showModal: vi.fn(), close: vi.fn() },
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof ReactModule>(),
  useRef: () => ({ current: lifecycle.dialog }),
  useEffect: (setup: () => void | (() => void)) => { lifecycle.setup = setup; },
}));
import { ReceivingDialog } from "../../apps/web/src/receiving-dialog.js";

describe("receiving dialog cancellation", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([false, true])("Escape never submits and closes only when not busy (%s)", busy => {
    const onClose = vi.fn();
    const submit = vi.fn();
    const children = createElement("form", { onSubmit: submit }, createElement("input", { defaultValue: "180" }));
    const dialog = ReceivingDialog({ title: "录入装箱数量", busy, onClose, children });
    const event = { preventDefault: vi.fn() };
    dialog.props.onCancel(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(busy ? 0 : 1);
    expect(submit).not.toHaveBeenCalled();
    expect(dialog.props.children).toBe(children);
  });
  it("opens in the native modal layer and restores the prior scroll lock on unmount", () => {
    vi.stubGlobal("document", { body: { style: { overflow: "auto" } } });
    try {
      ReceivingDialog({ title: "处理凭证", onClose: vi.fn(), children: null });
      const cleanup = lifecycle.setup!();
      expect(lifecycle.dialog.showModal).toHaveBeenCalledOnce();
      expect(document.body.style.overflow).toBe("hidden");
      cleanup?.();
      expect(lifecycle.dialog.close).toHaveBeenCalledOnce();
      expect(document.body.style.overflow).toBe("auto");
    } finally { vi.unstubAllGlobals(); }
  });
});
