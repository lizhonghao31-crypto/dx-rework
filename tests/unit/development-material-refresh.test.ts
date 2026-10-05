import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ dependencies: [] as (unknown[] | undefined)[], effects: [] as (() => void)[], states: [] as unknown[], refs: [] as {current: unknown}[], refIndex: 0, effectIndex: 0, cleanups: [] as ((() => void) | undefined)[] }));
vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState: (initial: unknown) => [initial, (value: unknown) => harness.states.push(value)],
  useRef: (value: unknown) => harness.refs[harness.refIndex++] ??= { current: value },
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const effectIndex = harness.effectIndex++;
    const previous = harness.dependencies[effectIndex];
    if (!previous || dependencies.some((value, index) => value !== previous[index])) harness.effects.push(() => { harness.cleanups[effectIndex]?.(); harness.cleanups[effectIndex] = effect() || undefined; });
    harness.dependencies[effectIndex] = dependencies;
  },
}));
vi.mock("../../apps/web/src/digital-production-api.js", () => ({ digitalRequest: vi.fn() }));
import { digitalRequest } from "../../apps/web/src/digital-production-api.js";
import { DevelopmentExecutionPanel } from "../../apps/web/src/digital-development-execution-panel.js";

beforeEach(() => { harness.dependencies = []; harness.effects = []; harness.states = []; harness.refs = []; harness.refIndex = 0; harness.effectIndex = 0; harness.cleanups = []; vi.mocked(digitalRequest).mockReset(); });
describe("material events refresh current execution conditions", () => {
  it("reloads after substitution without remounting and does not reload for unchanged events", async () => {
    vi.mocked(digitalRequest).mockResolvedValueOnce({ sheet: { canEdit: false }, tasks: [{ state: "pending" }] })
      .mockResolvedValueOnce({ sheet: { canEdit: false }, tasks: [{ state: "ready" }] });
    const render = async (materialRevision: number) => {
      harness.refIndex = 0;
      harness.effectIndex = 0;
      DevelopmentExecutionPanel({ sourceId: "test-source", materialRevision });
      harness.effects.splice(0).forEach(effect => effect());
      await Promise.resolve(); await Promise.resolve();
    };
    await render(1); await render(1);
    expect(digitalRequest).toHaveBeenCalledTimes(1);
    await render(2);
    expect(digitalRequest).toHaveBeenCalledTimes(2);
    expect(digitalRequest).toHaveBeenLastCalledWith("sources/test-source/execution");
    expect(harness.states.filter(value => typeof value === "object" && value && "tasks" in value).at(-1)).toMatchObject({ tasks: [{ state: "ready" }] });
  });
});

const renderRevision = async (materialRevision: number) => {
  harness.refIndex = 0;
  harness.effectIndex = 0;
  DevelopmentExecutionPanel({ sourceId: "test-source", materialRevision });
  harness.effects.splice(0).forEach(effect => effect());
  await Promise.resolve(); await Promise.resolve();
};
describe("execution and candidate loading boundaries", () => {
  it("publishes execution facts even when candidates fail", async () => {
    const snapshot = { sheet: { canEdit: false }, canDispatch: true, tasks: [{ state: "ready" }] };
    vi.mocked(digitalRequest).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("candidate failure"));
    await renderRevision(1);
    expect(harness.states).toContain(snapshot);
    expect(harness.states).toContain("candidate failure");
    expect(harness.states).not.toContain("test-source:0");
  });
  it("ignores an older execution response after a newer material refresh", async () => {
    let release!: (value: unknown) => void;
    const old = { sheet: { canEdit: false }, tasks: [{ state: "pending" }] };
    const fresh = { sheet: { canEdit: false }, tasks: [{ state: "ready" }] };
    vi.mocked(digitalRequest).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(fresh);
    await renderRevision(1); await renderRevision(2);
    release(old); await Promise.resolve(); await Promise.resolve();
    expect(harness.states).toContain(fresh);
    expect(harness.states).not.toContain(old);
  });
  it("does not replace newer candidates with a slow older candidate list", async () => {
    let release!: (value: unknown) => void;
    const old = { sheet: { canEdit: false }, canDispatch: true, dispatch: { version: 1 } };
    const fresh = { sheet: { canEdit: false }, canDispatch: true, dispatch: { version: 2 } };
    const oldPeople = [{ id: "old-worker" }], freshPeople = [{ id: "new-worker" }];
    vi.mocked(digitalRequest).mockResolvedValueOnce(old)
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(fresh).mockResolvedValueOnce(freshPeople);
    await renderRevision(1); await renderRevision(2);
    release(oldPeople); await Promise.resolve(); await Promise.resolve();
    expect(harness.states).toContain(freshPeople);
    expect(harness.states).not.toContain(oldPeople);
    expect(harness.states.filter(value => value === old || value === fresh)).toEqual([old, fresh]);
  });
});
