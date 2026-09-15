import Fastify from "fastify";
import { expect } from "vitest";
import type { Pool } from "pg";
import type { ReportQuery } from "@dx-rework/contracts/reporting";
import type { TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";
import type { ManagementReportingService } from "../../../apps/api/src/reporting/management-reporting-service.js";
import { registerManagementReportingRoutes } from "../../../apps/api/src/reporting/management-reporting-routes.js";
import { ReportExportService } from "../../../apps/api/src/reporting/report-export-service.js";

export async function exerciseWagePagination(input:{database:Pool;reporting:ManagementReportingService;actor:TrustedActorContext;filters:ReportQuery}) {
  const {database,reporting,actor,filters}=input;
  const app=Fastify();
  registerManagementReportingRoutes(app,{service:reporting,exportService:new ReportExportService(reporting,database,"q03-test"),
    authenticate:async()=>({id:actor.actorId,businessRoles:actor.actorRoles,capabilities:actor.authorizationCapabilities!})});
  const query=new URLSearchParams(Object.entries(filters).map(([key,value])=>[key,String(value)]));
  const seen:string[]=[];
  try {
    const previewBefore=await reporting.previewWageSettlement(actor,filters);
    for(let page=1;page<=34;page++) {
      const response=await app.inject({url:`/management/reports/wages?${query}&page=${page}`});
      expect(response.statusCode).toBe(200);
      const value=response.json();
      expect(value.pagination).toEqual({page,pageSize:15,totalPages:34,totalCount:501});
      expect(value.rows).toHaveLength(page===34?6:15);
      expect(value.truncated).toBe(false);
      expect(value.wageSummary).toMatchObject({rowCount:501,personCount:2,orderCount:1,pendingLineCount:501});
      expect(value.totals).toEqual({wageAmount:"560.00",unsettledWageAmount:"560.00",settledWageAmount:"0.00"});
      seen.push(...value.rows.map((row:{lineId:string})=>row.lineId));
      if(page===1||page===34) expect(await reporting.previewWageSettlement(actor,filters)).toEqual(previewBefore);
    }
    expect(new Set(seen).size).toBe(501);
    expect([...seen].sort()).toEqual([...previewBefore.lineIds].sort());
    const last=(await app.inject({url:`/management/reports/wages?${query}&page=999`})).json();
    expect(last.pagination.page).toBe(34);expect(last.rows.map((row:{lineId:string})=>row.lineId)).toEqual(seen.slice(-6));
    const first=(await app.inject({url:`/management/reports/wages?${query}&page=1`})).json();
    expect(first.rows.map((row:{lineId:string})=>row.lineId)).toEqual(seen.slice(0,15));
    // Paging is a read parameter. It cannot silently narrow a settlement or an export.
    expect((await app.inject({url:`/management/wages/settlement-preview?${query}&page=34`})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/management/wages/settlement",payload:{filters:{...filters,page:34},lineIds:previewBefore.lineIds}})).statusCode).toBe(400);
    expect((await app.inject({url:`/management/reports/wages/export.xlsx?${query}`})).statusCode).toBe(200);
    expect((await reporting.exportData(actor,"wages",filters)).data.rows.map(row=>row.lineId).sort()).toEqual([...seen].sort());
  }finally{await app.close();}
}
