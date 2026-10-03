import { describe, expect, it } from "vitest";
import { workerPeopleConfiguration } from "../../scripts/acceptance/worker-people-maintenance.js";

describe("personnel-only Acceptance CLI guards", () => {
  const env = { NODE_ENV: "test", ACCEPTANCE_LAB_ENABLED: "true", DINGTALK_CORP_ID: "corp-acceptance",
    ACCEPTANCE_DATABASE_URL: "postgres://localhost/dx_acceptance" };
  it("defaults to read-only and requires explicit apply", () => {
    expect(workerPeopleConfiguration(env, []).apply).toBe(false);
    expect(workerPeopleConfiguration(env, ["--check"]).apply).toBe(false);
    expect(workerPeopleConfiguration(env, ["--apply"]).apply).toBe(true);
    expect(() => workerPeopleConfiguration(env, ["--force"])).toThrow("Usage");
    expect(() => workerPeopleConfiguration(env, ["--check", "--apply"])).toThrow("Usage");
    expect(workerPeopleConfiguration(env, ["--alias=pattern-room-worker", "--expected-user-id=1494c445-fe65-4c24-95cc-72620360adb6"]).apply).toBe(false);
    expect(() => workerPeopleConfiguration(env, ["--alias=root"])).toThrow("Usage");
    expect(() => workerPeopleConfiguration(env, ["--expected-user-id=1494c445-fe65-4c24-95cc-72620360adb6"])).toThrow("Usage");
  });
  it("refuses production mode, non-Acceptance DB and DATABASE_URL fallback", () => {
    expect(() => workerPeopleConfiguration({ ...env, NODE_ENV: "production" }, [])).toThrow("NODE_ENV");
    expect(() => workerPeopleConfiguration({ ...env, ACCEPTANCE_LAB_ENABLED: "false" }, [])).toThrow("ACCEPTANCE_LAB_ENABLED");
    expect(() => workerPeopleConfiguration({ ...env, ACCEPTANCE_DATABASE_URL: "postgres://localhost/dx_production" }, [])).toThrow("refused");
    expect(() => workerPeopleConfiguration({ ...env, ACCEPTANCE_DATABASE_URL: "", DATABASE_URL: env.ACCEPTANCE_DATABASE_URL }, [])).toThrow("fallback is forbidden");
    expect(() => workerPeopleConfiguration({ ...env, DINGTALK_CORP_ID: "" }, [])).toThrow("DINGTALK_CORP_ID");
  });
});
