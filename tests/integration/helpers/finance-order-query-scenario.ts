import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { BasicReworkPageSchema } from "@dx-rework/contracts/reporting";
import { ManagementReportingService } from "../../../apps/api/src/reporting/management-reporting-service.js";
import { registerManagementReportingRoutes } from "../../../apps/api/src/reporting/management-reporting-routes.js";
import { ReportExportService } from "../../../apps/api/src/reporting/report-export-service.js";
import { ReworkBusinessDetailService } from "../../../apps/api/src/rework/rework-business-detail-service.js";
import type { ExternalResponsibilityApplicationService } from "../../../apps/api/src/rework/external-responsibility-application-service.js";
import type { TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";
import { AccessMasterDataService } from "../../../apps/api/src/access/service.js";

export async function exerciseFinanceOrderQueries(input: {
  database: Pool; orderId: string; external: ExternalResponsibilityApplicationService;
  readers: Array<{userId: string; role: string; types: string[] | "all"}>;
  unrelatedId: string; beforeLedger: boolean; rootId: string;
}): Promise<void> {
  const {database,orderId,external}=input;
  const reporting=new ManagementReportingService(database);
  const detail=new ReworkBusinessDetailService(database);
  let current: TrustedActorContext;
  const app=Fastify();
  registerManagementReportingRoutes(app,{service:reporting,exportService:new ReportExportService(reporting,database,"q01-test"),
    authenticate:async()=>({id:current.actorId,businessRoles:current.actorRoles,capabilities:current.authorizationCapabilities!})});
  try {
    for (const reader of input.readers) {
      const capabilities=(await database.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code=$1",[reader.role])).rows.map(row=>row.capability);
      expect(capabilities).toContain("rework:finance_orders:read");
      current={actorId:reader.userId,actorRoles:[reader.role],authorizationCapability:"rework:finance_orders:read",authorizationCapabilities:capabilities,requestId:randomUUID()};
      const response=await app.inject({url:"/management/rework-basic-orders?q=UAT-FULL-CHAIN&page=999"});
      expect(response.statusCode).toBe(200);
      const page=BasicReworkPageSchema.parse(response.json());
      expect(page.items.map(row=>row.reworkOrderId)).toContain(orderId);
      expect(page.page).toBe(page.totalPages);
      expect(page.canOpenOrder).toBe(true);
      expect(page.items.every(row=>!("wageAmount" in row)&&!("externalProposedAmount" in row))).toBe(true);
      expect((await detail.get(current,orderId)).reworkOrderId).toBe(orderId);
      const batch=await external.get(current,orderId);
      if(input.beforeLedger) expect(batch).toBeNull();
      if(reader.types!=="all"&&batch) {
        const types=reader.types;
        expect([...batch.cases,...(batch.historicalCases??[])].every(row=>types.includes(row.responsibilityType))).toBe(true);
        expect(batch.items.every(row=>types.includes(row.responsibilityType))).toBe(true);
        expect(batch.sourceSnapshot).not.toHaveProperty("wholeOrderReview");
        expect(batch.sourceSnapshot).not.toHaveProperty("finalizedDetermination.calculationTotal");
      }
      if(reader.types!=="all") {
        expect((await detail.get(current,orderId)).workflowHistory).toEqual([]);
        expect((await app.inject({url:"/management/dashboard"})).statusCode).toBe(403);
      }
    }
    // An unrelated role cannot turn a claimed capability into database access.
    current={actorId:input.unrelatedId,actorRoles:["worker"],authorizationCapability:"rework:finance_orders:read",authorizationCapabilities:["rework:finance_orders:read"],requestId:randomUUID()};
    expect((await app.inject({url:"/management/rework-basic-orders"})).statusCode).toBe(403);
    await expect(external.get(current,orderId)).rejects.toMatchObject({statusCode:403});
    if(!input.beforeLedger) {
      const access=new AccessMasterDataService(database,"corp");
      const root={actorId:input.rootId,actorRoles:["root_superuser"],authorizationCapability:"access:admin",requestId:randomUUID()};
      for(const role of ["factory_payables","finance_read"]) {
        const predecessor=role==="factory_payables"?(await access.listRoleAssignments({userId:input.readers.find(reader=>reader.role===role)!.userId})).find(row=>row.roleCode===role&&!row.revokedAt):undefined;
        if(predecessor) await access.revokeRole(root,predecessor.assignmentId,"测试唯一应付岗位交接");
        try {
          const assignment=await access.assignRole(root,{userId:input.unrelatedId,roleCode:role,reason:"验证接岗后可以查历史"});
          current={...current,actorRoles:[role]};
          try {
            expect((await app.inject({url:"/management/rework-basic-orders"})).statusCode).toBe(200);
            expect((await detail.get(current,orderId)).reworkOrderId).toBe(orderId);
          } finally { await access.revokeRole(root,assignment.assignmentId,"验证撤销后旧页面必须失权"); }
          expect((await app.inject({url:"/management/rework-basic-orders"})).statusCode).toBe(403);
          await expect(detail.get(current,orderId)).rejects.toMatchObject({statusCode:403});
          await expect(external.get(current,orderId)).rejects.toMatchObject({statusCode:403});
        } finally { if(predecessor) await access.assignRole(root,{userId:predecessor.userId,roleCode:role,reason:"恢复业务链原测试岗位"}); }
      }
    }
  } finally { await app.close(); }
}
