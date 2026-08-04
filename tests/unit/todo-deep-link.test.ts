import { describe, expect, it } from "vitest";

import { buildTodoDeepLink } from "../../apps/api/src/todos/deep-link.js";

const todoId = "00000000-0000-4000-8000-000000000013";
const entityId = "00000000-0000-4000-8000-000000000014";

describe("todo deep links", () => {
  it("builds only known internal routes under the configured base path", () => {
    expect(buildTodoDeepLink("/pilot/", {
      routeName: "process_configuration",
      entityId,
      todoId,
    })).toBe(`/pilot/ui/process-configuration?todo=${todoId}&rework=${entityId}`);
    expect(buildTodoDeepLink("/", {
      routeName: "external_responsibility_detail",
      entityId,
      todoId,
      tab: "external_responsibility",
    })).toBe(`/ui/tasks/${entityId}?todo=${todoId}&tab=external_responsibility`);
    expect(buildTodoDeepLink("/", {
      routeName: "wage_period_detail",
      entityId,
      todoId,
    })).toBe(`/ui/wages/${entityId}?todo=${todoId}`);
  });

  it("rejects an unsafe deployment base path instead of accepting an arbitrary URL", () => {
    expect(() => buildTodoDeepLink("https://example.test/", {
      routeName: "rework_detail",
      entityId,
      todoId,
    })).toThrow("Application base path is invalid");
  });
});
