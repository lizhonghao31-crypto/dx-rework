import { randomUUID } from "node:crypto";

import type { AppConfig } from "@dx-rework/config";
import type {
  ErrorResponse,
  LiveHealthResponse,
  ReadyHealthResponse,
  VersionResponse,
} from "@dx-rework/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppliedSchemaState } from "./platform/database.js";
import { ApplicationError } from "./platform/errors.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { AuthService } from "./auth/service.js";
import { AuthDeniedError } from "./auth/service.js";
import { EXPECTED_SCHEMA_VERSION, migrationHistoriesMatch } from "./platform/schema-version.js";
import { registerToolsRoutes, type ToolsHttpDependencies } from "./tools/routes.js";
import { registerAccessRoutes, type AccessHttpDependencies } from "./access/routes.js";
import { registerReworkRoutes, type ReworkHttpDependencies } from "./rework/routes.js";
import {
  registerProcessConfigurationRoutes,
  type ProcessConfigurationHttpDependencies,
} from "./rework/process-configuration-routes.js";
import { registerWorkReportingRoutes, type WorkReportingHttpDependencies } from "./rework/work-reporting-routes.js";
import { registerWholeOrderReviewRoutes, type WholeOrderReviewHttpDependencies } from "./rework/whole-order-review-routes.js";
import { registerResponsibilityDeterminationRoutes, type ResponsibilityDeterminationHttpDependencies } from "./rework/responsibility-determination-routes.js";
import { registerOwnFactoryApprovalRoutes, type OwnFactoryApprovalHttpDependencies } from "./rework/own-factory-approval-routes.js";
import { registerExternalResponsibilityRoutes, type ExternalResponsibilityHttpDependencies } from "./rework/external-responsibility-routes.js";
import { registerWageRoutes, type WageHttpDependencies } from "./wages/wage-routes.js";
import { registerTodoRoutes, type TodoHttpDependencies } from "./todos/routes.js";

export type AppDependencies = Readonly<{
  config: AppConfig;
  checkDatabase: () => Promise<void>;
  getAppliedSchemaHistory: () => Promise<AppliedSchemaState[] | null>;
  auth?: AuthService;
  tools?: ToolsHttpDependencies;
  access?: AccessHttpDependencies;
  rework?: ReworkHttpDependencies;
  processConfiguration?: ProcessConfigurationHttpDependencies;
  workReporting?: WorkReportingHttpDependencies;
  wholeOrderReview?: WholeOrderReviewHttpDependencies;
  responsibilityDetermination?: ResponsibilityDeterminationHttpDependencies;
  ownFactoryApproval?: OwnFactoryApprovalHttpDependencies;
  externalResponsibility?: ExternalResponsibilityHttpDependencies;
  wages?: WageHttpDependencies;
  todos?: TodoHttpDependencies;
}>;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function serializeRequestForLog(request: { id?: string; method?: string; url?: string }): Record<string, string | undefined> {
  return {
    requestId: request.id,
    method: request.method,
    path: request.url?.split("?", 1)[0],
  };
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const { config } = dependencies;
  const app = Fastify({
    // Production traffic is proxied by the local Nginx only. Never trust forwarding
    // headers from a client connected directly or through a non-loopback proxy.
    trustProxy: (address) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1",
    logger:
      config.nodeEnv === "test"
        ? false
        : {
            level: config.logLevel,
            serializers: { req: serializeRequestForLog },
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

  if (dependencies.auth) registerAuthRoutes(app, dependencies.auth, { secureCookie: config.nodeEnv === "production", ttlSeconds: config.sessionTtlSeconds, appBasePath: config.appBasePath, corpId: config.dingtalk.corpId, mobileClientId: config.dingtalk.h5AppKey });
  if (dependencies.tools) registerToolsRoutes(app, dependencies.tools);
  if (dependencies.access) registerAccessRoutes(app, dependencies.access);
  if (dependencies.rework) registerReworkRoutes(app, dependencies.rework);
  if (dependencies.processConfiguration) {
    registerProcessConfigurationRoutes(app, dependencies.processConfiguration);
  }
  if (dependencies.workReporting) registerWorkReportingRoutes(app, dependencies.workReporting);
  if (dependencies.wholeOrderReview) registerWholeOrderReviewRoutes(app, dependencies.wholeOrderReview);
  if (dependencies.responsibilityDetermination) registerResponsibilityDeterminationRoutes(app, dependencies.responsibilityDetermination);
  if (dependencies.ownFactoryApproval) registerOwnFactoryApprovalRoutes(app, dependencies.ownFactoryApproval);
  if (dependencies.externalResponsibility) registerExternalResponsibilityRoutes(app, dependencies.externalResponsibility);
  if (dependencies.wages) registerWageRoutes(app, dependencies.wages);
  if (dependencies.todos) registerTodoRoutes(app, dependencies.todos);

  app.get<{ Reply: ReadyHealthResponse }>("/health/ready", async (_request, reply) => {
    try {
      await dependencies.checkDatabase();
      const schemaHistory = await dependencies.getAppliedSchemaHistory();
      const schemaCurrent = schemaHistory !== null && migrationHistoriesMatch(schemaHistory);
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
    let schemaHistory: AppliedSchemaState[] | null = null;
    try {
      schemaHistory = await dependencies.getAppliedSchemaHistory();
    } catch (error: unknown) {
      app.log.warn({ err: error }, "schema version lookup failed");
    }
    return {
      service: config.serviceName,
      gitSha: config.gitSha,
      buildTime: config.buildTime,
      schemaVersion: schemaHistory?.at(-1)?.version ?? null,
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
    const denied = error instanceof AuthDeniedError;
    const statusCode = known ? error.statusCode : denied ? 401 : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    const response: ErrorResponse = {
      error: {
        code: known || denied ? error.code : "INTERNAL_ERROR",
        message: known || denied ? error.message : "Internal server error",
        requestId: request.id,
      },
    };
    return reply.code(statusCode).send(response);
  });

  return app;
}
