import { describe, expect, it } from "vitest";

import {
  buildTodoDeepLink,
  buildTodoExternalDeepLink,
} from "../../apps/api/src/todos/deep-link.js";

const todoId = "00000000-0000-4000-8000-000000000013";
const entityId = "00000000-0000-4000-8000-000000000014";

describe("todo deep links", () => {
  it("builds only known internal routes under the configured base path", () => {
    expect(buildTodoDeepLink("/pilot/", {
      routeName: "process_configuration",
      entityId,
      todoId,
    })).toBe(`/pilot/ui/my-tasks/${todoId}?todo=${todoId}`);
    expect(buildTodoDeepLink("/", {
      routeName: "external_responsibility_detail",
      entityId,
      reworkOrderId: "00000000-0000-4000-8000-000000000016",
      todoId,
      tab: "external_responsibility",
    })).toBe(`/ui/tasks/00000000-0000-4000-8000-000000000016?todo=${todoId}&tab=external_responsibility`);
    expect(buildTodoDeepLink("/", {
      routeName: "wage_period_detail",
      entityId,
      todoId,
    })).toBe(`/ui/wages/${entityId}?todo=${todoId}`);
    expect(buildTodoDeepLink("/", {
      routeName: "sourcing_detail",
      entityId,
      todoId,
    })).toBe(`/ui/sourcing/orders/${entityId}?todo=${todoId}`);
  });

  it("opens whole-order review todos directly in the N05 workspace", () => {
    expect(buildTodoDeepLink("/", {
      routeName: "whole_order_review",
      entityId,
      reworkOrderId: "00000000-0000-4000-8000-000000000017",
      todoId,
    })).toBe(`/ui/work-reporting?todo=${todoId}&rework=00000000-0000-4000-8000-000000000017`);
  });

  it("builds the complete HTTPS address required by DingTalk clients", () => {
    expect(buildTodoExternalDeepLink("https://staging.example/rework/", {
      routeName: "rework_detail",
      entityId,
      todoId,
    })).toBe(
      `https://staging.example/rework/ui/tasks/${entityId}?todo=${todoId}`,
    );
    expect(() => buildTodoExternalDeepLink("http://staging.example/rework/", {
      routeName: "rework_detail",
      entityId,
      todoId,
    })).toThrow("must be a clean HTTPS URL");
  });

  it("rejects an unsafe deployment base path instead of accepting an arbitrary URL", () => {
    expect(() => buildTodoDeepLink("https://example.test/", {
      routeName: "rework_detail",
      entityId,
      todoId,
    })).toThrow("Application base path is invalid");
  });
});

