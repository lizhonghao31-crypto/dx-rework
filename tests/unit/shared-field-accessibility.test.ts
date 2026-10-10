import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsetField } from "../../packages/ui/src/index.js";

describe("shared field accessibility", () => {
  it("connects the field error and existing instruction to the actual input", () => {
    const html = renderToStaticMarkup(createElement(InsetField, {
      id: "quantity", label: "数量", required: true, value: "", suffix: "件",
      "aria-describedby": "quantity-hint", error: "请输入数量", onChange() {},
    }));
    expect(html).toContain('for="quantity"');
    expect(html).toContain('id="quantity"');
    expect(html).toContain('required=""');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="quantity-hint quantity-error"');
    expect(html).toContain('id="quantity-error"');
    expect(html).toContain('role="alert">请输入数量');
    expect(html).toContain("件</em>");
  });

  it("gives repeated fields unique label targets without inventing required status", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(InsetField, { label: "备注", optional: true, value: "保留输入", disabled: true }),
      createElement(InsetField, { label: "历史值", value: "123.456", readOnly: true }),
    ));
    const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`for="${id}"`);
    expect(html).toContain("备注（选填）");
    expect(html).toContain('value="保留输入"');
    expect(html).toContain('value="123.456"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain('required=""');
    expect(html).not.toContain('optional="');
  });
});
