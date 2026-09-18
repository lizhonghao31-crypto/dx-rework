import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sourcing form feedback", () => {
  it("labels both dates as required while preserving date controls and field bindings", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain('预计裁片发出日期（工厂发出，必填）</span><input type="date" required aria-required="true" value={estimatedCutPieceSendDate}');
    expect(source).toContain('要求交货日期（到工厂，必填）</span><input type="date" required aria-required="true" value={deliveryDate}');
    expect(source).toContain("if (!estimatedCutPieceSendDate || !deliveryDate)");
  });
  it("clears the previous failure on retry and success, retaining failure blocking", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain("setUploading(true);\n    setUploadFailed(false);");
    expect(source).toContain("setImages((current) => [...current, ...uploaded]);\n      setUploadFailed(false);");
    expect(source).toContain("uploadFailed && !uploading ? <p role=\"alert\"");
    expect(source).toContain("if (busy || uploading || uploadFailed)");
    expect(source).toContain("setUploadFailed(true);");
  });
  it("provides inline reason feedback and avoids sending a known-invalid decision", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(source).toContain('aria-describedby={missingDecisionReason ? "sourcing-decision-reason-hint" : undefined}');
    expect(source).toContain('if (missingDecisionReason) { setMessage("价格高于 IE，请填写原因"); return; }');
    expect(source).toContain('disabled={busy || priceComposing("decision") || !decision.supplierId || missingDecisionReason');
    expect(source).not.toContain("历史价格不会自动截断");
    expect(source).not.toContain("任一行调价时必须填写原因");
    expect(source).not.toContain("未调价可选");
  });
});
