import type { AuthorizedUser } from "./auth.js";
export { canAccessSupplierCenter } from "./platform-modules.js";

export type SupplierSummary = Readonly<{
  supplierId: string;
  supplierCode: string;
  supplierType: "factory" | "embroidery_washing" | "fabric" | "other";
  version: number;
  supplierName: string;
  active: boolean;
  supportedCrafts: string[];
  dailyCapacity: number | null;
  contractDataMissing: string[];
}>;

export const SUPPLIER_TYPE_LABELS: Record<SupplierSummary["supplierType"], string> = {
  factory: "加工厂",
  embroidery_washing: "印绣花 / 洗水厂",
  fabric: "面料商",
  other: "其他供应商",
};

export const CONTRACT_FIELD_LABELS: Readonly<Record<string, string>> = {
  address: "供应商地址",
  contractEntityName: "合同主体名称",
  partyBRepresentative: "乙方代表",
  payeeName: "收款人",
  bankAccount: "收款账号",
  bankName: "开户行",
};

export function canWriteSupplierProfiles(user: AuthorizedUser): boolean {
  return user.isRoot === true;
}

export function supplierContractMissingLabels(fields: readonly string[]): string[] {
  return fields.map((field) => CONTRACT_FIELD_LABELS[field] ?? field);
}

export function nextSupplierSelection(
  current: string,
  suppliers: readonly Pick<SupplierSummary, "supplierId">[],
  _compact?: boolean,
): string {
  void _compact; // Kept for existing callers; refresh never chooses a record.
  if (current && suppliers.some((supplier) => supplier.supplierId === current)) return current;
  return "";
}

export function filterSupplierDirectory(
  suppliers: readonly SupplierSummary[],
  input: Readonly<{ query: string; type: "all" | SupplierSummary["supplierType"]; status: "active" | "inactive" | "all" }>,
): SupplierSummary[] {
  const query = input.query.trim().toLocaleLowerCase("zh-CN");
  return suppliers.filter((supplier) => {
    if (input.type !== "all" && supplier.supplierType !== input.type) return false;
    if (input.status === "active" && !supplier.active) return false;
    if (input.status === "inactive" && supplier.active) return false;
    if (!query) return true;
    return [
      supplier.supplierName,
      supplier.supplierCode,
      SUPPLIER_TYPE_LABELS[supplier.supplierType],
      ...supplier.supportedCrafts,
    ].join(" ").toLocaleLowerCase("zh-CN").includes(query);
  });
}

