import {ProductionReadinessService} from './production-platform/production-readiness-service.js';
import {SeriesPlanService} from './production-platform/series-plan-service.js';
import {ShortLeadService} from './production-platform/short-lead-service.js';
import { SourcingTransferContractReconciliation } from "./sourcing/sourcing-transfer-contract-reconciliation.js";
import { DigitalJourneyQuery } from "./production-platform/journey-query.js";
import { DigitalAnalysisQuery } from "./production-platform/reporting-query.js";
import { DigitalCockpitQuery } from "./production-platform/cockpit-query.js";
import {OrderClosureService} from "./production-platform/order-closure-service.js";
import { BulkPreparationService } from "./production-platform/bulk-preparation-service.js";
import { ProductionInstructionService } from "./production-platform/production-instruction-service.js";
import { AcceptanceObjectStorage, registerAcceptanceStorageRoutes } from "./tools/acceptance-storage.js";
import {DevelopmentRoundService} from "./production-platform/development-round-service.js";
import { DevelopmentExecutionService } from "./production-platform/development-execution-service.js";
import { DigitalDevelopmentService } from "./production-platform/development-service.js";
import {DigitalQuotationService} from './production-platform/quotation-service.js';
import { DigitalBudgetService } from "./production-platform/budget-service.js";
import { DigitalProductionNotificationService } from "./production-platform/notification-service.js";
import { DigitalNotificationRuntime } from "./production-platform/notification-runtime.js";
import { DigitalProductionTaskService } from "./production-platform/task-service.js";
import { DigitalProductionAccessService } from "./production-platform/access-service.js";
import {FactoryFlowService} from "./production-platform/factory-flow-service.js";
import { DigitalProductionIdentityService } from "./production-platform/identity-service.js";
import { SupplierOnboardingService } from "./access/supplier-onboarding-service.js";
import { PatternRoomPriceService } from "./pattern-room/price-service.js";
import { PatternRoomOrderService } from "./pattern-room/order-service.js";
import { CuttingService } from "./cutting/cutting-source-service.js";
import {recordOperationDiagnostic} from "./platform/operation-diagnostics.js";
import {SampleImportService} from "./samples/sample-import-service.js";
import {SampleDisposalService} from "./samples/sample-disposal-service.js";
import { ProductionClosureService } from "./sourcing/production-closure-service.js";
import { SampleWorkflowService } from "./samples/sample-workflow-service.js";
import { SampleReadService } from "./samples/sample-read-service.js";
import { SampleCreateService } from "./samples/sample-create-service.js";
import { SampleAttachmentService } from "./samples/sample-attachments.js";
import { ROOT_ACTOR_ROLE } from "./access/business-authority.js";
import { ProductionDashboardService } from "./sourcing/production-dashboard-service.js";
import { ProductionReportingService } from "./sourcing/production-reporting-service.js";
import { SourcingProductionService } from "./sourcing/sourcing-production-service.js";
import { loadConfig } from "@dx-rework/config";
import pg from "pg";

import { EmployeeAccessService } from "./access/employee-access-service.js";
import { RootAuthority } from "./access/root-authority.js";
import { WorkerAwareAccessMasterDataService } from "./access/worker-aware-access-service.js";
import {AuxiliaryCatalogService} from './access/auxiliary-catalog-service.js';
import { AdminAuditService } from "./admin-audit-service.js";
import { AdminConsoleService } from "./admin-console-service.js";
import { buildApp } from "./app.js";
import { AcceptanceDingTalkProvider } from "./auth/acceptance-provider.js";
import {verifyAcceptanceClockServer,type AcceptanceServerProof} from './acceptance-clock/guard.js';
import {AcceptanceClockRuntime} from './acceptance-clock/runtime.js';
import { OfficialDingTalkProvider } from "./auth/provider.js";
import { PostgresAuthStore } from "./auth/postgres-store.js";
import { AuthService } from "./auth/service.js";
import {
  checkDatabase,
  getAppliedSchemaHistory,
  registerDatabasePoolErrorHandler,
} from "./platform/database.js";
import { RuntimeOperationalMonitor } from "./platform/runtime-observability.js";
import { ReceivingService } from "./receiving/receiving-service.js";
import { SourcingService } from "./sourcing/sourcing-service.js";
import { SourcingContractService } from "./sourcing/sourcing-contract-service.js";
import { SourcingContractReturnService } from "./sourcing/sourcing-contract-return-service.js";
import { ManagementReportingService } from "./reporting/management-reporting-service.js";
import { ReportExportService } from "./reporting/report-export-service.js";
import { BusinessAwareWholeOrderReviewService } from "./rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "./rework/external-responsibility-application-service.js";
import { OwnFactoryApprovalApplicationService } from "./rework/own-factory-approval-application-service.js";
import { ProcessConfigurationService } from "./rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "./rework/process-worker-plan-service.js";
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
let acceptanceClockProof:AcceptanceServerProof|undefined;
if (config.acceptanceLab.enabled) {
  try {
    acceptanceClockProof=await verifyAcceptanceClockServer(database,config.databaseUrl);
  } catch (error) {
    await database.end();
    throw error;
  }
}

const acceptanceClock = acceptanceClockProof && config.digitalProduction?.enabled
  ? new AcceptanceClockRuntime(database, acceptanceClockProof, config.acceptanceLab.secret!, config.digitalProduction.creationEnabled)
  : undefined;
const rootAuthority = new RootAuthority(
  database,
  config.dingtalk.corpId,
  config.rootDingtalkUserId,
);
const authStore = new PostgresAuthStore(
  database,
  config.dingtalk.corpId,
  config.rootDingtalkUserId,
);
const accessService = new WorkerAwareAccessMasterDataService(database, config.dingtalk.corpId);
await accessService.ensureOrganizationPolicy();
await rootAuthority.assertConfigurationConsistency();
const dingtalkProvider = config.acceptanceLab.enabled
  ? new AcceptanceDingTalkProvider(
      database,
      config.dingtalk.corpId,
      config.acceptanceLab.secret!,
    )
  : new OfficialDingTalkProvider(config.dingtalk);
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
  config.rootDingtalkUserId,
);
const acceptanceStorage = config.acceptanceLab.enabled
  ? new AcceptanceObjectStorage("/opt/dx-rework-acceptance/shared/attachments",
      new URL(`${config.appBasePath}api`, config.dingtalk.qrRedirectUri).href.replace(/\/$/, ""),
      config.acceptanceLab.secret!)
  : undefined;
const storage = acceptanceStorage ?? (config.objectStorage.enabled
  ? new AliyunPrivateObjectStorage(new AliyunOssV4RestClient({
      region: config.objectStorage.region!,
      endpoint: config.objectStorage.endpoint!,
      bucket: config.objectStorage.bucket!,
      accessKeyId: config.objectStorage.accessKeyId!,
      accessKeySecret: config.objectStorage.accessKeySecret!,
    }))
  : new DisabledObjectStorage());
const attachments = new AttachmentService(database, storage, {
  prefix: config.objectStorage.privatePrefix,
  ttlSeconds: config.objectStorage.signedUrlTtlSeconds,
  maxUploadBytes: config.objectStorage.maxUploadBytes,
});
const productionClosure = new ProductionClosureService(database,rootAuthority);
const sampleFiles = new SampleAttachmentService(database);
const digitalNotifications = config.digitalProduction?.enabled ? new DigitalProductionNotificationService(database) : undefined;
const todoService = new TodoService(database,undefined,undefined,productionClosure,digitalNotifications);
const todoProjection = new RootAwareTodoProjectionService(todoService);
const patternOrders = new PatternRoomOrderService(database, todoProjection);
const cuttingService = new CuttingService(database);
const receivingService = new ReceivingService(database,undefined,undefined,productionClosure,{allowLegacyStyleInput:true});
const sourcingProductionService = new SourcingProductionService(database);
const sourcingContractService = new SourcingContractService(database, attachments,undefined,undefined,todoProjection);
await sourcingContractService.resumePendingContracts();
const sourcingService = new SourcingService(
  database,undefined,undefined,todoProjection,sourcingContractService,
  (diagnostic): void => { app.log.warn({ factoryChangeFailure: diagnostic }, "factory change request failed"); },
);
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
const processConfigurationService = new ProcessConfigurationService(
  database,
  undefined,
  undefined,
  undefined,
  todoProjection,
);
const processWorkerPlanService = new ProcessWorkerPlanService(database);
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
  ...(acceptanceClock ? { acceptanceClock } : {}),
  ...(config.digitalProduction?.enabled ? { digitalIdentity: { readinessService:new ProductionReadinessService(database),seriesPlans:new SeriesPlanService(database,config.sessionSecret),shortLead:new ShortLeadService(database),analysis:new DigitalAnalysisQuery(database), cockpit:new DigitalCockpitQuery(database), journeys:new DigitalJourneyQuery(database), closureService:new OrderClosureService(database), factoryFlowService:new FactoryFlowService(database), bulkPreparationService: new BulkPreparationService(database), instructionService: new ProductionInstructionService(database, config.digitalProduction.creationEnabled), budgetService: new DigitalBudgetService(database, config.digitalProduction.creationEnabled), quotationService:new DigitalQuotationService(database,config.digitalProduction.creationEnabled), ...(config.todoRuntime.publicBaseUrl ? { developmentQrBase: new URL(config.todoRuntime.publicBaseUrl).origin + config.appBasePath } : {}), developmentRounds:new DevelopmentRoundService(database,config.digitalProduction.creationEnabled), developmentExecution: new DevelopmentExecutionService(database, config.digitalProduction.creationEnabled, patternOrders,config.sessionSecret), developmentService: new DigitalDevelopmentService(database, config.digitalProduction.creationEnabled, patternOrders), developmentAttachments: attachments, ...(digitalNotifications ? { notificationService: digitalNotifications } : {}), taskService: new DigitalProductionTaskService(database,config.sessionSecret), accessService: new DigitalProductionAccessService(database), authenticate: (token: string | undefined) => auth.authenticate(token), root: rootAuthority, service: new DigitalProductionIdentityService(database, config.digitalProduction.creationEnabled, sourcingService), creationEnabled: config.digitalProduction.creationEnabled } } : {}),
  operationDiagnostics: (row) => recordOperationDiagnostic(database,row),
  config,
  checkDatabase: () => checkDatabase(database),
  getAppliedSchemaHistory: () => getAppliedSchemaHistory(database),
  auth,
  access: {
    auxiliaryCatalog:new AuxiliaryCatalogService(database,rootAuthority),
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
  cutting: {
    authenticate: (token) => auth.authenticate(token),
    service: cuttingService,
    attachments,
    root: rootAuthority,
  },
  samples: {
    authenticate: (token) => auth.authenticate(token),
    service: new SampleReadService(database),
    root: rootAuthority,
  },
  sampleImport: { authenticate: token => auth.authenticate(token), root: rootAuthority, service: new SampleImportService(database, config.dingtalk.corpId, new SampleDisposalService(database, config.dingtalk.corpId, todoProjection)) },
  sampleDisposal: { authenticate: token => auth.authenticate(token), root: rootAuthority, service: new SampleDisposalService(database, config.dingtalk.corpId, todoProjection) },
  sampleWorkflow: {
    authenticate: token => auth.authenticate(token), root: rootAuthority,
    service: new SampleWorkflowService(database, config.dingtalk.corpId, config.todoRuntime.publicBaseUrl ?? "", todoProjection),
  },
  sampleCreation: {
    authenticate: token => auth.authenticate(token), root: rootAuthority,
    service: new SampleCreateService(database, config.dingtalk.corpId), files: sampleFiles, attachments,
  },
  sourcing: {
    authenticate: (token) => auth.authenticate(token),
    service: sourcingService,
    contracts: sourcingContractService,
    contractReturns: new SourcingContractReturnService(database),
    production: sourcingProductionService,
    reporting: new ProductionReportingService(database,undefined,undefined,productionClosure),
    closure: productionClosure,
    dashboard: new ProductionDashboardService(database, new ProductionReportingService(database)),
    root: rootAuthority,
  },
  tools: {
    authenticate: (token) => auth.authenticate(token),
    attachments,
    exports: new ExportJobService(database),
    canDownloadBoundAttachment: async (actor, binding) => {
      const isRoot=await rootAuthority.isRootUser(actor.actorId);
      const effectiveRoles=isRoot && !actor.actorRoles.includes(ROOT_ACTOR_ROLE)
        ? [...actor.actorRoles,ROOT_ACTOR_ROLE]
        : actor.actorRoles;
      if (binding.entityType === "pattern_room_attachment") return patternOrders.canDownload({
        actorId: actor.actorId, actorRoles: effectiveRoles,
        authorizationCapability: "pattern_room:orders:view", authorizationCapabilities: actor.capabilities, requestId: "pattern-attachment-download",
      }, binding);
      if (binding.entityType === "sample_attachment") return sampleFiles.canDownload({
        actorId: actor.actorId, actorRoles: effectiveRoles,
        authorizationCapability: "sample:view_basic", authorizationCapabilities: actor.capabilities, requestId: "sample-attachment-download",
      }, binding);
      if (binding.entityType === "receiving_difference_resolution") {
        return binding.mimeType.startsWith("image/") && effectiveRoles.length > 0;
      }
      if (isRoot && binding.mimeType.startsWith("image/")
        && (binding.entityType === "rework_order" || binding.entityType === "receiving_batch")) return true;
      if (sourcingService.canDownloadBoundAttachment({
        actorId: actor.actorId,
        actorRoles: actor.actorRoles,
        authorizationCapability: "sourcing:view",
        authorizationCapabilities: actor.capabilities,
        requestId: "sourcing-attachment-download",
      }, binding)) return true;
      const businessReader = {
        actorId: actor.actorId,
        actorRoles: effectiveRoles,
        authorizationCapability: "tools:user",
        authorizationCapabilities: actor.capabilities,
        requestId: "attachment-download",
      };
      if(binding.entityType==='digital_preparation'){
        if(!isRoot&&!actor.capabilities.includes('digital_production:view'))return false;
        const order=(await database.query('SELECT 1 FROM digital_production_orders WHERE production_order_id=$1',[binding.entityId])).rowCount;
        return new ProductionReadinessService(database).canDownload(businessReader,{kind:order?'order':'source',id:binding.entityId},binding.attachmentId);
      }
      if (await receivingService.canDownloadBoundAttachment(businessReader, binding)) return true;
      if (await reportingService.canDownloadBasicReworkAttachment(businessReader, binding)) return true;
      if (await reworkBusinessDetailService.canDownloadBoundAttachment(businessReader, binding)) return true;
      if (await reworkService.canDownloadBoundAttachment({ ...actor, actorRoles: effectiveRoles }, binding)) return true;
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
  },
  processConfiguration: {
    authenticate: (token) => auth.authenticate(token),
    service: processConfigurationService,
    workerPlan: processWorkerPlanService,
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
  supplierOnboarding: { authenticate: token => auth.authenticate(token), root: rootAuthority, service: new SupplierOnboardingService(database, todoService) },
  patternRoomPrices: { authenticate: (token) => auth.authenticate(token), service: new PatternRoomPriceService(database), root: rootAuthority },
  patternRoomOrders: { authenticate: (token) => auth.authenticate(token), service: patternOrders, attachments, root: rootAuthority },
  wages: {
    authenticate: (token) => auth.authenticate(token),
    service: wageService,
    exportService: new WageExportService(database),
    root: rootAuthority,
  },
  todos: { authenticate: (token) => auth.authenticate(token), service: todoService,
    root:rootAuthority,transferContractReconciliation:new SourcingTransferContractReconciliation(database) },
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

const digitalNotificationRuntime = digitalNotifications ? new DigitalNotificationRuntime(digitalNotifications, app.log, config.digitalProduction?.notificationIntervalMs) : undefined;
const runtimeOperationalMonitor = new RuntimeOperationalMonitor(database, app.log);

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

if (acceptanceStorage) registerAcceptanceStorageRoutes(app, acceptanceStorage);

const ATTACHMENT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let attachmentCleanupTimer: ReturnType<typeof setInterval> | undefined;
const runAttachmentCleanup = async (): Promise<void> => {
  try {
    const result = await attachments.cleanupExpiredUnbound();
    if (result.candidates > 0) {
      app.log.info({ attachmentCleanup: result }, "expired unbound attachment cleanup completed");
    }
  } catch {
    app.log.warn("expired unbound attachment cleanup failed");
  }
};

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "graceful shutdown started");
  if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
  await runtimeOperationalMonitor.stop();
  await todoRuntime.stop();
  await digitalNotificationRuntime?.stop();
  await app.close();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
  runtimeOperationalMonitor.start();
  todoRuntime.start();
  digitalNotificationRuntime?.start();
  void runAttachmentCleanup();
  attachmentCleanupTimer = setInterval(
    () => void runAttachmentCleanup(),
    ATTACHMENT_CLEANUP_INTERVAL_MS,
  );
  attachmentCleanupTimer.unref();
} catch (error: unknown) {
  app.log.fatal({ err: error }, "API startup failed");
  await runtimeOperationalMonitor.stop();
  await todoRuntime.stop();
  await digitalNotificationRuntime?.stop();
  await database.end();
  process.exitCode = 1;
}
