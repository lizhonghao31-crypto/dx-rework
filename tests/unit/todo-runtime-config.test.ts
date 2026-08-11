import { describe, expect, it } from "vitest";

import { loadConfig } from "@dx-rework/config";

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
      deliveryEnabled: false,
      timingEnabled: false,
      publicBaseUrl: undefined,
      actorId: undefined,
      deliveryIntervalMs: 30_000,
      timingIntervalMs: 60_000,
    });
  });

  it("validates delivery and timing independently", () => {
    expect(() => loadConfig({
      ...environment,
      TODO_DELIVERY_ENABLED: "true",
    })).toThrow(/DINGTALK_H5_AGENT_ID/);
    expect(() => loadConfig({
      ...environment,
      DINGTALK_H5_AGENT_ID: "123456",
      TODO_PUBLIC_BASE_URL: "https://staging.example/rework/",
      TODO_TIMING_ENABLED: "true",
    })).toThrow(/TODO_RUNTIME_ACTOR_ID/);
    expect(() => loadConfig({
      ...environment,
      NODE_ENV: "test",
      DINGTALK_H5_AGENT_ID: "123456",
      TODO_PUBLIC_BASE_URL: "https://staging.example/rework/",
      TODO_DELIVERY_ENABLED: "true",
    })).toThrow(/test environment cannot enable/);
  });

  it("enables immediate delivery while leaving reminders and escalation off", () => {
    expect(loadConfig({
      ...environment,
      DINGTALK_H5_AGENT_ID: "123456",
      TODO_DELIVERY_ENABLED: "true",
      TODO_TIMING_ENABLED: "false",
      TODO_PUBLIC_BASE_URL: "https://staging.example/rework/",
      TODO_DELIVERY_INTERVAL_MS: "5000",
      TODO_TIMING_INTERVAL_MS: "10000",
    }).todoRuntime).toEqual({
      enabled: true,
      deliveryEnabled: true,
      timingEnabled: false,
      publicBaseUrl: "https://staging.example/rework/",
      actorId: undefined,
      deliveryIntervalMs: 5_000,
      timingIntervalMs: 10_000,
    });
  });
});
