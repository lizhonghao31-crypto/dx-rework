import { describe, expect, it, vi } from "vitest";

import { assertAcceptanceServerDatabase } from "../../apps/api/src/auth/acceptance-server-guard.js";

const cleanAcceptanceEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ACCEPTANCE_LAB_ENABLED: "true",
  DINGTALK_CORP_ID: "corp-acceptance",
  ROOT_DINGTALK_USER_ID: "uat-root",
});

const cleanAcceptanceQuery = () => vi.fn(async (sql: string) => {
  if (sql === "SELECT current_database()") {
    return { rows: [{ current_database: "dx_rework_acceptance" }] };
  }
  if (sql.includes("FROM owner_bootstrap_consumptions b")) {
    return {
      rows: [{
        user_id: "00000000-0000-4000-8000-000000000001",
        provider_user_id: "uat-root",
        corp_id: "corp-acceptance",
        identity_matches: true,
        has_owner_role: true,
      }],
    };
  }
  throw new Error(`unexpected query: ${sql}`);
});

describe("acceptance API startup database guard", () => {
  it("accepts only when the database and Root bootstrap are isolated and external side effects are disabled", async () => {
    const query = cleanAcceptanceQuery();
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      cleanAcceptanceEnvironment(),
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
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

  it("rejects before touching the database unless acceptance Root is pinned to uat-root", async () => {
    const query = vi.fn();
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      { ...cleanAcceptanceEnvironment(), ROOT_DINGTALK_USER_ID: "uat-worker-a" },
    )).rejects.toThrow(/ROOT_DINGTALK_USER_ID=uat-root/);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a reused acceptance database whose immutable bootstrap is not bound to uat-root", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "SELECT current_database()") return { rows: [{ current_database: "dx_rework_acceptance" }] };
      if (sql.includes("FROM owner_bootstrap_consumptions b")) {
        return {
          rows: [{
            user_id: "00000000-0000-4000-8000-000000000099",
            provider_user_id: "uat-worker-a",
            corp_id: "corp-acceptance",
            identity_matches: true,
            has_owner_role: true,
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      cleanAcceptanceEnvironment(),
    )).rejects.toThrow(/Root bootstrap/);
  });

  it("rejects a bootstrap that has lost its owner role or identity binding", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "SELECT current_database()") return { rows: [{ current_database: "dx_rework_acceptance" }] };
      if (sql.includes("FROM owner_bootstrap_consumptions b")) {
        return {
          rows: [{
            user_id: "00000000-0000-4000-8000-000000000001",
            provider_user_id: "uat-root",
            corp_id: "corp-acceptance",
            identity_matches: true,
            has_owner_role: false,
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(assertAcceptanceServerDatabase(
      "postgresql://user:pass@127.0.0.1:5432/dx_rework_acceptance",
      { query } as never,
      cleanAcceptanceEnvironment(),
    )).rejects.toThrow(/Root bootstrap/);
  });
});
