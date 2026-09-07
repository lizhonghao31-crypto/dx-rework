import {describe, expect, it, vi} from "vitest";
import {ReceivingAnalysisQuerySchema} from "@dx-rework/contracts";
import type {Pool} from "pg";
import {readReceivingAnalysis} from "../../apps/api/src/receiving/receiving-analysis.js";
describe("receiving analysis validation and authorization", () => {
  it.each([{startDate:"2026-02-30",endDate:"2026-03-01"},{startDate:"2026-09-07",endDate:"2026-09-01"},
    {startDate:"2026-09-01",endDate:"2026-09-07",page:0},{startDate:"2026-09-01",endDate:"2026-09-07",export:true}])("rejects invalid filters %j", value => {
    expect(ReceivingAnalysisQuerySchema.safeParse(value).success).toBe(false);
  });
  it("rejects no business role before query validation and database connection", async () => {
    const connect = vi.fn();
    await expect(readReceivingAnalysis({connect} as unknown as Pool, "", {actorId:"id",actorRoles:[],authorizationCapability:"receiving:read",requestId:"request"}, {})).rejects.toMatchObject({statusCode:403});
    expect(connect).not.toHaveBeenCalled();
  });
  it("returns a validation error for authorized readers without executing SQL", async () => {
    const connect = vi.fn();
    await expect(readReceivingAnalysis({connect} as unknown as Pool, "", {actorId:"id",actorRoles:["warehouse_receiver"],authorizationCapability:"receiving:read",requestId:"request"}, {})).rejects.toMatchObject({statusCode:400});
    expect(connect).not.toHaveBeenCalled();
  });
});
