import { randomUUID } from "node:crypto";

import type { AppConfig } from "@dx-rework/config";
import type {
  ErrorResponse,
  LiveHealthResponse,
  ReadyHealthResponse,
  VersionResponse,
} from "@dx-rework/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { ApplicationError } from "./platform/errors.js";
import { EXPECTED_SCHEMA_VERSION } from "./platform/schema-version.js";

export type AppDependencies = Readonly<{
  config: AppConfig;
  checkDatabase: () => Promise<void>;
  getAppliedSchemaVersion: () => Promise<string | null>;
}>;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const { config } = dependencies;
  const app = Fastify({
    logger:
      config.nodeEnv === "test"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "res.headers.set-cookie",
                "databaseUrl",
                "password",
                "token",
                "secret",
              ],
              censor: "[REDACTED]",
            },
          },
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  app.get<{ Reply: LiveHealthResponse }>("/health/live", async () => ({
    status: "ok",
    service: config.serviceName,
    timestamp: new Date().toISOString(),
  }));

  app.get<{ Reply: ReadyHealthResponse }>("/health/ready", async (_request, reply) => {
    try {
      await dependencies.checkDatabase();
      const schemaVersion = await dependencies.getAppliedSchemaVersion();
      const schemaCurrent = schemaVersion === EXPECTED_SCHEMA_VERSION;
      const response: ReadyHealthResponse = {
        status: schemaCurrent ? "ready" : "not_ready",
        service: config.serviceName,
        checks: {
          database: "up",
          schema: schemaCurrent ? "current" : "drift",
        },
        timestamp: new Date().toISOString(),
      };
      return schemaCurrent ? response : reply.code(503).send(response);
    } catch (error: unknown) {
      app.log.warn({ err: error }, "readiness dependency check failed");
      return reply.code(503).send({
        status: "not_ready",
        service: config.serviceName,
        checks: { database: "down", schema: "unavailable" },
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get<{ Reply: VersionResponse }>("/version", async () => {
    let schemaVersion: string | null = null;
    try {
      schemaVersion = await dependencies.getAppliedSchemaVersion();
    } catch (error: unknown) {
      app.log.warn({ err: error }, "schema version lookup failed");
    }
    return {
      service: config.serviceName,
      gitSha: config.gitSha,
      buildTime: config.buildTime,
      schemaVersion,
      expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    };
  });

  app.setNotFoundHandler(async (request, reply) => {
    const response: ErrorResponse = {
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
        requestId: request.id,
      },
    };
    return reply.code(404).send(response);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const known = error instanceof ApplicationError;
    const statusCode = known ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    const response: ErrorResponse = {
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "Internal server error",
        requestId: request.id,
      },
    };
    return reply.code(statusCode).send(response);
  });

  return app;
}
