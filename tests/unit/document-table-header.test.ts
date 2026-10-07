import { afterEach, describe, expect, it, vi } from "vitest";
import type * as React from "react";

const hooks = vi.hoisted(() => ({ ref: null as unknown, effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock("react", async (original) => ({
  ...await original<typeof React>(),
  useRef: () => ({ current: hooks.ref }),
  useEffect: (setup: () => void | (() => void)) => { hooks.effect = setup; },
}));
import { DocumentTableScroll } from "../../apps/web/src/document-editor.js";

function environment() {
  const document = new EventTarget(), window = new EventTarget(), media = Object.assign(new EventTarget(), { matches: false });
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  const cancelAnimationFrame = vi.fn((id: number) => { frames.delete(id); });
  const observers: Array<{ changed: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  class Observer {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(public changed: () => void) { observers.push(this); }
  }
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(window, { requestAnimationFrame, cancelAnimationFrame, matchMedia: () => media }));
  vi.stubGlobal("ResizeObserver", Observer);
  return { document, window, media, frames, observers, requestAnimationFrame, flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); } };
}
function table(top: number, bottom: number, toolbarBottom = 60) {
  const styles = new Map<string, string>();
  const geometry = { top, bottom, toolbarBottom };
  const head = {
    style: { setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: (key: string) => styles.delete(key) },
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: geometry.top + Number.parseFloat(styles.get("--dx-doc-header-offset") ?? "0"), height: 36 }),
  };
  const table = { tHead: head, getBoundingClientRect: () => ({ bottom: geometry.bottom }) };
  const toolbar = { getBoundingClientRect: () => ({ bottom: geometry.toolbarBottom }) };
  hooks.ref = { querySelector: () => table, closest: () => ({ querySelector: () => toolbar }) };
  DocumentTableScroll({ children: null });
  const dispose = hooks.effect?.();
  if (!dispose) throw new Error("Table effect did not install cleanup");
  return { geometry, offset: () => Number.parseFloat(styles.get("--dx-doc-header-offset") ?? "0"), dispose };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("document table header lifecycle", () => {
  it("coalesces scroll/resize, preserves natural position, follows the toolbar and stops at its own table bottom", () => {
    const env = environment(), view = table(100, 600);
    env.document.dispatchEvent(new Event("scroll")); env.window.dispatchEvent(new Event("resize")); env.observers[0]!.changed();
    expect(env.frames.size).toBe(1); env.flush(); expect(view.offset()).toBe(0);
    view.geometry.top = -500; view.geometry.bottom = 100;
    env.document.dispatchEvent(new Event("scroll")); env.flush(); expect(view.offset()).toBe(560);
    view.geometry.toolbarBottom = 90; env.observers[0]!.changed(); env.flush(); expect(view.offset()).toBe(564);
    view.dispose();
  });
  it("keeps each table independent and releases observers, frames and listeners on unmount", () => {
    const env = environment(), first = table(-500, 100), second = table(1000, 1600);
    env.flush(); expect(first.offset()).toBe(560); expect(second.offset()).toBe(0);
    env.document.dispatchEvent(new Event("scroll")); expect(env.frames.size).toBe(2);
    first.dispose(); expect(env.frames.size).toBe(1); expect(first.offset()).toBe(0);
    expect(env.observers[0]!.disconnect).toHaveBeenCalledOnce();
    env.flush(); env.requestAnimationFrame.mockClear();
    env.document.dispatchEvent(new Event("scroll")); expect(env.requestAnimationFrame).toHaveBeenCalledOnce();
    second.dispose(); expect(env.frames.size).toBe(0);
    env.requestAnimationFrame.mockClear(); env.document.dispatchEvent(new Event("scroll")); env.window.dispatchEvent(new Event("resize"));
    expect(env.requestAnimationFrame).not.toHaveBeenCalled(); expect(env.observers[1]!.disconnect).toHaveBeenCalledOnce();
  });
  it("removes runtime positioning during print, suppresses scheduling and recalculates after print", () => {
    const env = environment(), view = table(-500, 200);
    env.flush(); expect(view.offset()).toBe(560);
    env.document.dispatchEvent(new Event("scroll")); env.window.dispatchEvent(new Event("beforeprint"));
    expect(env.frames.size).toBe(0); expect(view.offset()).toBe(0);
    env.document.dispatchEvent(new Event("scroll")); env.observers[0]!.changed(); expect(env.frames.size).toBe(0);
    env.window.dispatchEvent(new Event("afterprint")); env.flush(); expect(view.offset()).toBe(560);
    env.media.matches = true; env.media.dispatchEvent(new Event("change")); expect(view.offset()).toBe(0);
    env.media.matches = false; env.media.dispatchEvent(new Event("change")); env.flush(); expect(view.offset()).toBe(560);
    view.dispose(); env.requestAnimationFrame.mockClear(); env.window.dispatchEvent(new Event("afterprint"));
    expect(env.requestAnimationFrame).not.toHaveBeenCalled();
  });
});
