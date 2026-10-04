import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { supplierBatchTemplate } from "../../apps/api/src/access/supplier-batch-template.js";
import { buildWorkbook } from "../../apps/api/src/reporting/xlsx-workbook.js";
import { validateXlsxResourceBudget } from "../../apps/web/src/xlsx-resource-budget.js";

describe("XLSX inflation budget before library parsing", () => {
  it("accepts the exact supplier template and Chinese data", async () => {
    await expect(validateXlsxResourceBudget(supplierBatchTemplate())).resolves.toBeUndefined();
    await expect(validateXlsxResourceBudget(buildWorkbook([{ name: "供应商录入", rows: [["供应商名称", "收款账号"], ["中文供应商", "001234567890"]], textColumns: [0, 1] }]))).resolves.toBeUndefined();
  });
  it("accepts ordinarily compressed ZIP entries", async () => {
    const text = new TextEncoder().encode("中文数据".repeat(100));
    await expect(validateXlsxResourceBudget(zipSync({ "xl/sharedStrings.xml": text }))).resolves.toBeUndefined();
  });
  it("rejects extreme compression, too many entries and total inflation", async () => {
    await expect(validateXlsxResourceBudget(zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(1_000_000) }))).rejects.toThrow(/资源/);
    await expect(validateXlsxResourceBudget(zipSync(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`${index}.xml`, new Uint8Array()]))))).rejects.toThrow(/资源/);
    // A forged large size is rejected from metadata before any decompressor runs.
    const archive = zipSync({ "x.xml": new Uint8Array([1, 2, 3]) }, { level: 0 });
    const central = archive.findIndex((value, index) => value === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 1 && archive[index + 3] === 2);
    new DataView(archive.buffer).setUint32(central + 24, 9 * 1024 * 1024, true);
    await expect(validateXlsxResourceBudget(archive)).rejects.toThrow(/资源/);
  });
  it("does not trust forged small uncompressed sizes, local metadata or CRC", async () => {
    const archive = zipSync({ "x.xml": new TextEncoder().encode("data".repeat(100)) });
    const central = archive.findIndex((value, index) => value === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 1 && archive[index + 3] === 2);
    const view = new DataView(archive.buffer); view.setUint32(22, 1, true); view.setUint32(central + 24, 1, true);
    await expect(validateXlsxResourceBudget(archive)).rejects.toThrow(/资源/);
    const corrupt = zipSync({ "x.xml": new Uint8Array([1, 2, 3]) }, { level: 0 }); corrupt[35] ^= 1;
    await expect(validateXlsxResourceBudget(corrupt)).rejects.toThrow(/资源/);
  });
  it("rejects encrypted and truncated archives", async () => {
    const archive = zipSync({ "x.xml": new Uint8Array([1]) });
    archive[6] |= 1;
    await expect(validateXlsxResourceBudget(archive)).rejects.toThrow(/资源/);
    await expect(validateXlsxResourceBudget(archive.subarray(0, -1))).rejects.toThrow(/资源/);
  });
});
