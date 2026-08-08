import { loadConfig } from "@dx-rework/config";
import { DisabledErpAdapter } from "@dx-rework/domain";
import pg from "pg";

import { EmployeeAccessService } from "./access/employee-access-service.js";
import { RootAuthority } from "./access/root-authority.js";
import { AccessMasterDataService } from "./access/service.js";
import { AdminAuditService } from "./admin-audit-service.js";
import { AdminConsoleService } from "./admin-console-service.js";
import { buildApp } from "./app.js";
import { OfficialDingTalkProvider } from "./auth/provider.js";
import { PostgresAuthStore } from "./auth/postgres-store.js";
import { AuthService } from "./auth/service.js";
import { ErpIntegrationService } from "./erp/erp-integration-service.js";
import {
  checkDatabase,
  getAppliedSchemaHistory,
  registerDatabasePoolErrorHandler,
} from "./platform/database.js";
import { ManagementReportingService } from "./reporting/management-reporting-service.js";
import { ReportExportService } from "./reporting/report-export-service.js";
import { ExternalResponsibilityApplicationService } from "./rework/external-responsibility-application-service.js";
import { OwnFactoryApprovalApplicationService } from "./rework/own-factory-approval-application-service.js";
import { ProcessConfigurationService } from "./rework/process-configuration-service.js";
import { ResponsibilityDeterminationApplicationService } from "./rework/responsibility-determination-application-service.js";
import { ReworkInitiationService } from "./rework/service.js";
import { WholeOrderReviewService } from "./rework/whole-order-review-service.js";
import { WorkReportingService } from "./rework/work-reporting-service.js";
import { OfficialDingTalkTodoProvider } from "./todos/provider.js";
import { TodoProjectionService } from "./todos/projection-service.js";
import { TodoRuntimeLifecycle } from "./todos/runtime-lifecycle.js";
import { TodoService } from "./todos/service.js";
import { AttachmentService } from "./tools/attachments.js";
import { ExportJobService } from "./tools/exports.js";
import { DisabledObjectStorage } from "./tools/storage.js";
import { canDownloadWageAttachment } from "./wages/wage-attachment-access.js";
import { WageExportService } from "./wages/wage-export-service.js";
import { WageService } from "./wages/wage-service.js";

const { Pool } = pg;
const config = loadConfig();
const database = new Pool({
  connectionString: config.databaseUrl,
  application_name: config.serviceName,
  max: 10,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
});

const rootAuthority = new RootAuthority(
  database,
  config.dingtalk.corpId,
  config.rootDingtalkUserId,
);
const authStore = new PostgresAuthStore(database, config.dingtalk.corpId);
const accessService = new AccessMasterDataService(database, config.dingtalk.corpId);
await accessService.ensureOrganizationPolicy();
const dingtalkProvider = new OfficialDingTalkProvider(config.dingtalk);
const auth = new AuthService(
  dingtalkProvider,
  authStore,
  config.dingtalk.corpId,
  config.sessionTtlSeconds * 1000,
  config.sessionSecret,
);
const employeeAccessService = new EmployeeAccessService(
  database,
  config.dingtalk.corpId,
  accessService,
  authStore,
  dingtalkProvider,
  config.ownerBootstrap,
);
const storage = new DisabledObjectStorage();
if (config.objectStorage.enabled) throw new Error("OSS is configured but the official Aliyun OSS SDK client has not been injected");
const attachments = new AttachmentService(database, storage, {
  prefix: config.objectStorage.privatePrefix,
  ttlSeconds: config.objectStorage.signedUrlTtlSeconds,
  maxUploadBytes: config.objectStorage.maxUploadBytes,
});
const todoService = new TodoService(database);
const todoProjection = new TodoProjectionService(todoService);
const reworkService = new ReworkInitiationService(
  database,
  config.dingtalk.corpId,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const erpIntegrationService = new ErpIntegrationService(
  database,
  config.dingtalk.corpId,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const processConfigurationService = new ProcessConfigurationService(
  database,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const workReportingService = new WorkReportingService(
  database,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const wholeOrderReviewService = new WholeOrderReviewService(
  database,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const responsibilityDeterminationService = new ResponsibilityDeterminationApplicationService(
  database,
  todoProjection,
);
const ownFactoryApprovalService = new OwnFactoryApprovalApplicationService(
  database,
  todoProjection,
);
const externalResponsibilityService = new ExternalResponsibilityApplicationService(
  database,
  todoProjection,
);
const wageService = new WageService(database, undefined, undefined, todoProjection);
const reportingService = new ManagementReportingService(database);
const app = buildApp({
  config,
  checkDatabase: () => checkDatabase(database),
  getAppliedSchemaHistory: () => getAppliedSchemaHistory(database),
  auth,
  access: {
    authenticate: (token) => auth.authenticate(token),
    service: accessService,
    root: rootAuthority,
  },
  employeeAccess: {
    authenticate: (token) => auth.authenticate(token),
    service: employeeAccessService,
    root: rootAuthority,
  },
  tools: {
    authenticate: (token) => auth.authenticate(token),
    attachments,
    exports: new ExportJobService(database),
    canDownloadBoundAttachment: async (actor, binding) => {
      if (await reworkService.canDownloadBoundAttachment(actor, binding)) return true;
      return canDownloadWageAttachment(database, actor, binding);
    },
  },
  rework: {
    authenticate: (token) => auth.authenticate(token),
    service: reworkService,
    root: rootAuthority,
    listInitiationOptions: async () => {
      const [directory, suppliers] = await Promise.all([
        employeeAccessService.listDirectory(),
        accessService.listSuppliers(false),
      ]);
      return {
        merchandisers: directory.employees
          .filter((employee) =>
            employee.enabled
            && employee.active
            && employee.employed
            && employee.businessRoles.includes("order_merchandiser"))
          .map((employee) => ({ userId: employee.userId, displayName: employee.displayName })),
        factories: suppliers
          .filter((supplier) => supplier.active && supplier.supplierType === "factory")
          .map((supplier) => ({
            supplierId: supplier.supplierId,
            supplierVersion: supplier.version,
            supplierName: supplier.supplierName,
          })),
      };
    },
    erp: {
      adapter: new DisabledErpAdapter(),
      service: erpIntegrationService,
    },
  },
  processConfiguration: {
    authenticate: (token) => auth.authenticate(token),
    service: processConfigurationService,
  },
  workReporting: {
    authenticate: (token) => auth.authenticate(token),
    service: workReportingService,
  },
  wholeOrderReview: {
    authenticate: (token) => auth.authenticate(token),
    service: wholeOrderReviewService,
  },
  responsibilityDetermination: {
    authenticate: (token) => auth.authenticate(token),
    service: responsibilityDeterminationService,
  },
  ownFactoryApproval: {
    authenticate: (token) => auth.authenticate(token),
    service: ownFactoryApprovalService,
  },
  externalResponsibility: {
    authenticate: (token) => auth.authenticate(token),
    service: externalResponsibilityService,
  },
  wages: { authenticate: (token) => auth.authenticate(token), service: wageService, exportService: new WageExportService(database) },
  todos: { authenticate: (token) => auth.authenticate(token), service: todoService },
  reporting: {
    authenticate: (token) => auth.authenticate(token),
    service: reportingService,
    exportService: new ReportExportService(reportingService, database, config.gitSha),
  },
  adminAudit: { authenticate: (token) => auth.authenticate(token), service: new AdminAuditService(database) },
  adminConsole: {
    authenticate: (token) => auth.authenticate(token),
    service: new AdminConsoleService(database),
    root: rootAuthority,
  },
});
registerDatabasePoolErrorHandler(database, app.log);

const todoProvider = config.todoRuntime.enabled
  ? new OfficialDingTalkTodoProvider({
      appKey: config.dingtalk.h5AppKey,
      appSecret: config.dingtalk.h5AppSecret,
      nodeEnv: config.nodeEnv,
    })
  : undefined;
const todoRuntime = new TodoRuntimeLifecycle(database, {
  enabled: config.todoRuntime.enabled,
  appBasePath: config.appBasePath,
  ...(config.todoRuntime.actorId ? { runtimeActorId: config.todoRuntime.actorId } : {}),
  deliveryIntervalMs: config.todoRuntime.deliveryIntervalMs,
  timingIntervalMs: config.todoRuntime.timingIntervalMs,
  ...(todoProvider ? { provider: todoProvider } : {}),
  logger: app.log,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "graceful shutdown started");
  await todoRuntime.stop();
  await app.close();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
  todoRuntime.start();
} catch (error: unknown) {
  app.log.fatal({ err: error }, "API startup failed");
  await todoRuntime.stop();
  await database.end();
  process.exitCode = 1;
}
