import { describe, expect, it } from "vitest";

import {
  indicatorMarker,
  isUnseenTodoMarker,
  readSeenTodoMarker,
  writeSeenTodoMarker,
} from "../../apps/web/src/todo-new-indicator.js";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
};

describe("todo navigation unread marker", () => {
  it("isolates seen markers by user and only advances the high-watermark", () => {
    const storage = memoryStorage();
    const newer = { todoId: "b", receivedAt: "2026-09-01T04:00:00.000Z" };
    const older = { todoId: "a", receivedAt: "2026-09-01T03:00:00.000Z" };

    writeSeenTodoMarker(storage, "user-a", newer);
    writeSeenTodoMarker(storage, "user-a", older);

    expect(readSeenTodoMarker(storage, "user-a")).toEqual(newer);
    expect(readSeenTodoMarker(storage, "user-b")).toBeNull();
    expect(isUnseenTodoMarker(older, newer)).toBe(false);
  });

  it("uses the todo id as a stable tie-breaker for equal arrival times", () => {
    const receivedAt = "2026-09-01T04:00:00.000Z";
    expect(isUnseenTodoMarker(
      { todoId: "b", receivedAt },
      { todoId: "a", receivedAt },
    )).toBe(true);
  });

  it("degrades safely when browser storage is unavailable", () => {
    const marker = { todoId: "b", receivedAt: "2026-09-01T04:00:00.000Z" };
    expect(readSeenTodoMarker(null, "user-a")).toBeNull();
    expect(() => writeSeenTodoMarker(null, "user-a", marker)).not.toThrow();
  });

  it("binds the indicator response to the authenticated actor without refetching auth", async () => {
    const source = await import("node:fs/promises")
      .then(({ readFile }) => readFile("apps/web/src/components.tsx", "utf8"));
    expect(source).toContain('response.headers.get("x-dx-rework-actor-id")');
    expect(source).toContain("responseActorId !== currentUser.id");
    expect(source).not.toContain('apiUrl("auth/me")');
  });

  it("rejects incomplete server markers", () => {
    expect(indicatorMarker({ latestTodoId: null, latestReceivedAt: null })).toBeNull();
    expect(indicatorMarker({
      latestTodoId: "00000000-0000-4000-8000-000000000013",
      latestReceivedAt: null,
    })).toBeNull();
  });
});
