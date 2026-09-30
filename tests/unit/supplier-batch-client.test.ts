import { expect, it, vi } from "vitest";
import { executeSupplierBatch, summarizeSupplierBatch, type SupplierBatchEntry } from "../../apps/web/src/supplier-batch-client.js";
import { SupplierImportRequestError } from "../../apps/web/src/supplier-import-safety.js";

const entry = (rowNumber: number): SupplierBatchEntry => ({ plan: { rowNumber, cells: [null, "工厂"], supplierCode: `SUP_${rowNumber}`, supplierName: "工厂", supplierId: null, version: null, status: "create", message: "新增", changes: [] }, confirmedFields: [] });
it("continues after definite row errors and retries only uncertain results with the original key and body", async () => {
  let rows = [entry(2), entry(3), entry(4), entry(5)];
  const update = (next: SupplierBatchEntry) => { rows = rows.map(row => row.plan.rowNumber === next.plan.rowNumber ? next : row); };
  const api = vi.fn().mockResolvedValueOnce({ version: 1, unchanged: false }).mockRejectedValueOnce(new SupplierImportRequestError("资料冲突", 409)).mockRejectedValueOnce(new Error("network failure"));
  let key = 0;
  await executeSupplierBatch(rows, api, update, () => `batch-key-${++key}`);
  expect(rows.map(row => row.result?.status)).toEqual(["success", "failed", "failed", undefined]);
  expect(rows[1]!.result!.retryable).toBe(false);
  const frozen = rows[2]!.request!;
  rows[2]!.confirmedFields.push("bankName");
  const retry = vi.fn().mockResolvedValue({ version: 1, unchanged: false });
  await executeSupplierBatch(rows, retry, update, () => `batch-key-${++key}`);
  expect(retry).toHaveBeenCalledTimes(2);
  expect(retry.mock.calls[0]).toEqual([frozen.body, frozen.key]);
  expect(frozen.body.confirmedFields).toEqual([]);
  expect(rows.map(row => row.result?.status)).toEqual(["success", "failed", "success", "success"]);
});
it("stops at permission failure and never sends unchanged or unconfirmed-only rows", async () => {
  const api = vi.fn().mockRejectedValue(new SupplierImportRequestError("无权限", 403));
  await executeSupplierBatch([entry(2), entry(3)], api, vi.fn(), () => "key");
  expect(api).toHaveBeenCalledTimes(1);
  api.mockClear();
  await executeSupplierBatch([{ ...entry(2), plan: { ...entry(2).plan, status: "unchanged" } }, { ...entry(3), plan: { ...entry(3).plan, status: "review", changes: [{ field: "bankName", label: "开户行", before: "旧", after: "新", needsConfirmation: true }] } }], api, vi.fn(), () => "key");
  expect(api).not.toHaveBeenCalled();
});
it("summarizes created, supplemented, confirmed, unchanged, failed and pending rows without hiding precheck failures", () => {
  const success = { status: "success", message: "已保存", retryable: false } as const;
  const rows: SupplierBatchEntry[] = [
    { ...entry(2), result: success },
    { ...entry(3), plan: { ...entry(3).plan, status: "supplement" }, result: success },
    { ...entry(4), plan: { ...entry(4).plan, status: "review" }, result: success },
    { ...entry(5), plan: { ...entry(5).plan, status: "unchanged" } },
    { ...entry(6), result: { status: "success", message: "无变化，已跳过", retryable: false, unchanged: true } },
    { ...entry(7), result: { status: "failed", message: "保存失败", retryable: true } },
    { ...entry(8), plan: { ...entry(8).plan, status: "conflict" } },
    { ...entry(9), plan: { ...entry(9).plan, status: "review", changes: [{ field: "bankName", label: "开户行", before: "旧", after: "新", needsConfirmation: true }] } },
  ];
  expect(summarizeSupplierBatch(rows)).toEqual({
    total: 8,
    created: 1,
    supplemented: 1,
    confirmedUpdates: 1,
    unchanged: 2,
    failed: 2,
    pending: 1,
  });
});
