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
  it("allows at most 30 days only after explicitly configuring the isolated Acceptance lab", () => {
    const lab = { ...validEnvironment, ROOT_DINGTALK_USER_ID: "uat-root", ACCEPTANCE_LAB_ENABLED: "true", ACCEPTANCE_LAB_SECRET: "TEST-acceptance-dedicated-secret-at-least-32-characters" };
    expect(loadConfig(lab).sessionTtlSeconds).toBe(28800);
    expect(loadConfig({ ...lab, SESSION_TTL_SECONDS: "2592000" }).sessionTtlSeconds).toBe(2592000);
    expect(() => loadConfig({ ...lab, SESSION_TTL_SECONDS: "2592001" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnvironment, SESSION_TTL_SECONDS: "2592000" })).toThrow(/isolated test Acceptance/);
    expect(() => loadConfig({ ...lab, NODE_ENV: "development", SESSION_TTL_SECONDS: "2592000" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...lab, NODE_ENV: "production", SESSION_TTL_SECONDS: "2592000" })).toThrow(ConfigurationError);
    expect(loadConfig({ ...validEnvironment, SESSION_TTL_SECONDS: "86400" }).sessionTtlSeconds).toBe(86400);
    expect(() => loadConfig({ ...validEnvironment, SESSION_TTL_SECONDS: "86401" })).toThrow(ConfigurationError);
  });
  it("keeps digital production disabled by default and separates new creation from existing work", () => {
    expect(loadConfig(validEnvironment).digitalProduction).toEqual({ enabled: false, creationEnabled: false });
    expect(loadConfig({ ...validEnvironment, DIGITAL_PRODUCTION_ENABLED: "true" }).digitalProduction)
      .toEqual({ enabled: true, creationEnabled: false });
    expect(() => loadConfig({ ...validEnvironment, DIGITAL_PRODUCTION_ENABLED: "yes" })).toThrow(ConfigurationError);
  });

  it("loads typed defaults without exposing source environment", () => {
    const config = loadConfig(validEnvironment);
    expect(config.port).toBe(3201);
    expect(config.host).toBe("127.0.0.1");
    expect(config.databaseUrl).toBe(validEnvironment.DATABASE_URL);
    expect(config.acceptanceLab).toEqual({ enabled: false, secret: undefined });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("allows the acceptance lab only in test mode with its dedicated secret and Root", () => {
    const config = loadConfig({
      ...validEnvironment,
      ROOT_DINGTALK_USER_ID: "uat-root",
      ACCEPTANCE_LAB_ENABLED: "true",
      ACCEPTANCE_LAB_SECRET: "acceptance-lab-secret-with-more-than-32-characters",
    });
    expect(config.acceptanceLab.enabled).toBe(true);
    expect(config.acceptanceLab.secret).toHaveLength(50);
    expect(config.rootDingtalkUserId).toBe("uat-root");
  });

  it("rejects an acceptance lab without its dedicated secret", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ROOT_DINGTALK_USER_ID: "uat-root",
      ACCEPTANCE_LAB_ENABLED: "true",
    })).toThrow(/dedicated secret/);
  });

  it("rejects an acceptance lab without the pinned uat-root identity", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ACCEPTANCE_LAB_ENABLED: "true",
      ACCEPTANCE_LAB_SECRET: "acceptance-lab-secret-with-more-than-32-characters",
    })).toThrow(/ROOT_DINGTALK_USER_ID=uat-root/);
  });

  it("rejects an acceptance lab whose Root points at another synthetic identity", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ROOT_DINGTALK_USER_ID: "uat-worker-a",
      ACCEPTANCE_LAB_ENABLED: "true",
      ACCEPTANCE_LAB_SECRET: "acceptance-lab-secret-with-more-than-32-characters",
    })).toThrow(/ROOT_DINGTALK_USER_ID=uat-root/);
  });

  it("rejects the acceptance lab in production even when all production metadata is valid", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: "production",
      GIT_SHA: "a".repeat(40),
      BUILD_TIME: "2026-09-08T06:00:00Z",
      ROOT_DINGTALK_USER_ID: "uat-root",
      ACCEPTANCE_LAB_ENABLED: "true",
      ACCEPTANCE_LAB_SECRET: "acceptance-lab-secret-with-more-than-32-characters",
    })).toThrow(/NODE_ENV=test/);
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

  it.each(["/", "/private", "private/", "private//nested"])("rejects a root or non-normalized private OSS prefix %s", (privatePrefix) => {
    expect(() => loadConfig({ ...validEnvironment, OSS_PRIVATE_PREFIX: privatePrefix })).toThrow(ConfigurationError);
  });

  it("requires HTTPS for a complete production OSS configuration", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: "production",
      GIT_SHA: "a".repeat(40),
      BUILD_TIME: "2026-08-01T00:00:00Z",
      OSS_REGION: "oss-cn-hangzhou",
      OSS_ENDPOINT: "http://oss-cn-hangzhou.aliyuncs.com",
      OSS_BUCKET: "dx-rework-private",
      OSS_ACCESS_KEY_ID: "valid-access-key",
      OSS_ACCESS_KEY_SECRET: "valid-access-secret",
    })).toThrow(/HTTPS OSS endpoint/);
  });

  it("rejects placeholder OSS credentials in production", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: "production",
      GIT_SHA: "a".repeat(40),
      BUILD_TIME: "2026-08-01T00:00:00Z",
      OSS_REGION: "oss-cn-hangzhou",
      OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com",
      OSS_BUCKET: "dx-rework-private",
      OSS_ACCESS_KEY_ID: "valid-access-key",
      OSS_ACCESS_KEY_SECRET: "replace_with_secret",
    })).toThrow(/placeholder/);
  });

  it.each(["//example.com", "/rework//admin", "/rework?next=/"])("rejects unsafe application base path %s", (appBasePath) => {
    expect(() => loadConfig({ ...validEnvironment, APP_BASE_PATH: appBasePath })).toThrow(ConfigurationError);
  });
});


describe("session cookie transport", () => {
  it("requires Secure for HTTPS even in Acceptance test mode", () => {
    expect(loadConfig(validEnvironment).sessionCookieSecure).toBe(true);
    expect(loadConfig({ ...validEnvironment, ACCEPTANCE_LAB_ENABLED: "true", ACCEPTANCE_LAB_SECRET: "acceptance-lab-secret-with-more-than-32-characters", ROOT_DINGTALK_USER_ID: "uat-root" }).sessionCookieSecure).toBe(true);
    expect(() => loadConfig({ ...validEnvironment, SESSION_COOKIE_SECURE: "false" })).toThrow(/require Secure/);
  });
  it("supports local HTTP without Secure and explicit Secure for a TLS frontend", () => {
    const local = { ...validEnvironment, DINGTALK_QR_REDIRECT_URI: "http://127.0.0.1:3201/auth/qr/callback" };
    expect(loadConfig(local).sessionCookieSecure).toBe(false);
    expect(loadConfig({ ...local, SESSION_COOKIE_SECURE: "true" }).sessionCookieSecure).toBe(true);
  });
});
