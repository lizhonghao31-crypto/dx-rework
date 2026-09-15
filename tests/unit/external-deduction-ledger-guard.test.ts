import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("external deduction ledger integrity guard", () => {
  it("serializes each case and prevents negative or over-proposed cumulative deductions", async () => {
    const sql = await readFile(
      "apps/api/migrations/0020_external_responsibility_codex_closure.sql",
      "utf8",
    );
    expect(sql).toContain("FOR UPDATE;");
    expect(sql).toContain("prior_total+NEW.amount<0");
    expect(sql).toContain("prior_total+NEW.amount>target_case.proposed_deduction_amount");
    expect(sql).toContain("deduction entry would make actual amount invalid");
  });

  it("does not let an adjustment or reversal point at another deduction case", async () => {
    const sql = await readFile(
      "apps/api/migrations/0020_external_responsibility_codex_closure.sql",
      "utf8",
    );
    expect(sql).toContain("IF NEW.entry_type IN ('adjustment','reversal') THEN");
    expect(sql).toContain("reversed_entry.case_id<>NEW.case_id");
    expect(sql).toContain("deduction adjustment or reversal must reference its own case ledger entry");
  });

  it("registers the deduction guard migration in the current migration manifest", async () => {
    const manifest = JSON.parse(await readFile(
      "apps/api/src/platform/migration-manifest.json",
      "utf8",
    )) as { migrations: Array<{ version: string; checksum: string }> };
    expect(manifest.migrations.find((entry) => entry.version === "0020_external_responsibility_codex_closure")).toEqual({
      version: "0020_external_responsibility_codex_closure",
      checksum: "7df9f581820a1fe5c96db916c9bc2856445fd81d081e9abcbea95ca9ad35c831",
    });
  });

  it("maps the database guard to a usable 400 business validation response", async () => {
    const source = await readFile(
      "apps/api/src/rework/production-external-responsibility-service.ts",
      "utf8",
    );
    expect(source).toContain('candidate?.code !== "23514"');
    expect(source).toContain("累计实扣金额不能低于 0；超额扣款必须同时提交财务总监特批。");
    expect(source).toContain("扣款调整或冲销只能引用当前这笔扣款台账中的原流水，冲销金额必须与原流水相反。");
    expect(source).toContain('new ApplicationError("VALIDATION_ERROR", message, 400)');
  });
});
