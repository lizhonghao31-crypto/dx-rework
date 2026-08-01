import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "@dx-rework/config";
import {
  ErrorResponseSchema,
  LiveHealthResponseSchema,
  ReadyHealthResponseSchema,
  VersionResponseSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../apps/api/src/app.js";
import {
  EXPECTED_SCHEMA_CHECKSUM,
  EXPECTED_SCHEMA_VERSION,
  migrationHistoriesMatch,
} from "../../apps/api/src/platform/schema-version.js";

const apps: FastifyInstance[] = [];
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/dx_rework_test",
  GIT_SHA: "test-sha",
  BUILD_TIME: "2026-08-01T00:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createApp(overrides?: {
  checkDatabase?: () => Promise<void>;
  getAppliedSchemaHistory?: () => Promise<Array<{ version: string; checksum: string }> | null>;
}) {
  const app = buildApp({
    config,
    checkDatabase: overrides?.checkDatabase ?? (async () => undefined),
    getAppliedSchemaHistory:
      overrides?.getAppliedSchemaHistory ??
      (async () => [{ version: EXPECTED_SCHEMA_VERSION, checksum: EXPECTED_SCHEMA_CHECKSUM }]),
  });
  apps.push(app);
  return app;
}

describe("platform health contract", () => {
  it("keeps liveness independent from database readiness", async () => {
    const app = createApp({ checkDatabase: async () => Promise.reject(new Error("database unavailable")) });
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(() => LiveHealthResponseSchema.parse(response.json())).not.toThrow();
  });

  it("reports ready only when database and schema are current", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(ReadyHealthResponseSchema.parse(response.json())).toMatchObject({
      status: "ready",
      checks: { database: "up", schema: "current" },
    });
  });

  it("reports schema drift as not ready", async () => {
    const app = createApp({
      getAppliedSchemaHistory: async () => [{ version: "0000_old", checksum: EXPECTED_SCHEMA_CHECKSUM }],
    });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(ReadyHealthResponseSchema.parse(response.json())).toMatchObject({
      status: "not_ready",
      checks: { database: "up", schema: "drift" },
    });
  });

  it("reports checksum drift as not ready even when the version matches", async () => {
    const app = createApp({
      getAppliedSchemaHistory: async () => [{ version: EXPECTED_SCHEMA_VERSION, checksum: "0".repeat(64) }],
    });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(ReadyHealthResponseSchema.parse(response.json())).toMatchObject({
      status: "not_ready",
      checks: { database: "up", schema: "drift" },
    });
  });

  it("rejects drift in an older migration even when the newest fingerprint matches", () => {
    const expected = [
      { version: "0001_foundation", checksum: "1".repeat(64) },
      { version: "0002_feature", checksum: "2".repeat(64) },
    ];
    const applied = [
      { version: "0001_foundation", checksum: "0".repeat(64) },
      { version: "0002_feature", checksum: "2".repeat(64) },
    ];
    expect(migrationHistoriesMatch(applied, expected)).toBe(false);
  });

  it("does not leak dependency errors from readiness", async () => {
    const app = createApp({ checkDatabase: async () => Promise.reject(new Error("secret connection detail")) });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret connection detail");
  });

  it("returns immutable build and schema evidence", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/version" });
    expect(response.statusCode).toBe(200);
    expect(VersionResponseSchema.parse(response.json())).toEqual({
      service: "dx-rework-api",
      gitSha: "test-sha",
      buildTime: "2026-08-01T00:00:00.000Z",
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    });
  });

  it("uses a unified not-found response with request ID", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/missing", headers: { "x-request-id": "uat-123" } });
    expect(response.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(response.json())).toEqual({
      error: { code: "NOT_FOUND", message: "Resource not found", requestId: "uat-123" },
    });
    expect(response.headers["x-request-id"]).toBe("uat-123");
  });
});
