import { registerPatternRoomPriceRoutes, type PatternRoomPriceDependencies } from "./pattern-room/price-routes.js";
import {registerOperationDiagnostics,type DiagnosticRecord} from "./platform/operation-diagnostics.js";
import {registerSampleImportRoutes,type SampleImportDependencies} from "./samples/sample-import-routes.js";
import {registerSampleDisposalRoutes,type SampleDisposalDependencies} from "./samples/sample-disposal-routes.js";
import { randomUUID } from "node:crypto";
import { registerSampleWorkflowRoutes, type SampleWorkflowDependencies } from "./samples/sample-workflow-routes.js";
import { registerSampleReadRoutes, type SampleReadHttpDependencies } from "./samples/sample-read-routes.js";
import { registerSampleCreateRoutes, type SampleCreateHttpDependencies } from "./samples/sample-create-routes.js";

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
import { registerDataExportAuthorizationRoutes } from "./access/data-export-authorization-routes.js";
import { redactPermissionSensitivePayload } from "./access/permission-sensitive-field-policy.js";
import {
  registerEmployeeAccessRoutes,
  type EmployeeAccessHttpDependencies,
} from "./access/employee-access-routes.js";
import { registerReceivingRoutes, type ReceivingHttpDependencies } from "./receiving/receiving-routes.js";
import { registerSourcingRoutes, type SourcingHttpDependencies } from "./sourcing/sourcing-routes.js";
import { registerReworkRoutes, type ReworkHttpDependencies } from "./rework/routes.js";
import {
  registerProcessConfigurationRoutes,
  type ProcessConfigurationHttpDependencies,
} from "./rework/process-configuration-routes.js";
import { registerWorkReportingRoutes, type WorkReportingHttpDependencies } from "./rework/work-reporting-routes.js";
import { registerTailInspectionRoutes, type TailInspectionHttpDependencies } from "./rework/tail-inspection-routes.js";
import { registerWholeOrderReviewRoutes, type WholeOrderReviewHttpDependencies } from "./rework/whole-order-review-routes.js";
import { registerResponsibilityDeterminationRoutes, type ResponsibilityDeterminationHttpDependencies } from "./rework/responsibility-determination-routes.js";
import { registerOwnFactoryApprovalRoutes, type OwnFactoryApprovalHttpDependencies } from "./rework/own-factory-approval-routes.js";
import { registerExternalResponsibilityRoutes, type ExternalResponsibilityHttpDependencies } from "./rework/external-responsibility-routes.js";
import { registerWageRoutes, type WageHttpDependencies } from "./wages/wage-routes.js";
import { registerTodoRoutes, type TodoHttpDependencies } from "./todos/routes.js";
import { registerManagementReportingRoutes, type ManagementReportingHttpDependencies } from "./reporting/management-reporting-routes.js";
import { registerAdminAuditRoutes, type AdminAuditHttpDependencies } from "./admin-audit-routes.js";
import { registerAdminConsoleRoutes, type AdminConsoleHttpDependencies } from "./admin-console-routes.js";

export type AppDependencies = Readonly<{
  config: AppConfig;
  checkDatabase: () => Promise<void>;
  getAppliedSchemaHistory: () => Promise<AppliedSchemaState[] | null>;
  auth?: AuthService;
  tools?: ToolsHttpDependencies;
  access?: AccessHttpDependencies;
  employeeAccess?: EmployeeAccessHttpDependencies;
  receiving?: ReceivingHttpDependencies;
  sourcing?: SourcingHttpDependencies;
  samples?: SampleReadHttpDependencies;
  sampleCreation?: SampleCreateHttpDependencies;
  sampleImport?: SampleImportDependencies;
  sampleDisposal?: SampleDisposalDependencies;
  sampleWorkflow?: SampleWorkflowDependencies;
  rework?: ReworkHttpDependencies;
  processConfiguration?: ProcessConfigurationHttpDependencies;
  workReporting?: WorkReportingHttpDependencies;
  tailInspection?: TailInspectionHttpDependencies;
  wholeOrderReview?: WholeOrderReviewHttpDependencies;
  responsibilityDetermination?: ResponsibilityDeterminationHttpDependencies;
  ownFactoryApproval?: OwnFactoryApprovalHttpDependencies;
  externalResponsibility?: ExternalResponsibilityHttpDependencies;
  patternRoomPrices?: PatternRoomPriceDependencies;
  wages?: WageHttpDependencies;
  todos?: TodoHttpDependencies;
  reporting?: ManagementReportingHttpDependencies;
  adminAudit?: AdminAuditHttpDependencies;
  operationDiagnostics?: (row: DiagnosticRecord) => Promise<void>;
  adminConsole?: AdminConsoleHttpDependencies;
}>;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const permissionCookieToken = (cookieHeader: string | undefined): string | undefined =>
  cookieHeader
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice("dx_rework_session=".length);

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

  if (dependencies.operationDiagnostics) registerOperationDiagnostics(app,dependencies.operationDiagnostics);

  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  if (dependencies.access) {
    app.addHook("preSerialization", async (request, reply, payload) => {
      const path = request.url.split("?", 1)[0] ?? request.url;
      const sensitiveResponse = path === "/master-data/suppliers"
        || path.startsWith("/master-data/suppliers/")
        || path === "/sourcing"
        || path.startsWith("/sourcing/");
      if (!sensitiveResponse || reply.statusCode >= 400) return payload;

      const user = await dependencies.access!.authenticate(permissionCookieToken(request.headers.cookie));
      const isRoot = await dependencies.access!.root.isRootUser(user.id);
      return redactPermissionSensitivePayload(path, payload, user.businessRoles ?? [], isRoot);
    });
  }

  app.get<{ Reply: LiveHealthResponse }>("/health/live", async () => ({
    status: "ok",
    service: config.serviceName,
    timestamp: new Date().toISOString(),
  }));

  if (dependencies.auth) {
    registerAuthRoutes(app, dependencies.auth, {
      secureCookie: config.nodeEnv === "production",
      ttlSeconds: config.sessionTtlSeconds,
      appBasePath: config.appBasePath,
      corpId: config.dingtalk.corpId,
      mobileClientId: config.dingtalk.h5AppKey,
      webClientId: config.dingtalk.webClientId,
      qrRedirectUri: config.dingtalk.qrRedirectUri,
      ...(dependencies.access ? {
        isRootUser: (userId: string) => dependencies.access!.root.isRootUser(userId),
      } : {}),
    });
  }
  if (dependencies.tools) registerToolsRoutes(app, dependencies.tools);
  if (dependencies.access) {
    registerAccessRoutes(app, dependencies.access);
    registerDataExportAuthorizationRoutes(app, dependencies.access);
  }
  if (dependencies.employeeAccess) registerEmployeeAccessRoutes(app, dependencies.employeeAccess);
  if (dependencies.receiving) registerReceivingRoutes(app, dependencies.receiving);
  if (dependencies.sourcing) registerSourcingRoutes(app, dependencies.sourcing);
  if (dependencies.samples) registerSampleReadRoutes(app, dependencies.samples);
  if (dependencies.sampleImport) registerSampleImportRoutes(app, dependencies.sampleImport);
  if (dependencies.sampleDisposal) registerSampleDisposalRoutes(app, dependencies.sampleDisposal);
  if (dependencies.sampleWorkflow) registerSampleWorkflowRoutes(app, dependencies.sampleWorkflow);
  if (dependencies.sampleCreation) registerSampleCreateRoutes(app, dependencies.sampleCreation);
  if (dependencies.rework) registerReworkRoutes(app, dependencies.rework);
  if (dependencies.processConfiguration) {
    registerProcessConfigurationRoutes(app, dependencies.processConfiguration);
  }
  if (dependencies.workReporting) registerWorkReportingRoutes(app, dependencies.workReporting);
  if (dependencies.tailInspection) registerTailInspectionRoutes(app, dependencies.tailInspection);
  if (dependencies.wholeOrderReview) registerWholeOrderReviewRoutes(app, dependencies.wholeOrderReview);
  if (dependencies.responsibilityDetermination) registerResponsibilityDeterminationRoutes(app, dependencies.responsibilityDetermination);
  if (dependencies.ownFactoryApproval) registerOwnFactoryApprovalRoutes(app, dependencies.ownFactoryApproval);
  if (dependencies.externalResponsibility) registerExternalResponsibilityRoutes(app, dependencies.externalResponsibility);
  if (dependencies.patternRoomPrices) registerPatternRoomPriceRoutes(app, dependencies.patternRoomPrices);
  if (dependencies.wages) registerWageRoutes(app, dependencies.wages);
  if (dependencies.todos) registerTodoRoutes(app, dependencies.todos);
  if (dependencies.reporting) registerManagementReportingRoutes(app, dependencies.reporting);
  if (dependencies.adminAudit) registerAdminAuditRoutes(app, {
    ...dependencies.adminAudit,
    root: dependencies.adminAudit.root ?? dependencies.access?.root,
  });
  if (dependencies.adminConsole) registerAdminConsoleRoutes(app, dependencies.adminConsole);

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
    const frameworkStatusCode = typeof error === "object"
      && error !== null
      && "statusCode" in error
      && typeof error.statusCode === "number"
      && error.statusCode >= 400
      && error.statusCode < 500
      ? error.statusCode
      : null;
    const frameworkClientError = !known && !denied && frameworkStatusCode !== null;
    const statusCode = known ? error.statusCode : denied ? 401 : frameworkStatusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    const response: ErrorResponse = {
      error: {
        code: known || denied ? error.code : frameworkClientError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        message: known || denied ? error.message : frameworkClientError ? "Request validation failed" : "Internal server error",
        requestId: request.id,
      },
    };
    return reply.code(statusCode).send(response);
  });

  return app;
}
