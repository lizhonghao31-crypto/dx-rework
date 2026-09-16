import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolated effect harness: flush passive effects explicitly, including abort cleanup.
const hooks = vi.hoisted(() => ({ value: null as unknown, deps: [] as unknown[], pending: undefined as (() => void | (() => void)) | undefined, cleanup: undefined as (() => void) | undefined, request: vi.fn() }));
vi.mock("react", () => ({
  useState: () => [hooks.value, (value: unknown) => { hooks.value = value; }],
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    if (deps.some((value, index) => value !== hooks.deps[index])) { hooks.deps = deps; hooks.pending = effect; }
  },
}));
vi.mock("../../apps/web/src/pattern-order-client.js", () => ({ patternRequest: hooks.request }));
import { usePatternQuote } from "../../apps/web/src/use-pattern-quote.js";

function flushEffects() { hooks.cleanup?.(); hooks.cleanup = hooks.pending?.() ?? undefined; hooks.pending = undefined; }
const quote = { priceId: "test", name: "测试", unit: "件", amount: "15.000", version: 1 };
beforeEach(() => { hooks.cleanup?.(); hooks.value = null; hooks.deps = []; hooks.pending = undefined; hooks.cleanup = undefined; hooks.request.mockReset(); });

describe("pattern quote lifecycle", () => {
  it("does not resurrect a cached ready quote after A → empty → A", async () => {
    hooks.request.mockResolvedValue(quote);
    expect(usePatternQuote("A", 0).status).toBe("loading"); flushEffects();
    await Promise.resolve();
    expect(usePatternQuote("A", 0).status).toBe("ready");
    expect(usePatternQuote(null, 0).status).toBe("idle"); flushEffects();
    // Before A's new effect runs, the form must still disable submission.
    expect(usePatternQuote("A", 0)).toEqual({ status: "loading", quote: null });
    flushEffects(); await Promise.resolve();
    expect(usePatternQuote("A", 0).status).toBe("ready");
  });
  it("ignores a late response after clearing and invalidates ready data on refresh", async () => {
    let resolve!: (value: typeof quote) => void;
    hooks.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    usePatternQuote("A", 0); flushEffects();
    const signal = hooks.request.mock.calls[0]![2].signal as AbortSignal;
    usePatternQuote(null, 0); flushEffects();
    expect(signal.aborted).toBe(true);
    resolve(quote); await Promise.resolve();
    expect(hooks.value).toBeNull();
    hooks.request.mockResolvedValue(quote);
    usePatternQuote("A", 0); flushEffects(); await Promise.resolve();
    expect(usePatternQuote("A", 1)).toEqual({ status: "loading", quote: null });
  });
});
