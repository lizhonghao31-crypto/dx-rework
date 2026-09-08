import { describe, expect, it, vi } from "vitest";

import { assertAcceptanceServerDatabase } from "../../apps/api/src/auth/acceptance-server-guard.js";

const cleanAcceptanceEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ACCEPTANCE_LAB_ENABLED: "true",
});

describe("acceptance API startup database guard", () => {
  it("accepts only when the database is isolated and external side effects are disabled", async () => {
    const query = vi.fn(async () => ({ rows: [{ current_database: "dx_rework_acceptance" }] }));
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      cleanAcceptanceEnvironment(),
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith("SELECT current_database()");
  });

  it("rejects before querying when the configured URL targets a normal database", async () => {
    const query = vi.fn();
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework",
      { query } as never,
      cleanAcceptanceEnvironment(),
    )).rejects.toThrow(/configured database dx_rework/);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects when the connected database identity does not match the isolation naming rule", async () => {
    const query = vi.fn(async () => ({ rows: [{ current_database: "dx_rework" }] }));
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_test",
      { query } as never,
      cleanAcceptanceEnvironment(),
    )).rejects.toThrow(/connected database dx_rework/);
  });

  it.each([
    ["OSS_BUCKET", "dx-rework-production"],
    ["OSS_ACCESS_KEY_ID", "production-key"],
    ["OPENAI_API_KEY", "production-openai-key"],
  ])("fails closed before touching the database when %s is inherited", async (key, value) => {
    const query = vi.fn();
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      { ...cleanAcceptanceEnvironment(), [key]: value },
    )).rejects.toThrow(/external side-effect configuration/);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects real DingTalk todo delivery even when the acceptance database is isolated", async () => {
    const query = vi.fn();
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      { ...cleanAcceptanceEnvironment(), TODO_DELIVERY_ENABLED: "true" },
    )).rejects.toThrow(/TODO_DELIVERY_ENABLED/);
    expect(query).not.toHaveBeenCalled();
  });
});
