import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PatternOrderForm } from "../../apps/web/src/pattern-order-form.js";
import { PATTERN_MATERIAL_LIMIT, PatternMaterialInput } from "../../apps/web/src/pattern-material-input.js";
import { PatternMaterials } from "../../apps/web/src/pattern-materials.js";
import { CreateMiscOrderSchema, CreatePatternOrderSchema, UpdateMiscMaterialsSchema, UpdatePatternMaterialsSchema } from "@dx-rework/contracts/pattern-orders";

describe("pattern form feedback", () => {
  it("limits the detail strip to six previews without hiding the full set or edit controls", () => {
    const files = Array.from({ length: 20 }, (_, n) => ({ attachmentId: String(n), filename: `资料${n}.pdf`, mimeType: "application/pdf" }));
    const compact = renderToStaticMarkup(createElement(PatternMaterials, { files, compact: true }));
    expect(compact.match(/class="pattern-material-thumb"/g)).toHaveLength(6);
    expect(compact).toContain("查看全部 20 份资料");
    const edit = renderToStaticMarkup(createElement(PatternMaterials, { files, compact: true, onRemove() {} }));
    expect(edit.match(/class="pattern-material-thumb"/g)).toHaveLength(20);
  });
  it("does not misrepresent an unresolved hourly request as missing configuration", () => {
    const html = renderToStaticMarkup(createElement(PatternOrderForm, { kind: "misc", onSaved() {}, onCancel() {} }));
    expect(html).toContain("正在读取…");
    expect(html).not.toContain("尚未配置");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>提交杂事/);
  });
  it.each([0, 19, 20])("shows the aggregate %s/20 limit and an accessible primary upload button", count => {
    const html = renderToStaticMarkup(createElement(PatternMaterialInput, { kind: "pattern", purpose: "rework", count, label: "补充资料", disabled: false, onFiles() {} }));
    expect(PATTERN_MATERIAL_LIMIT).toBe(20);
    expect(html).toContain(`资料 ${count}/20`);
    expect(html).toContain("含保留资料");
    expect(html).toContain("JPG、PNG、WebP、PDF");
    expect(html).toContain("dx-button--primary");
    expect(html).toContain("aria-describedby=");
    expect(html.includes('disabled=""')).toBe(count === 20);
    // Do not invent a static byte limit while the server configuration is pending.
    expect(html).toContain("正在读取文件大小限制");
    expect(html).not.toContain("20 MiB");
  });
  it("preserves calendar dates and material IDs across both create and edit contracts", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const common = { requiredDate: "2026-09-28", attachmentIds: [id] };
    expect(CreatePatternOrderSchema.parse({ ...common, styleNo: "TEST", categoryId: id, quantity: 1, priceVersion: 1 }).requiredDate).toBe(common.requiredDate);
    expect(CreateMiscOrderSchema.parse({ ...common, taskName: "TEST", priceVersion: 1 }).requiredDate).toBe(common.requiredDate);
    expect(UpdatePatternMaterialsSchema.parse({ ...common, styleNo: "TEST", reason: "补图", roundId: id, version: 1 }).requiredDate).toBe(common.requiredDate);
    expect(UpdateMiscMaterialsSchema.parse({ ...common, taskName: "TEST", reason: "补图", roundId: id, version: 1 }).requiredDate).toBe(common.requiredDate);
    expect(CreateMiscOrderSchema.safeParse({ ...common, requiredDate: "2026-02-30", taskName: "TEST", priceVersion: 1 }).success).toBe(false);
  });
});
