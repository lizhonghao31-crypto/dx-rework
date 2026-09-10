import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { SUPPLIER_BATCH_COLUMNS } from "@dx-rework/contracts";
import { registerAccessRoutes, type AccessHttpDependencies } from "../../apps/api/src/access/routes.js";
import { readSheet } from "read-excel-file/node";
import { buildWorkbook } from "../../apps/api/src/reporting/xlsx-workbook.js";
import { planSupplierBatchRow } from "../../apps/api/src/access/supplier-batch-model.js";
import type { SupplierBatchCell } from "@dx-rework/contracts";

it("uses Root-only supplier authority for template, preflight and commit, including capability-only rejection", async () => {
  let root = false;
  const preview = vi.fn().mockResolvedValue([]);
  const apply = vi.fn().mockResolvedValue({ statusCode: 200, reused: true, response: { supplierId: "fixture", version: 1, unchanged: false } });
  const app = Fastify();
  registerAccessRoutes(app, {
    authenticate: async () => ({ id: "root-fixture", displayName: "用户", businessRoles: ["owner_group"], capabilities: ["supplier_profile:write", "supplier_profile:read"] }),
    root: { isRootUser: async () => root },
    service: { previewSupplierBatch: preview, applySupplierBatchRow: apply },
  } as unknown as AccessHttpDependencies);
  const rows = [SUPPLIER_BATCH_COLUMNS.map(([, label]) => label), ["SUP_TEST"]];
  const input = { cells: ["SUP_TEST"], supplierCode: "SUP_TEST", expectedSupplierId: null, expectedVersion: null, confirmedFields: [] };
  try {
    for (const path of ["template.xlsx", "preview", "rows"]) {
      const response = await app.inject({ method: path === "template.xlsx" ? "GET" : "POST", url: `/master-data/suppliers/import/${path}`, ...(path === "preview" ? { payload: { rows } } : path === "rows" ? { payload: input } : {}) });
      expect(response.statusCode).toBe(403);
    }
    expect(preview).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    root = true;
    const template = await app.inject({ method: "GET", url: "/master-data/suppliers/import/template.xlsx" });
    expect(template.statusCode).toBe(200);
    expect(template.headers["content-type"]).toContain("spreadsheetml");
    expect((await app.inject({ method: "POST", url: "/master-data/suppliers/import/preview", payload: { rows } })).statusCode).toBe(200);
    expect(preview.mock.calls[0]![0].actorRoles).toContain("root_superuser");
    expect((await app.inject({ method: "POST", url: "/master-data/suppliers/import/rows", payload: input })).statusCode).toBe(400);
    const committed = await app.inject({ method: "POST", url: "/master-data/suppliers/import/rows", payload: input, headers: { "idempotency-key": "supplier-batch-test-key" } });
    expect(committed.statusCode).toBe(200);
    expect(committed.headers["idempotency-replayed"]).toBe("true");
    expect((await app.inject({ method: "POST", url: "/master-data/suppliers/import/preview", payload: { rows: Array.from({ length: 202 }, () => []) } })).statusCode).toBe(400);
  } finally { await app.close(); }
});

it("previews a valid 200-row workbook below 2 MB whose JSON expands beyond 1 MiB", async () => {
  const rows = [SUPPLIER_BATCH_COLUMNS.map(([, label]) => label), ...Array.from({ length: 200 }, (_, index) => [
    "", `长资料供应商${index}`, "加工厂", "启用", "联".repeat(100), "1".repeat(50), "址".repeat(500),
    "企".repeat(200), "乙".repeat(100), "人".repeat(100), "0".repeat(100), "行".repeat(200), "车缝", 500, "注".repeat(1000),
  ])];
  const workbook = buildWorkbook([{ name: "供应商录入", rows, textColumns: [10] }]);
  expect(workbook.byteLength).toBeLessThan(2 * 1024 * 1024);
  const parsed = await readSheet(workbook, "供应商录入");
  const payload = JSON.stringify({ rows: parsed });
  expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);
  const app = Fastify();
  registerAccessRoutes(app, {
    authenticate: async () => ({ id: "root-fixture", displayName: "用户", capabilities: [] }),
    root: { isRootUser: async () => true },
    service: { previewSupplierBatch: async (_actor: unknown, input: SupplierBatchCell[][]) => input.slice(1).map((row, index) => planSupplierBatchRow(row, [], `SUP_${index}`, index + 2)) },
  } as unknown as AccessHttpDependencies);
  try {
    const response = await app.inject({ method: "POST", url: "/master-data/suppliers/import/preview", payload, headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(200);
    expect(response.json().every((row: { status: string }) => row.status === "create")).toBe(true);
  } finally { await app.close(); }
});
