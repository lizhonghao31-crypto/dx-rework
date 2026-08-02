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
const reworkService = new ReworkInitiationService(database, config.dingtalk.corpId);
const processConfigurationService = new ProcessConfigurationService(database);
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
    canDownloadBoundAttachment: (actor, binding) =>
      reworkService.canDownloadBoundAttachment(actor, binding),
  },
  rework: {
    authenticate: (token) => auth.authenticate(token),
    service: reworkService,
  },
  processConfiguration: {
    authenticate: (token) => auth.authenticate(token),
    service: processConfigurationService,
  },
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
