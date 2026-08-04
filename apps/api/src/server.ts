import { loadConfig } from "@dx-rework/config";
import pg from "pg";

import { buildApp } from "./app.js";
import { OfficialDingTalkProvider } from "./auth/provider.js";
import { PostgresAuthStore } from "./auth/postgres-store.js";
import { AuthService } from "./auth/service.js";
import {
  checkDatabase,
  getAppliedSchemaHistory,
  registerDatabasePoolErrorHandler,
} from "./platform/database.js";
import { AttachmentService } from "./tools/attachments.js";
import { ExportJobService } from "./tools/exports.js";
import { DisabledObjectStorage } from "./tools/storage.js";
import { AccessMasterDataService } from "./access/service.js";
import { ReworkInitiationService } from "./rework/service.js";
import { ProcessConfigurationService } from "./rework/process-configuration-service.js";
import { WorkReportingService } from "./rework/work-reporting-service.js";
import { WholeOrderReviewService } from "./rework/whole-order-review-service.js";
import { ResponsibilityDeterminationApplicationService } from "./rework/responsibility-determination-application-service.js";
import { OwnFactoryApprovalApplicationService } from "./rework/own-factory-approval-application-service.js";
import { ExternalResponsibilityApplicationService } from "./rework/external-responsibility-application-service.js";
import { canDownloadWageAttachment } from "./wages/wage-attachment-access.js";
import { WageService } from "./wages/wage-service.js";
import { WageExportService } from "./wages/wage-export-service.js";
import { TodoService } from "./todos/service.js";
import { TodoProjectionService } from "./todos/projection-service.js";

const { Pool } = pg;
const config = loadConfig();
const database = new Pool({
  connectionString: config.databaseUrl,
  application_name: config.serviceName,
  max: 10,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
});

const authStore = new PostgresAuthStore(database, config.dingtalk.corpId);
const accessService = new AccessMasterDataService(database, config.dingtalk.corpId);
await accessService.ensureOrganizationPolicy();
const auth = new AuthService(new OfficialDingTalkProvider(config.dingtalk), authStore, config.dingtalk.corpId, config.sessionTtlSeconds * 1000, config.sessionSecret);
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
const app = buildApp({
  config,
  checkDatabase: () => checkDatabase(database),
  getAppliedSchemaHistory: () => getAppliedSchemaHistory(database),
  auth,
  access: {
    authenticate: (token) => auth.authenticate(token),
    service: accessService,
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
});
registerDatabasePoolErrorHandler(database, app.log);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "graceful shutdown started");
  await app.close();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error: unknown) {
  app.log.fatal({ err: error }, "API startup failed");
  await database.end();
  process.exitCode = 1;
}
