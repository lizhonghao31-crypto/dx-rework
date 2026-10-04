import { describe, expect, it } from "vitest";
import { escapeDingTalkMarkdownText } from "../../apps/api/src/todos/markdown-text.js";
import { escapeCell, parseCsv } from "../../apps/web/src/csv.js";

describe("business text at export and notification sinks", () => {
  it.each(["=HYPERLINK(\"https://evil.invalid\",\"x\")", "+SUM(1,2)", "-cmd|'x'!A0", "@SUM(1)", " \t=1+1", "\tmalicious", "\r=1+1"])("exports formula text literally: %s", value => {
    expect(escapeCell(value).replace(/^"/, "")).toMatch(/^'/);
    expect(parseCsv(`${escapeCell(value)}\r\n`)[0]?.[0]).toBe(value);
  });
  it.each(["-12.50", "+10", "1e-3", "00123", "中文款号", "-返工厂", "@款号", "'=原始名称", "'-原始名称", "''原始名称", "'正常名称", '逗号,引号"与换行\n内容'])("preserves ordinary values: %s", value => {
    expect(parseCsv(`${escapeCell(value)}\r\n`)[0]?.[0]).toBe(value);
  });
  it("neutralizes links, headings, HTML and multiline style numbers", () => {
    const result = escapeDingTalkMarkdownText("款A\r\n# [点击](https://evil.invalid) ![图](x) <script> & **加粗** `code`");
    expect(result).toContain("\\# \\[点击\\]\\(https\\:\\/\\/evil\\.invalid\\)");
    expect(result).toContain("&lt;script&gt; &amp;");
    expect(result).not.toContain("\r");
    expect(escapeDingTalkMarkdownText("正常款号 A-123/蓝色")).toBe("正常款号 A\\-123\\/蓝色");
  });
});

it("round-trips unchanged supplier and process names without inserting export guards", () => {
  const source = [["系统编码", "名称"], ["SUP-001", "-返工厂"], ["PROC-001", "@工序"], ["SUP-002", "'=原本的名称"]];
  const exported = "\uFEFF" + source.map(row => row.map(escapeCell).join(",")).join("\r\n");
  expect(parseCsv(exported)).toEqual(source);
});
