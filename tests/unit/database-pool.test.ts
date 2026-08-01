import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { registerDatabasePoolErrorHandler } from "../../apps/api/src/platform/database.js";

describe("database pool error handling", () => {
  it("handles an idle-client error without leaving an unhandled error event", () => {
    const database = new EventEmitter();
    const error = vi.fn();
    const failure = new Error("idle connection dropped");

    registerDatabasePoolErrorHandler(database, { error });

    expect(database.listenerCount("error")).toBe(1);
    expect(database.emit("error", failure)).toBe(true);
    expect(error).toHaveBeenCalledWith({ err: failure }, "idle database client error");
  });
});
