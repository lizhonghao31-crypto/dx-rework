export class SupplierImportRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export type SupplierImportRecord = Readonly<{
  supplierId: string;
  supplierCode: string;
  supplierType: "factory" | "embroidery_washing" | "fabric" | "other";
  supplierName: string;
  active: boolean;
  version: number;
}>;

export type SupplierImportData = Readonly<{
  systemCode: string;
  supplierName: string;
  supplierType: SupplierImportRecord["supplierType"];
  active: boolean;
  supplierId?: string;
  expectedVersion?: number;
}>;

export type SupplierImportResult = Readonly<{
  status: "pending" | "running" | "succeeded" | "failed";
  message: string;
  retryable: boolean;
}>;

export type SupplierImportRow = Readonly<{
  rowNumber: number;
  action: "create" | "update" | "skip" | "error";
  supplier?: SupplierImportData;
  result?: SupplierImportResult;
}>;

export const canRunSupplierRow = (row: SupplierImportRow): boolean =>
  (row.action === "create" || row.action === "update")
  && (!row.result || row.result.status === "pending" || (row.result.status === "failed" && row.result.retryable));

export const canApplySupplierImport = (rows: readonly SupplierImportRow[], reason: string): boolean =>
  Boolean(reason.trim()) && !rows.some((row) => row.action === "error" || row.result?.status === "running")
  && rows.some(canRunSupplierRow);

type ImportApi = Readonly<{
  list: () => Promise<readonly SupplierImportRecord[]>;
  create: (data: SupplierImportData, reason: string) => Promise<unknown>;
  update: (data: SupplierImportData, reason: string) => Promise<unknown>;
}>;

const matches = (record: SupplierImportRecord, data: SupplierImportData): boolean =>
  record.supplierCode === data.systemCode && record.supplierType === data.supplierType
  && record.supplierName === data.supplierName && record.active === data.active;

/** Sequential, non-atomic execution. Stop at the first failure; never resubmit successful rows. */
export async function executeSupplierImport(
  rows: readonly SupplierImportRow[],
  reason: string,
  api: ImportApi,
  onResult: (rowNumber: number, result: SupplierImportResult) => void,
): Promise<void> {
  if (!canApplySupplierImport(rows, reason)) return;
  for (const row of rows.filter(canRunSupplierRow)) {
    const data = row.supplier;
    onResult(row.rowNumber, { status: "running", message: "执行中", retryable: false });
    let retryable = row.action === "create";
    try {
      if (!data?.systemCode) { retryable = false; throw new Error("缺少冻结的系统编码，请重新预检。"); }
      if (row.action === "create") {
        // A lost response may have followed a committed POST. Reconcile only by the
        // frozen unique code, never by a display name, before retrying that same code.
        if (row.result?.status === "failed") {
          const existing = (await api.list()).find((item) => item.supplierCode === data.systemCode);
          if (existing) {
            if (!matches(existing, data)) { retryable = false; throw new Error("该系统编码已存在且资料不一致，请重新预检核对。"); }
            onResult(row.rowNumber, { status: "succeeded", message: "已核对成功（此前请求已落库）", retryable: false });
            continue;
          }
        }
        await api.create(data, reason.trim());
      } else {
        if (!data.supplierId || data.expectedVersion === undefined) throw new Error("缺少预检对象或版本，请重新预检。");
        await api.update(data, reason.trim());
      }
      onResult(row.rowNumber, { status: "succeeded", message: "已成功", retryable: false });
    } catch (error) {
      if (error instanceof SupplierImportRequestError && error.status >= 400 && error.status < 500) retryable = false;
      const message = error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : "请求未完成或结果未确认";
      onResult(row.rowNumber, {
        status: "failed",
        message: `${message}；${retryable ? "重试前将按原编码核对，不重复创建已成功记录" : "请重新预检核对，不能直接重试此行"}。后续行尚未执行。`,
        retryable,
      });
      return;
    }
  }
}
