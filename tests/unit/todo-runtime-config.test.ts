import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "@dx-rework/config";

const environment = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/dx_rework_test",
  DINGTALK_CORP_ID: "corp-test",
  DINGTALK_H5_APP_KEY: "app-key-test",
  DINGTALK_H5_APP_SECRET: "app-secret-test",
  DINGTALK_WEB_CLIENT_ID: "qr-client-test",
  DINGTALK_WEB_CLIENT_SECRET: "web-client-secret-test",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/auth/qr/callback",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
};

describe("todo runtime configuration", () => {
  it("is disabled by default with bounded worker intervals", () => {
    expect(loadConfig(environment).todoRuntime).toEqual({
      enabled: false,
      actorId: undefined,
      deliveryIntervalMs: 30_000,
      timingIntervalMs: 60_000,
    });
  });

  it("requires an explicit actor and rejects real runtime execution in tests", () => {
    expect(() => loadConfig({
      ...environment,
      TODO_RUNTIME_ENABLED: "true",
    })).toThrow(ConfigurationError);
    expect(() => loadConfig({
      ...environment,
      NODE_ENV: "test",
      TODO_RUNTIME_ENABLED: "true",
      TODO_RUNTIME_ACTOR_ID: "00000000-0000-4000-8000-000000000001",
    })).toThrow(/test environment cannot enable/);
  });

  it("accepts explicit production-like runtime settings", () => {
    expect(loadConfig({
      ...environment,
      TODO_RUNTIME_ENABLED: "true",
      TODO_RUNTIME_ACTOR_ID: "00000000-0000-4000-8000-000000000001",
      TODO_DELIVERY_INTERVAL_MS: "5000",
      TODO_TIMING_INTERVAL_MS: "10000",
    }).todoRuntime).toEqual({
      enabled: true,
      actorId: "00000000-0000-4000-8000-000000000001",
      deliveryIntervalMs: 5_000,
      timingIntervalMs: 10_000,
    });
  });
});
