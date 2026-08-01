import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "@dx-rework/config";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/dx_rework_test",
  DINGTALK_CORP_ID: "corp-test",
  DINGTALK_H5_APP_KEY: "app-key-test",
  DINGTALK_H5_APP_SECRET: "app-secret-test",
  DINGTALK_WEB_CLIENT_ID: "qr-client-test",
  DINGTALK_WEB_CLIENT_SECRET: "web-client-secret-test",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/auth/qr/callback",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
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

  it("rejects placeholder credentials in production", () => {
    expect(() => loadConfig({ ...validEnvironment, NODE_ENV: "production", GIT_SHA: "a".repeat(40), BUILD_TIME: "2026-08-01T00:00:00Z", DINGTALK_H5_APP_KEY: "replace_with_key" })).toThrow(/placeholder/);
  });

  it.each(["//example.com", "/rework//admin", "/rework?next=/"])("rejects unsafe application base path %s", (appBasePath) => {
    expect(() => loadConfig({ ...validEnvironment, APP_BASE_PATH: appBasePath })).toThrow(ConfigurationError);
  });
});
