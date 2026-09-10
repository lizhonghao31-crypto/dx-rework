import {
  CreateSupplierSchema, ReviseSupplierSchema, SUPPLIER_BATCH_COLUMNS, SUPPLIER_REQUIRED_FIELDS,
  type CreateSupplier, type SupplierBatchApply, type SupplierBatchCell, type SupplierBatchRow,
  type SupplierBatchValue,
} from "@dx-rework/contracts";

export type SupplierBatchProfile = Omit<CreateSupplier, "changeReason"> & { supplierId: string; version: number };
export const supplierNameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
const typeNames: Record<string, CreateSupplier["supplierType"]> = {
  factory: "factory", "加工厂": "factory", embroidery_washing: "embroidery_washing", "印绣花 / 洗水厂": "embroidery_washing",
  fabric: "fabric", "面料商": "fabric", other: "other", "其他供应商": "other",
};
const blank = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
const value = (input: unknown): SupplierBatchValue => input === undefined ? null : input as SupplierBatchValue;

export function planSupplierBatchRow(cells: SupplierBatchCell[], catalog: readonly SupplierBatchProfile[], code: string, rowNumber = 2): SupplierBatchRow {
  const raw = Object.fromEntries(SUPPLIER_BATCH_COLUMNS.map(([field], index) => [field, cells[index]]));
  const text = (field: string) => String(raw[field] ?? "").trim();
  const row: SupplierBatchRow = { rowNumber, cells, supplierName: text("supplierName"), supplierCode: text("supplierCode") || code,
    supplierId: null, version: null, status: "error", message: "", changes: [] };
  const fail = (message: string, status: "error" | "conflict" = "error") => ({ ...row, status, message });
  const typeText = text("supplierType");
  const type = typeNames[typeText];
  if (typeText && !type) return fail("供应商类型无效，请使用模板说明中的类型");
  const named = catalog.filter(item => supplierNameKey(item.supplierName) === supplierNameKey(row.supplierName) && (!type || item.supplierType === type));
  let target: SupplierBatchProfile | undefined;
  if (text("supplierCode")) {
    target = catalog.find(item => item.supplierCode === text("supplierCode"));
    if (!target) return fail("供应商编码不存在，请核对；新增供应商请留空编码，由系统生成", "conflict");
    if (row.supplierName && supplierNameKey(row.supplierName) !== supplierNameKey(target.supplierName)) return fail("编码与名称不一致，请核对；更名请使用单条资料维护", "conflict");
    if (type && target.supplierType !== type) return fail("编码对应的供应商类型不一致，不能变更类型", "conflict");
  } else {
    if (!row.supplierName || !type) return fail("未填写编码时，供应商名称和类型必填");
    if (named.length > 1) return fail("名称和类型匹配多个供应商，请填写准确编码", "conflict");
    target = named[0];
  }
  if (target) Object.assign(row, { supplierId: target.supplierId, version: target.version, supplierCode: target.supplierCode, supplierName: row.supplierName || target.supplierName });
  if (!blank(raw.bankAccount) && typeof raw.bankAccount !== "string") return fail("收款账号必须为文本；请按原始账号重新填写，不能将已舍入数字转成文本");
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(text("bankAccount"))) return fail("收款账号不能使用科学计数法，请填写原始文本账号");
  const supplied: Record<string, unknown> = {};
  for (const [field] of SUPPLIER_BATCH_COLUMNS) {
    if (field === "supplierCode" || field === "supplierType" || !text(field)) continue;
    if (field === "active") {
      const state = text(field);
      if (!["启用", "停用", "是", "否", "true", "false"].includes(state)) return fail("启用状态只能填写启用或停用");
      supplied.active = ["启用", "是", "true"].includes(state);
    } else if (field === "dailyCapacity") {
      const capacity = Number(text(field));
      if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 1_000_000_000) return fail("常规日产能须为 1 至 10 亿的整数");
      supplied.dailyCapacity = capacity;
    } else if (field === "supportedCrafts") {
      const crafts = text(field).split(/[、,，]/).map(item => item.trim());
      if (crafts.some(item => !item) || new Set(crafts).size !== crafts.length) return fail("工艺不能包含空项或重复项");
      supplied.supportedCrafts = [...new Set([...(target?.supportedCrafts ?? []), ...crafts])];
    } else supplied[field] = text(field);
  }
  if (!target) {
    const missing = SUPPLIER_REQUIRED_FIELDS.filter(([field]) => blank(supplied[field])).map(([, label]) => label);
    if (missing.length) return fail(`新增供应商请填写：${missing.join("、")}`);
    const parsed = CreateSupplierSchema.safeParse({ ...supplied, supplierCode: row.supplierCode, supplierType: type, changeReason: "批量新增供应商" });
    if (!parsed.success) return fail("资料校验失败，请检查字段长度、编码格式和工艺数量");
    return { ...row, status: "create", message: "新增供应商", changes: SUPPLIER_BATCH_COLUMNS.filter(([field]) => field !== "supplierCode" && field !== "supplierType" && !blank(parsed.data[field])).map(([field, label]) => ({ field, label, before: null, after: value(parsed.data[field]), needsConfirmation: false })) };
  }
  const parsed = ReviseSupplierSchema.safeParse({ ...supplied, expectedVersion: target.version, changeReason: "批量补全供应商资料" });
  if (!parsed.success) return fail("资料校验失败，请检查字段长度和工艺数量");
  row.changes = SUPPLIER_BATCH_COLUMNS.flatMap(([field, label]) => {
    if (!(field in supplied) || JSON.stringify(supplied[field]) === JSON.stringify(target[field])) return [];
    return [{ field, label, before: value(target[field]), after: value(supplied[field]), needsConfirmation: !blank(target[field]) && field !== "supportedCrafts" }];
  });
  row.status = row.changes.some(change => change.needsConfirmation) ? "review" : row.changes.length ? "supplement" : "unchanged";
  row.message = { review: "已有值不同，请选择需要更新的字段", supplement: "补齐空字段 / 合并新增工艺", unchanged: "资料相同，无需修改" }[row.status];
  return row;
}

export function flagSupplierBatchDuplicates(rows: SupplierBatchRow[]): SupplierBatchRow[] {
  const keys = rows.map(row => [row.supplierId ? `id:${row.supplierId}` : `name:${supplierNameKey(row.supplierName)}:${typeNames[String(row.cells[2] ?? "").trim()] ?? ""}`, `code:${row.supplierCode}`]);
  const count = new Map<string, number>();
  keys.flat().forEach(key => count.set(key, (count.get(key) ?? 0) + 1));
  return rows.map((row, index) => row.status !== "error" && keys[index]!.some(key => count.get(key)! > 1)
    ? { ...row, status: "conflict", message: "同文件重复供应商，请合并为一行后重新上传" } : row);
}

export function supplierBatchPayload(row: SupplierBatchRow, input: SupplierBatchApply) {
  const fields = Object.fromEntries(row.changes.filter(change => !change.needsConfirmation || input.confirmedFields.includes(change.field)).map(change => [change.field, change.after]));
  if (row.supplierId) return ReviseSupplierSchema.parse({ ...fields, expectedVersion: row.version, changeReason: "批量补全供应商资料（含已确认差异）" });
  const type = typeNames[String(input.cells[2] ?? "").trim()];
  return CreateSupplierSchema.parse({ ...fields, supplierCode: input.supplierCode, supplierType: type, changeReason: "批量新增供应商" });
}
