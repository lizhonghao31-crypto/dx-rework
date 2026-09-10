import { describe, expect, it } from "vitest";
import { readSheet } from "read-excel-file/node";
import { SUPPLIER_BATCH_COLUMNS, type SupplierBatchApply, type SupplierBatchCell, type SupplierBatchField } from "@dx-rework/contracts";
import { flagSupplierBatchDuplicates, planSupplierBatchRow, supplierBatchPayload, type SupplierBatchProfile } from "../../apps/api/src/access/supplier-batch-model.js";
import { supplierBatchTemplate } from "../../apps/api/src/access/supplier-batch-template.js";
import { buildWorkbook } from "../../apps/api/src/reporting/xlsx-workbook.js";

const cells = (values: Partial<Record<SupplierBatchField, SupplierBatchCell>>) => SUPPLIER_BATCH_COLUMNS.map(([field]) => values[field] ?? null);
const profile: SupplierBatchProfile = { supplierId: "aaf9f86d-a009-493e-929e-8da4c672e131", supplierCode: "SUP_EXISTING", supplierName: "达兴加工厂", supplierType: "factory", version: 3, active: false, supportedCrafts: ["车缝"], contactPerson: "原联系人", dailyCapacity: 500 };
const complete = { supplierName: "新工厂", supplierType: "加工厂", contactPerson: "张三", contactPhone: "01012345678", address: "工业路 1 号", payeeName: "新工厂", bankAccount: "001234567890123456789", bankName: "开户行", supportedCrafts: "车缝" };
const plan = (values: Partial<Record<SupplierBatchField, SupplierBatchCell>>, catalog = [profile]) => planSupplierBatchRow(cells(values), catalog, "SUP_NEW");
const body = (row: ReturnType<typeof plan>, confirmedFields: SupplierBatchField[] = []): SupplierBatchApply => ({ cells: row.cells, supplierCode: row.supplierCode, expectedSupplierId: row.supplierId, expectedVersion: row.version, confirmedFields });

describe("supplier batch identity and merge rules", () => {
  it("creates complete new suppliers while keeping account text and existing single-entry requirements", () => {
    const row = plan(complete);
    expect(row.status).toBe("create");
    expect(supplierBatchPayload(row, body(row))).toMatchObject({ supplierCode: "SUP_NEW", bankAccount: complete.bankAccount, active: true });
    expect(plan({ supplierName: "新工厂", supplierType: "加工厂" }).message).toContain("联系人");
  });
  it("matches code first and permits partial supplementation without clearing blank state or capacity", () => {
    const row = plan({ supplierCode: profile.supplierCode, contactPhone: "13800000000", active: "", dailyCapacity: null });
    expect(row).toMatchObject({ status: "supplement", supplierId: profile.supplierId, version: 3 });
    expect(supplierBatchPayload(row, body(row))).toEqual({ expectedVersion: 3, contactPhone: "13800000000", changeReason: expect.any(String) });
  });
  it("uses normalized name and type only for a unique match", () => {
    expect(plan({ supplierName: " 达兴加工厂 ", supplierType: "加工厂", address: "新地址" }).supplierId).toBe(profile.supplierId);
    expect(plan({ supplierName: profile.supplierName, supplierType: "factory" }, [profile, { ...profile, supplierId: "another", supplierCode: "SUP_OTHER" }]).status).toBe("conflict");
    expect(plan({ supplierName: profile.supplierName }).status).toBe("error");
    expect(plan({ ...complete, supplierName: "达兴 加工厂" }).status).toBe("create");
  });
  it("rejects conflicting codes and immutable types", () => {
    expect(plan({ ...complete, supplierCode: "SUP_TYPO" }).status).toBe("conflict");
    expect(plan({ supplierCode: profile.supplierCode, supplierName: "未在目录中的任意名称" }).status).toBe("conflict");
    expect(plan({ supplierCode: profile.supplierCode, supplierName: ` ${profile.supplierName} ` }).status).toBe("unchanged");
    expect(plan({ ...complete, supplierCode: "SUP_WRONG", supplierName: profile.supplierName }).status).toBe("conflict");
    expect(plan({ supplierCode: profile.supplierCode, supplierType: "面料商" }).status).toBe("conflict");
  });
  it("preserves old values unless that field is checked, and merges crafts automatically", () => {
    const row = plan({ supplierCode: profile.supplierCode, contactPerson: "新联系人", address: "补齐地址", supportedCrafts: "车缝、锁眼" });
    expect(row.status).toBe("review");
    expect(row.changes.find(change => change.field === "contactPerson")).toMatchObject({ before: "原联系人", after: "新联系人", needsConfirmation: true });
    expect(supplierBatchPayload(row, body(row))).toMatchObject({ address: "补齐地址", supportedCrafts: ["车缝", "锁眼"] });
    expect(supplierBatchPayload(row, body(row))).not.toHaveProperty("contactPerson");
    expect(supplierBatchPayload(row, body(row, ["contactPerson"]))).toHaveProperty("contactPerson", "新联系人");
    expect(plan({ supplierCode: profile.supplierCode, contactPerson: profile.contactPerson!, supportedCrafts: "车缝" }).status).toBe("unchanged");
  });
  it("flags duplicate IDs, codes and canonical name/type combinations inside one upload", () => {
    const rows = [plan({ supplierCode: profile.supplierCode }), plan({ supplierName: profile.supplierName, supplierType: "加工厂" })];
    expect(flagSupplierBatchDuplicates(rows).map(row => row.status)).toEqual(["conflict", "conflict"]);
    const newRows = [plan(complete), { ...plan({ ...complete, supplierType: "factory" }), supplierCode: "SUP_SECOND" }];
    expect(flagSupplierBatchDuplicates(newRows).map(row => row.status)).toEqual(["conflict", "conflict"]);
  });
  it("rejects invalid capacities, duplicate crafts, numeric and scientific-notation bank accounts", () => {
    for (const dailyCapacity of [0, -1, 1.1, 1_000_000_001]) expect(plan({ ...complete, dailyCapacity }).status).toBe("error");
    for (const bankAccount of [Number("12345678901234567890"), "1.23456789E+19", ".1E+20", "1.E+20", "-.1e-20", "+1.E20"]) expect(plan({ ...complete, bankAccount }).message).toContain("账号");
    expect(plan({ ...complete, supportedCrafts: "车缝、车缝" }).status).toBe("error");
    expect(plan({ ...complete, dailyCapacity: 200 }).status).toBe("create");
  });
});

describe("standard supplier XLSX", () => {
  it("opens both template sheets with the production reader and preserves long text accounts", async () => {
    const template = supplierBatchTemplate();
    expect((await readSheet(template, "供应商录入"))[0]).toEqual(SUPPLIER_BATCH_COLUMNS.map(([, label]) => label));
    expect((await readSheet(template, "填写说明")).length).toBeGreaterThan(5);
    const file = buildWorkbook([{ name: "供应商录入", textColumns: [10], rows: [SUPPLIER_BATCH_COLUMNS.map(([, label]) => label), cells(complete).map(value => value ?? "")] }]);
    const parsed = await readSheet(file, "供应商录入");
    expect(parsed[1]![10]).toBe("001234567890123456789");
    expect(planSupplierBatchRow(parsed[1] as SupplierBatchCell[], [], "SUP_TEXT").status).toBe("create");
  });
});
