import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ dependencies: undefined as unknown[] | undefined, effects: [] as (() => void)[], states: [] as unknown[] }));
vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState: (initial: unknown) => [initial, (value: unknown) => harness.states.push(value)],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    if (!harness.dependencies || dependencies.some((value, index) => value !== harness.dependencies?.[index])) harness.effects.push(effect);
    harness.dependencies = dependencies;
  },
}));
vi.mock("../../apps/web/src/digital-production-api.js", () => ({ digitalRequest: vi.fn() }));
import { digitalRequest } from "../../apps/web/src/digital-production-api.js";
import { DevelopmentExecutionPanel } from "../../apps/web/src/digital-development-execution-panel.js";

beforeEach(() => { harness.dependencies = undefined; harness.effects = []; harness.states = []; vi.mocked(digitalRequest).mockReset(); });
describe("material events refresh current execution conditions", () => {
  it("reloads after substitution without remounting and does not reload for unchanged events", async () => {
    vi.mocked(digitalRequest).mockResolvedValueOnce({ sheet: { canEdit: false }, tasks: [{ state: "pending" }] })
      .mockResolvedValueOnce({ sheet: { canEdit: false }, tasks: [{ state: "ready" }] });
    const render = async (materialRevision: number) => {
      DevelopmentExecutionPanel({ sourceId: "test-source", materialRevision });
      harness.effects.splice(0).forEach(effect => effect());
      await Promise.resolve(); await Promise.resolve();
    };
    await render(1); await render(1);
    expect(digitalRequest).toHaveBeenCalledTimes(1);
    await render(2);
    expect(digitalRequest).toHaveBeenCalledTimes(2);
    expect(digitalRequest).toHaveBeenLastCalledWith("sources/test-source/execution");
    expect(harness.states.at(-1)).toMatchObject({ tasks: [{ state: "ready" }] });
  });
});
