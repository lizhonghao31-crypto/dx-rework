import { describe, expect, it, vi } from "vitest";

import { assertAcceptanceServerDatabase } from "../../apps/api/src/auth/acceptance-server-guard.js";

describe("acceptance API startup database guard", () => {
  it("accepts only when both configured and connected database names are explicitly isolated", async () => {
    const query = vi.fn(async () => ({ rows: [{ current_database: "dx_rework_acceptance" }] }));
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith("SELECT current_database()");
  });

  it("rejects before querying when the configured URL targets a normal database", async () => {
    const query = vi.fn();
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework",
      { query } as never,
    )).rejects.toThrow(/configured database dx_rework/);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects when the connected database identity does not match the isolation naming rule", async () => {
    const query = vi.fn(async () => ({ rows: [{ current_database: "dx_rework" }] }));
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_test",
      { query } as never,
    )).rejects.toThrow(/connected database dx_rework/);
  });
});
