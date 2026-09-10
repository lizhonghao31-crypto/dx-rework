import type { SupplierBatchApply, SupplierBatchField, SupplierBatchRow } from "@dx-rework/contracts";
import { SupplierImportRequestError } from "./supplier-import-safety.js";

export type SupplierBatchEntry = {
  plan: SupplierBatchRow;
  confirmedFields: SupplierBatchField[];
  request?: { key: string; body: SupplierBatchApply };
  result?: { status: "running" | "success" | "failed"; message: string; retryable: boolean };
};
export function canSubmitSupplierBatchEntry(entry: SupplierBatchEntry): boolean {
  if (!["create", "supplement", "review"].includes(entry.plan.status)) return false;
  if (entry.result) return entry.result.status === "failed" && entry.result.retryable;
  return entry.plan.status === "create" || entry.plan.changes.some(change => !change.needsConfirmation || entry.confirmedFields.includes(change.field));
}

export async function executeSupplierBatch(entries: readonly SupplierBatchEntry[], api: (body: SupplierBatchApply, key: string) => Promise<{ version: number; unchanged: boolean }>, update: (entry: SupplierBatchEntry) => void, makeKey: () => string): Promise<void> {
  for (const entry of entries.filter(canSubmitSupplierBatchEntry)) {
    const request = entry.request ?? { key: makeKey(), body: {
      cells: entry.plan.cells, supplierCode: entry.plan.supplierCode,
      expectedSupplierId: entry.plan.supplierId, expectedVersion: entry.plan.version,
      confirmedFields: [...entry.confirmedFields],
    } };
    update({ ...entry, request, result: { status: "running", message: "导入中", retryable: false } });
    try {
      const result = await api(request.body, request.key);
      update({ ...entry, request, result: { status: "success", message: result.unchanged ? "无变化，已跳过" : `已保存 · 版本 ${result.version}`, retryable: false } });
    } catch (error) {
      const rejected = error instanceof SupplierImportRequestError && error.status >= 400 && error.status < 500;
      const message = error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : "请求未完成或结果未确认";
      update({ ...entry, request, result: { status: "failed", message: `${message}；${rejected ? "请重新预检" : "可按原请求重试"}`, retryable: !rejected } });
      // Definite row errors do not block other valid rows. Unknown outcomes/auth failures stop this run.
      if (!rejected || (error instanceof SupplierImportRequestError && [401, 403].includes(error.status))) return;
    }
  }
}
