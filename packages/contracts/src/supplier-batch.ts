import { z } from "zod";

export const SUPPLIER_BATCH_COLUMNS = [
  ["supplierCode", "供应商编码"], ["supplierName", "供应商名称"], ["supplierType", "供应商类型"],
  ["active", "启用状态"], ["contactPerson", "联系人"], ["contactPhone", "联系电话"],
  ["address", "地址"], ["contractEntityName", "合同主体"], ["partyBRepresentative", "乙方代表"],
  ["payeeName", "收款人"], ["bankAccount", "收款账号"], ["bankName", "开户行"],
  ["supportedCrafts", "可承接工艺"], ["dailyCapacity", "常规日产能"], ["notes", "备注"],
] as const;
export type SupplierBatchField = typeof SUPPLIER_BATCH_COLUMNS[number][0];
export const SUPPLIER_REQUIRED_FIELDS = [
  ["supplierName", "供应商名称"], ["contactPerson", "联系人"], ["contactPhone", "联系电话"],
  ["address", "地址"], ["payeeName", "收款人"], ["bankAccount", "收款账号"],
  ["bankName", "开户行"], ["supportedCrafts", "可承接工艺"],
] as const;
const Cell = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const Cells = z.array(Cell).max(SUPPLIER_BATCH_COLUMNS.length);
export const SupplierBatchPreviewSchema = z.object({ rows: z.array(Cells).min(2).max(201) }).strict();
export const SupplierBatchApplySchema = z.object({
  cells: Cells,
  supplierCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/),
  expectedSupplierId: z.string().uuid().nullable(),
  expectedVersion: z.number().int().positive().nullable(),
  confirmedFields: z.array(z.enum(SUPPLIER_BATCH_COLUMNS.map(([field]) => field))).max(15),
}).strict();
export type SupplierBatchCell = z.infer<typeof Cell>;
export type SupplierBatchApply = z.infer<typeof SupplierBatchApplySchema>;
export type SupplierBatchValue = string | number | boolean | string[] | null;
export type SupplierBatchChange = {
  field: SupplierBatchField; label: string; before: SupplierBatchValue; after: SupplierBatchValue; needsConfirmation: boolean;
};
export type SupplierBatchRow = {
  rowNumber: number; cells: SupplierBatchCell[]; supplierName: string; supplierCode: string;
  supplierId: string | null; version: number | null;
  status: "create" | "supplement" | "review" | "unchanged" | "conflict" | "error";
  message: string; changes: SupplierBatchChange[];
};
