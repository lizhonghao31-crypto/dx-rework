import { describe, expect, it, vi } from "vitest";
import {
  SupplierImportRequestError, canApplySupplierImport, executeSupplierImport,
  type SupplierImportRecord, type SupplierImportRow,
} from "../../apps/web/src/supplier-import-safety.js";

const row = (n: number): SupplierImportRow => ({ rowNumber: n, action: "create", supplier: {
  systemCode: `FAC_FIXED_${n}`, supplierType: "factory", supplierName: `测试厂${n}`, active: true,
} });
const api = () => ({ list: vi.fn<() => Promise<SupplierImportRecord[]>>().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) });

describe("supplier import partial execution", () => {
  it("rejects empty reasons, preflight errors and batches with no actionable rows", async () => {
    const service = api();
    expect(canApplySupplierImport([row(2)], " ")).toBe(false);
    expect(canApplySupplierImport([{ ...row(2), action: "skip" }], "导入")).toBe(false);
    const invalid = [row(2), { ...row(3), action: "error" as const }];
    expect(canApplySupplierImport(invalid, "导入")).toBe(false);
    await executeSupplierImport(invalid, "导入", service, vi.fn());
    expect(service.create).not.toHaveBeenCalled();
  });

  it("keeps successes, stops on failure, and retries only unfinished rows with frozen codes", async () => {
    let rows = [row(2), row(3), row(4)];
    const service = api();
    service.create.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("网络中断"));
    const result: Parameters<typeof executeSupplierImport>[3] = (n, next) => {
      rows = rows.map((item) => item.rowNumber === n ? { ...item, result: next } : item);
    };
    await executeSupplierImport(rows, " 导入 ", service, result);
    expect(rows[0]?.result?.status).toBe("succeeded");
    expect(rows[1]?.result?.status).toBe("failed");
    expect(rows[2]?.result).toBeUndefined();
    await executeSupplierImport(rows, "导入", service, result);
    expect(service.create.mock.calls.map(([data]) => data.systemCode)).toEqual(["FAC_FIXED_2", "FAC_FIXED_3", "FAC_FIXED_3", "FAC_FIXED_4"]);
    expect(rows.every((item) => item.result?.status === "succeeded")).toBe(true);
    expect(canApplySupplierImport(rows, "导入")).toBe(false);
  });

  it("reconciles a lost create response by exact code before retry and refuses changed facts", async () => {
    const failed = { ...row(2), result: { status: "failed" as const, message: "响应丢失", retryable: true } };
    const existing: SupplierImportRecord = { supplierId: "stable-id", supplierCode: "FAC_FIXED_2", supplierType: "factory", supplierName: "测试厂2", active: true, version: 1 };
    const service = api();
    service.list.mockResolvedValue([existing]);
    const result = vi.fn();
    await executeSupplierImport([failed], "导入", service, result);
    expect(service.create).not.toHaveBeenCalled();
    expect(result).toHaveBeenLastCalledWith(2, expect.objectContaining({ status: "succeeded" }));
    service.list.mockResolvedValue([{ ...existing, supplierName: "已被修改" }]);
    await executeSupplierImport([failed], "导入", service, result);
    expect(service.create).not.toHaveBeenCalled();
    expect(result).toHaveBeenLastCalledWith(2, expect.objectContaining({ status: "failed", retryable: false }));
  });

  it("does not write when retry reconciliation itself fails", async () => {
    const service = api();
    service.list.mockRejectedValue(new Error("读取失败"));
    await executeSupplierImport([{ ...row(2), result: { status: "failed", message: "未知", retryable: true } }], "导入", service, vi.fn());
    expect(service.create).not.toHaveBeenCalled();
  });

  it("preserves the previewed stable ID/version and requires re-preview after update failure", async () => {
    const service = api();
    service.update.mockRejectedValue(new Error("供应商资料已更新，请刷新后重试"));
    let rows: SupplierImportRow[] = [{ ...row(2), action: "update", supplier: { ...row(2).supplier!, supplierId: "frozen-id", expectedVersion: 3 } }];
    await executeSupplierImport(rows, "导入", service, (n, result) => { rows = rows.map((item) => item.rowNumber === n ? { ...item, result } : item); });
    expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ supplierId: "frozen-id", expectedVersion: 3 }), "导入");
    expect(rows[0]?.result).toEqual(expect.objectContaining({ status: "failed", retryable: false }));
    expect(canApplySupplierImport(rows, "导入")).toBe(false);
    await executeSupplierImport(rows, "导入", service, vi.fn());
    expect(service.update).toHaveBeenCalledTimes(1);
  });
  it("requires re-preflight after definitive create rejection instead of repeating invalid writes", async () => {
    for (const status of [400, 401, 403, 409, 422]) {
      const service = api();
      service.create.mockRejectedValue(new SupplierImportRequestError("当前请求被拒绝", status));
      let rows = [row(2)];
      await executeSupplierImport(rows, "导入", service, (n, result) => { rows = rows.map((item) => item.rowNumber === n ? { ...item, result } : item); });
      expect(rows[0]?.result).toEqual(expect.objectContaining({ status: "failed", retryable: false }));
      expect(canApplySupplierImport(rows, "导入")).toBe(false);
      await executeSupplierImport(rows, "导入", service, vi.fn());
      expect(service.create).toHaveBeenCalledTimes(1);
    }
  });

});
