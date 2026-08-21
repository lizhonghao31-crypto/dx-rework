import { loadConfig } from "@dx-rework/config";
import { DisabledErpAdapter } from "@dx-rework/domain";
import pg from "pg";

import { EmployeeAccessService } from "./access/employee-access-service.js";
import { RootAuthority } from "./access/root-authority.js";
import { WorkerAwareAccessMasterDataService } from "./access/worker-aware-access-service.js";
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
import { ReceivingService } from "./receiving/receiving-service.js";
import { ManagementReportingService } from "./reporting/management-reporting-service.js";
import { ReportExportService } from "./reporting/report-export-service.js";
import { BusinessAwareWholeOrderReviewService } from "./rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "./rework/external-responsibility-application-service.js";
import { OwnFactoryApprovalApplicationService } from "./rework/own-factory-approval-application-service.js";
import { ProcessConfigurationService } from "./rework/process-configuration-service.js";
import { ResponsibilityDeterminationApplicationService } from "./rework/responsibility-determination-application-service.js";
import { ReworkBusinessDetailService } from "./rework/rework-business-detail-service.js";
import { InspectionImageExtractionService } from "./rework/inspection-image-extraction-service.js";
import { ReworkInitiationService } from "./rework/service.js";
import { ReworkSupplyContextService } from "./rework/supply-context-service.js";
import { ReworkV2DraftService } from "./rework/v2-draft-service.js";
import { ReworkV2SubmissionService } from "./rework/v2-submission-service.js";
import { WorkReportingService } from "./rework/work-reporting-service.js";
import { TailInspectionService } from "./rework/tail-inspection-service.js";
import { OfficialDingTalkTodoProvider } from "./todos/provider.js";
import { RootAwareTodoProjectionService } from "./todos/root-aware-projection-service.js";
import { TodoRuntimeLifecycle } from "./todos/runtime-lifecycle.js";
import { TodoService } from "./todos/service.js";
import { AliyunOssV4RestClient } from "./tools/aliyun-oss-v4-client.js";
import { AttachmentService } from "./tools/attachments.js";
import { ExportJobService } from "./tools/exports.js";
import {
  AliyunPrivateObjectStorage,
  DisabledObjectStorage,
} from "./tools/storage.js";
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
const accessService = new WorkerAwareAccessMasterDataService(database, config.dingtalk.corpId);
await accessService.ensureOrganizationPolicy();
await rootAuthority.assertConfigurationConsistency();
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
const storage = config.objectStorage.enabled
  ? new AliyunPrivateObjectStorage(new AliyunOssV4RestClient({
      region: config.objectStorage.region!,
      endpoint: config.objectStorage.endpoint!,
      bucket: config.objectStorage.bucket!,
      accessKeyId: config.objectStorage.accessKeyId!,
      accessKeySecret: config.objectStorage.accessKeySecret!,
    }))
  : new DisabledObjectStorage();
const attachments = new AttachmentService(database, storage, {
  prefix: config.objectStorage.privatePrefix,
  ttlSeconds: config.objectStorage.signedUrlTtlSeconds,
  maxUploadBytes: config.objectStorage.maxUploadBytes,
});
const todoService = new TodoService(database);
const todoProjection = new RootAwareTodoProjectionService(todoService);
const receivingService = new ReceivingService(database);
const reworkService = new ReworkInitiationService(
  database,
  config.dingtalk.corpId,
  undefined,
  undefined,
  undefined,
  todoProjection,
  todoService,
);
const reworkSupplyContextService = new ReworkSupplyContextService(
  database,
  config.dingtalk.corpId,
);
const reworkV2DraftService = new ReworkV2DraftService(
  database,
  config.dingtalk.corpId,
);
const reworkV2SubmissionService = new ReworkV2SubmissionService(
  database,
  config.dingtalk.corpId,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const reworkBusinessDetailService = new ReworkBusinessDetailService(database);
const inspectionImageExtractor = new InspectionImageExtractionService({
  apiKey: config.openai.apiKey,
  model: config.openai.visionModel,
});
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
  todoProjection,
);
const tailInspectionService = new TailInspectionService(database, undefined, undefined, todoProjection);
const wholeOrderReviewService = new BusinessAwareWholeOrderReviewService(
  database,
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
  receiving: {
    authenticate: (token) => auth.authenticate(token),
    service: receivingService,
    root: rootAuthority,
  },
  tools: {
    authenticate: (token) => auth.authenticate(token),
    attachments,
    exports: new ExportJobService(database),
    canDownloadBoundAttachment: async (actor, binding) => {
      const businessReader = {
        actorId: actor.actorId,
        actorRoles: actor.actorRoles,
        authorizationCapability: "tools:user",
        authorizationCapabilities: actor.capabilities,
        requestId: "attachment-download",
      };
      if (await reworkBusinessDetailService.canDownloadBoundAttachment(businessReader, binding)) return true;
      if (await reworkService.canDownloadBoundAttachment(actor, binding)) return true;
      return canDownloadWageAttachment(database, actor, binding);
    },
  },
  rework: {
    authenticate: (token) => auth.authenticate(token),
    service: reworkService,
    v2DraftService: reworkV2DraftService,
    v2SubmissionService: reworkV2SubmissionService,
    businessDetailService: reworkBusinessDetailService,
    supplyContextService: reworkSupplyContextService,
    root: rootAuthority,
    attachments,
    inspectionImageExtractor,
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
    root: rootAuthority,
  },
  workReporting: {
    authenticate: (token) => auth.authenticate(token),
    service: workReportingService,
    root: rootAuthority,
  },
  tailInspection: {
    authenticate: (token) => auth.authenticate(token),
    service: tailInspectionService,
    root: rootAuthority,
  },
  wholeOrderReview: {
    authenticate: (token) => auth.authenticate(token),
    service: wholeOrderReviewService,
    root: rootAuthority,
  },
  responsibilityDetermination: {
    authenticate: (token) => auth.authenticate(token),
    service: responsibilityDeterminationService,
    root: rootAuthority,
  },
  ownFactoryApproval: {
    authenticate: (token) => auth.authenticate(token),
    service: ownFactoryApprovalService,
    root: rootAuthority,
  },
  externalResponsibility: {
    authenticate: (token) => auth.authenticate(token),
    service: externalResponsibilityService,
    root: rootAuthority,
  },
  wages: {
    authenticate: (token) => auth.authenticate(token),
    service: wageService,
    exportService: new WageExportService(database),
    root: rootAuthority,
  },
  todos: { authenticate: (token) => auth.authenticate(token), service: todoService },
  reporting: {
    authenticate: (token) => auth.authenticate(token),
    service: reportingService,
    exportService: new ReportExportService(reportingService, database, config.gitSha),
    root: rootAuthority,
  },
  adminAudit: { authenticate: (token) => auth.authenticate(token), service: new AdminAuditService(database) },
  adminConsole: {
    authenticate: (token) => auth.authenticate(token),
    service: new AdminConsoleService(database),
    root: rootAuthority,
  },
});
registerDatabasePoolErrorHandler(database, app.log);

const todoProvider = config.todoRuntime.deliveryEnabled
  ? new OfficialDingTalkTodoProvider({
      appKey: config.dingtalk.h5AppKey,
      appSecret: config.dingtalk.h5AppSecret,
      agentId: config.dingtalk.h5AgentId!,
      nodeEnv: config.nodeEnv,
    })
  : undefined;
const todoRuntime = new TodoRuntimeLifecycle(database, {
  enabled: config.todoRuntime.enabled,
  deliveryEnabled: config.todoRuntime.deliveryEnabled,
  timingEnabled: config.todoRuntime.timingEnabled,
  ...(config.todoRuntime.publicBaseUrl
    ? { todoPublicBaseUrl: config.todoRuntime.publicBaseUrl }
    : {}),
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
