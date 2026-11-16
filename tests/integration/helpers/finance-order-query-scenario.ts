import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { BasicReworkPageSchema, FinanceNodeReadSchema, ManagementReworkPageSchema } from "@dx-rework/contracts/reporting";
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
      const fullFactory=reader.role==='factory_payables';
      if(reader.types!=="all"&&!fullFactory&&batch) {
        const types=reader.types;
        expect([...batch.cases,...(batch.historicalCases??[])].every(row=>types.includes(row.responsibilityType))).toBe(true);
        expect(batch.items.every(row=>types.includes(row.responsibilityType))).toBe(true);
        expect(batch.sourceSnapshot).not.toHaveProperty("wholeOrderReview");
        expect(batch.sourceSnapshot).not.toHaveProperty("finalizedDetermination.calculationTotal");
      }
      if(reader.types!=="all"&&!fullFactory) {
        const scopedDetail=await detail.get(current,orderId);
        expect(scopedDetail).toMatchObject({canReadBusinessDetails:false,singlePieceReworkTotal:null,inspectionReport:null,
          iePrecounts:{canRecord:false,processes:[],entries:[]},defectiveQuantity:{canAddTail:false,tailEntries:[]}});
        expect(scopedDetail.workflowHistory).toEqual([]);
        expect(await detail.canDownloadBoundAttachment(current,{entityType:"rework_order",entityId:orderId,mimeType:"application/pdf"})).toBe(false);
        expect(await detail.canDownloadBoundAttachment(current,{entityType:"rework_order",entityId:orderId,mimeType:"image/jpeg"})).toBe(true);
        expect((await app.inject({url:"/management/dashboard"})).statusCode).toBe(403);
        expect((await app.inject({url:"/management/rework-orders"})).statusCode).toBe(403);
        expect((await app.inject({url:`/management/rework-orders/${orderId}/finance-nodes/process_configuration`})).statusCode).toBe(403);
      }
      if(fullFactory){
        const full=await detail.get(current,orderId);expect(full.canReadBusinessDetails).toBe(true);expect(full.workflowHistory.length).toBeGreaterThan(0);
        expect(full.iePrecounts.canRecord).toBe(false);expect(full.defectiveQuantity.canAddTail).toBe(false);
        expect(await detail.canDownloadBoundAttachment(current,{entityType:'rework_order',entityId:orderId,mimeType:'application/pdf'})).toBe(true);
        expect(await detail.canDownloadBoundAttachment(current,{entityType:'external_responsibility_case',entityId:randomUUID(),mimeType:'application/pdf'})).toBe(false);
        const result=await app.inject({url:'/management/rework-orders?q=UAT-FULL-CHAIN'});expect(result.statusCode).toBe(200);
        const rows=ManagementReworkPageSchema.parse(result.json());const found=rows.items.find(row=>row.reworkOrderId===orderId)!;expect(found).toBeTruthy();expect(found.wageAmount).toBeDefined();expect(rows.canViewReports).toBe(false);
        const factory=await app.inject({url:'/management/rework-orders?q='+encodeURIComponent(full.processingFactory!.displayName)});expect(factory.statusCode).toBe(200);expect(ManagementReworkPageSchema.parse(factory.json()).items.map(row=>row.reworkOrderId)).toContain(orderId);
        const node=await app.inject({url:`/management/rework-orders/${orderId}/finance-nodes/process_configuration`});expect(node.statusCode).toBe(200);expect(FinanceNodeReadSchema.parse(node.json()).node).toBe('process_configuration');
        for(const path of ['/management/dashboard','/management/reports/rework_overview','/management/reports/wages','/management/reports/rework_overview/export.xlsx','/management/reports/wages/export.xlsx'])expect((await app.inject({url:path})).statusCode).toBe(403);
        if(!input.beforeLedger){
          expect(full.singlePieceReworkTotal).not.toBeNull();expect((await detail.history(current,orderId,'process_configuration')).sections.length).toBeGreaterThan(0);
          const director=input.readers.find(person=>person.role==='finance_director')!;
          const directorCaps=(await database.query<{capability:string}>('SELECT capability FROM role_capabilities WHERE role_code=$1',[director.role])).rows.map(row=>row.capability);
          const baseline=await reporting.listReworkOrders({...current,actorId:director.userId,actorRoles:[director.role],authorizationCapabilities:directorCaps},{page:1,limit:15,q:'UAT-FULL-CHAIN'});
          expect(found).toEqual(baseline.items.find(row=>row.reworkOrderId===orderId));
          const same=await external.get({...current,actorId:director.userId,actorRoles:[director.role],authorizationCapabilities:directorCaps},orderId);
          expect(batch?.cases.map(row=>row.caseId)).toEqual(same?.cases.map(row=>row.caseId));
          for(const target of [...(batch?.cases??[]),...(batch?.historicalCases??[])].filter(row=>row.responsibilityType!=='processing_factory')) {
            expect(target).toMatchObject({canSign:false,canPayablesConfirm:false,canFollowUp:false,canRecordDeduction:false,canClose:false,canDecideSpecialApproval:false});
          }
        }
      }
    }
    // An unrelated role cannot turn a claimed capability into database access.
    current={actorId:input.unrelatedId,actorRoles:["worker"],authorizationCapability:"rework:finance_orders:read",authorizationCapabilities:["rework:finance_orders:read"],requestId:randomUUID()};
    expect((await app.inject({url:"/management/rework-basic-orders"})).statusCode).toBe(403);
    await expect(external.get(current,orderId)).rejects.toMatchObject({statusCode:403});
    // Caller claims cannot substitute for the persisted direct factory-payables role.
    current={...current,actorRoles:['factory_payables']};
    expect((await app.inject({url:'/management/rework-orders'})).statusCode).toBe(403);
    expect((await app.inject({url:`/management/rework-orders/${orderId}/finance-nodes/process_configuration`})).statusCode).toBe(403);
    await expect(detail.get(current,orderId)).rejects.toMatchObject({statusCode:403});
    await expect(external.get(current,orderId)).rejects.toMatchObject({statusCode:403});
    if(!input.beforeLedger) {
      const access=new AccessMasterDataService(database,"corp");
      const root={actorId:input.rootId,actorRoles:["root_superuser"],authorizationCapability:"access:admin",requestId:randomUUID()};
      for(const role of ["factory_payables","finance_read"]) {
        const predecessor=role==="factory_payables"?(await access.listRoleAssignments({userId:input.readers.find(reader=>reader.role===role)!.userId})).find(row=>row.roleCode===role&&!row.revokedAt):undefined;
        if(predecessor) await access.revokeRole(root,predecessor.assignmentId,"测试唯一应付岗位交接");
        try {
          const assignment=await access.assignRole(root,{userId:input.unrelatedId,roleCode:role,reason:"验证接岗后可以查历史"});
          current={...current,actorRoles:["worker",role]};
          try {
            expect((await app.inject({url:"/management/rework-basic-orders"})).statusCode).toBe(200);
            expect((await detail.get(current,orderId)).reworkOrderId).toBe(orderId);
            if(role==="factory_payables") expect(await detail.get(current,orderId)).toMatchObject({canReadBusinessDetails:true});
          } finally { await access.revokeRole(root,assignment.assignmentId,"验证撤销后旧页面必须失权"); }
          expect((await app.inject({url:"/management/rework-basic-orders"})).statusCode).toBe(403);
          if(role==='factory_payables'){
            expect((await app.inject({url:'/management/rework-orders'})).statusCode).toBe(403);
            expect((await app.inject({url:`/management/rework-orders/${orderId}/finance-nodes/process_configuration`})).statusCode).toBe(403);
          }
          await expect(detail.get(current,orderId)).rejects.toMatchObject({statusCode:403});
          await expect(external.get(current,orderId)).rejects.toMatchObject({statusCode:403});
        } finally { if(predecessor) await access.assignRole(root,{userId:predecessor.userId,roleCode:role,reason:"恢复业务链原测试岗位"}); }
      }
    }
  } finally { await app.close(); }
}
