import {
  FinanceNodeParamsSchema, FinanceNodeReadSchema,
  BasicReworkPageSchema, BasicReworkQuerySchema,
  WageSettlementPreviewSchema, WageSettlementRequestSchema, WageSettlementResultSchema,
  DashboardQuerySchema,
  ManagementDashboardResponseSchema,
  ManagementReworkPageSchema,
  ManagementReworkQuerySchema,
  ReportPreviewResponseSchema,
  ReportQuerySchema,
  ReportTypeParamsSchema,
  SiteDashboardResponseSchema,
} from "@dx-rework/contracts/reporting";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ManagementReportingService } from "./management-reporting-service.js";
import type { ReportExportService } from "./report-export-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((value) => value.trim())
  .find((value) => value.startsWith("dx_rework_session="))
  ?.slice(18);

const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  return result.data;
};

export type ManagementReportingHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: ManagementReportingService;
  exportService: ReportExportService;
  root?: RootAuthority;
}>;

export function registerManagementReportingRoutes(
  app: FastifyInstance,
  dependencies: ManagementReportingHttpDependencies,
): void {
  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    return businessActor(dependencies.root, user, request.id, capability);
  };

  app.get("/management/wages/settlement-preview", async (request,reply) => {
    reply.header("cache-control","no-store");
    return WageSettlementPreviewSchema.parse(await dependencies.service.previewWageSettlement(
      await actor(request,"wage:settlement_mark"),parse(ReportQuerySchema,request.query)));
  });
  app.post("/management/wages/settlement", {bodyLimit: 8 * 1024 * 1024}, async request => {
    const input=parse(WageSettlementRequestSchema,request.body);
    return WageSettlementResultSchema.parse(await dependencies.service.markWageSettlement(
      await actor(request,"wage:settlement_mark"),input.filters,input.lineIds));
  });

  app.get("/management/rework-orders/:reworkOrderId/finance-nodes/:node", async (request,reply) => {
    const {reworkOrderId,node}=parse(FinanceNodeParamsSchema,request.params);
    reply.header("cache-control","no-store");
    return FinanceNodeReadSchema.parse(await dependencies.service.financeNode(
      await actor(request,"rework:finance_nodes:read"),reworkOrderId,node));
  });

  app.get("/management/rework-basic-orders", async (request,reply) => {
    reply.header("cache-control","no-store");
    return BasicReworkPageSchema.parse(await dependencies.service.listBasicRework(
      await actor(request,"rework:basic:view"),parse(BasicReworkQuerySchema,request.query)));
  });

  app.get("/management/workflow-analysis", async (request,reply) => {
    const reader = await actor(request,"dashboard:management:read");
    reply.header("cache-control","no-store");
    return dependencies.service.workflowAnalysis(reader,request.query);
  });

  app.get("/management/dashboard", async (request) => ManagementDashboardResponseSchema.parse(
    await dependencies.service.managementDashboard(
      await actor(request, "dashboard:management:read"),
      parse(DashboardQuerySchema, request.query),
    ),
  ));

  app.get("/site/dashboard", async (request) => SiteDashboardResponseSchema.parse(
    await dependencies.service.siteDashboard(
      await actor(request, "dashboard:site:read"),
      parse(DashboardQuerySchema, request.query),
    ),
  ));

  app.get("/management/rework-orders", async (request) => ManagementReworkPageSchema.parse(
    await dependencies.service.listReworkOrders(
      await actor(request, "report:view"),
      parse(ManagementReworkQuerySchema, request.query),
    ),
  ));

  app.get("/management/reports/:reportType", async (request) => {
    const { reportType } = parse(ReportTypeParamsSchema, request.params);
    return ReportPreviewResponseSchema.parse(await dependencies.service.report(
      await actor(request, "report:view"),
      reportType,
      parse(ReportQuerySchema, request.query),
    ));
  });

  app.get("/management/reports/:reportType/export.xlsx", async (request, reply) => {
    const { reportType } = parse(ReportTypeParamsSchema, request.params);
    const result = await dependencies.exportService.export(
      await actor(request, reportType === "wages" ? "wage:export" : "report:export"),
      reportType,
      parse(ReportQuerySchema, request.query),
    );
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .send(result.content);
  });
}
