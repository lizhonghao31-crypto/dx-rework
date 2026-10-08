import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sourcing form feedback", () => {
  it("labels both dates as required while preserving date controls and field bindings", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain('预计裁片发出日期（工厂发出，必填）</span><input type="date" required aria-required="true" value={estimatedCutPieceSendDate}');
    expect(source).toContain('默认加工厂交货日（选填）');
    expect(source).toContain('要求交货日期（到工厂，必填）');
    expect(source).toContain('required={!digitalPo} aria-required={!digitalPo}');
    expect(source).toContain('本 PO 加工厂交货日（必填）</span><input type="date" required');
    expect(source).toContain("validateSourcingCreate({ gender, styleName, estimatedCutPieceSendDate, deliveryDate");
  });
  it("clears the previous failure on retry and success, retaining failure blocking", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain("setUploading(true);\n    setUploadFailed(false);");
    expect(source).toContain("setImages((current) => [...current, ...uploaded]);\n      setUploadFailed(false);");
    expect(source).toContain("uploadFailed && !uploading ? <p role=\"alert\"");
    expect(source).toContain("imageCount: images.length, uploading, uploadFailed");
    expect(source).toContain("setUploadFailed(true);");
  });
  it("wires first-line price cascade independently into IE and management forms", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain('import { applySourcingPriceCascade } from "./sourcing-price-cascade.js";');
    expect(source).toContain("const quotePriceOverrides = useRef<ReadonlySet<number>>(new Set<number>());");
    expect(source).toContain("const decisionPriceOverrides = useRef<ReadonlySet<number>>(new Set<number>());");
    expect(source).toContain("const result = applySourcingPriceCascade(lines, position, next, overrides.current);");
    expect(source).toContain('const overrides = kind === "quote" ? quotePriceOverrides : decisionPriceOverrides;');
  });

  it("keeps order list filters compact, input-driven and free of a submit search button", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain('className="sourcing-search" aria-label="外发订单筛选"');
    expect(source).toContain('aria-label="订单状态"');
    expect(source).toContain('aria-label="性别"');
    expect(source).toContain('aria-label="款式类别"');
    expect(source).toContain("useDebouncedValue(search.trim(), 180)");
    expect(source).toContain("useDebouncedValue(styleName.trim(), 180)");
    expect(source).not.toContain('type="submit">搜索</button>');
    expect(source).toContain("returnTo={listPath}");
    expect(source).toContain("const listBackPath = sourcingReturnPath(window.location.search);");
  });
  it("provides inline reason feedback and avoids sending a known-invalid decision", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain('aria-describedby={missingDecisionReason ? "sourcing-decision-reason-hint" : undefined}');
    expect(source).toContain("validateSourcingDecision(decision, item.ieQuote?.linePrices ?? [], processes)");
    expect(source).toContain('disabled={busy || feedback.uncertain || priceComposing("decision")}');
    expect(source).toContain("if (issues.length) { await feedback.reject(issues); return; }");
    expect(source).not.toContain("历史价格不会自动截断");
    expect(source).not.toContain("任一行调价时必须填写原因");
    expect(source).not.toContain("未调价可选");
  });
});
