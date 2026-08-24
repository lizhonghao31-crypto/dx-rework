import { readFile } from "node:fs/promises";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch PR-11 detail request convergence", () => {
  it("reuses the verified session in every embedded order workspace", async () => {
    const [detail, process, work, responsibility] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/process-worker-assignment-form.tsx"),
      read("apps/web/src/work-reporting-form.tsx"),
      read("apps/web/src/responsibility-determination-panel.tsx"),
    ]);

    for (const source of [detail, process, work, responsibility]) {
      expect(source).toContain("verifySession()");
      expect(source).not.toContain('apiUrl("auth/me")');
      expect(source).not.toContain('request("auth/me"');
    }
  });

  it("passes the already-loaded order facts into the embedded N02 workspace", async () => {
    const [detail, wrapper, process] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/process-configuration-form.tsx"),
      read("apps/web/src/process-worker-assignment-form.tsx"),
    ]);

    expect(detail).toContain("initialDetail={detail}");
    expect(wrapper).toContain("initialDetail?: ProcessWorkerAssignmentDetail");
    expect(process).toContain("initialDetail?.reworkOrderId === reworkOrderId");
    expect(process).toContain(": request(`rework-orders/${reworkOrderId}/business-detail`");
  });

  it("consolidates wage settlement reads without increasing database concurrency", async () => {
    const service = await read("apps/api/src/rework/rework-business-detail-service.ts");

    expect(service).toContain("jsonb_agg(");
    expect(service).toContain("unsettled_wage_periods");
    expect(service).not.toContain("const unsettledWagePeriods = canViewWagePeriods(actor)");
    expect(service).not.toContain("Promise.all([");
  });

  it("returns visible unsettled periods in four ordered database reads", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        rework_order_id: "00000000-0000-4000-8000-000000000001",
        rework_no: "RW-PERF-001",
        status: "completed",
        version: 7,
        style_no: "STYLE-1",
        customer_supply_code: null,
        factory_style_no: null,
        order_no: null,
        order_quantity: null,
        source_receiving_actual_quantity: null,
        washing_supplier_name: null,
        embroidery_supplier_name: null,
        fabric_supplier_name: null,
        embroidery_merchandiser_name: null,
        merchandiser_user_id: null,
        merchandiser_name: null,
        processing_factory_type: null,
        processing_factory_supplier_id: null,
        supplier_name: null,
        rework_reason: null,
        rework_process: null,
        problem_part: null,
        problem_description: null,
        rework_quantity: null,
        inspection_report: null,
        created_by: "00000000-0000-4000-8000-000000000002",
        creator_name: "测试发起人",
        configuration_created_by: null,
        configuration_creator_name: null,
        created_at: new Date("2026-08-24T00:00:00.000Z"),
        updated_at: new Date("2026-08-24T01:00:00.000Z"),
        submitted_at: null,
        cancelled_at: null,
        cancel_reason: null,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        external_status: "closed",
        wage_status: "in_progress",
        unsettled_wage_periods: [{
          periodId: "00000000-0000-4000-8000-000000000003",
          periodMonth: "2026-08-01",
          status: "ready_to_lock",
        }],
      }] });
    const service = new ReworkBusinessDetailService({ query } as unknown as Pool);

    const result = await service.get({
      actorId: "00000000-0000-4000-8000-000000000004",
      actorRoles: ["root_superuser"],
      authorizationCapability: "business:read_all",
      authorizationCapabilities: ["business:read_all", "wage:view"],
      requestId: "perf-pr11-test",
    }, "00000000-0000-4000-8000-000000000001");

    expect(query).toHaveBeenCalledTimes(4);
    expect(result.unsettledWagePeriods).toEqual([{
      periodId: "00000000-0000-4000-8000-000000000003",
      periodMonth: "2026-08-01",
      status: "ready_to_lock",
    }]);
  });
});
