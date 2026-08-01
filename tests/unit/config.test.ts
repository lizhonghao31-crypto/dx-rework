import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "@dx-rework/config";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/dx_rework_test",
};

describe("loadConfig", () => {
  it("loads typed defaults without exposing source environment", () => {
    const config = loadConfig(validEnvironment);
    expect(config.port).toBe(3201);
    expect(config.host).toBe("127.0.0.1");
    expect(config.databaseUrl).toBe(validEnvironment.DATABASE_URL);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects missing database configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(ConfigurationError);
  });

  it("rejects non-PostgreSQL database URLs", () => {
    expect(() => loadConfig({ ...validEnvironment, DATABASE_URL: "mysql://127.0.0.1/dx_rework" })).toThrow(
      /PostgreSQL URL/,
    );
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ ...validEnvironment, PORT: "70000" })).toThrow(ConfigurationError);
  });

  it("refuses an untraceable production build", () => {
    expect(() =>
      loadConfig({ ...validEnvironment, NODE_ENV: "production", GIT_SHA: "local", BUILD_TIME: "local" }),
    ).toThrow(/full 40-character Git SHA/);
  });
});
