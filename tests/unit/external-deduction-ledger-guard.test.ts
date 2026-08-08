import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("external deduction ledger integrity guard", () => {
  it("serializes each case and prevents negative or over-proposed cumulative deductions", async () => {
    const sql = await readFile(
      "apps/api/migrations/0039_external_deduction_ledger_bounds.sql",
      "utf8",
    );
    expect(sql).toContain("FOR UPDATE;");
    expect(sql).toContain("current_actual+NEW.amount<0");
    expect(sql).toContain("current_actual+NEW.amount>proposed_amount");
    expect(sql).toContain("external deduction cumulative actual must stay between zero and proposed amount");
  });

  it("does not let an adjustment or reversal point at another deduction case", async () => {
    const sql = await readFile(
      "apps/api/migrations/0039_external_deduction_ledger_bounds.sql",
      "utf8",
    );
    expect(sql).toContain("IF NEW.entry_type<>'deduction' THEN");
    expect(sql).toContain("referenced_case_id IS DISTINCT FROM NEW.case_id");
    expect(sql).toContain("external deduction correction must reference an entry from the same case");
  });

  it("registers the forward guard in the current migration manifest", async () => {
    const manifest = JSON.parse(await readFile(
      "apps/api/src/platform/migration-manifest.json",
      "utf8",
    )) as { migrations: Array<{ version: string; checksum: string }> };
    expect(manifest.migrations.at(-1)).toEqual({
      version: "0039_external_deduction_ledger_bounds",
      checksum: "6f3643233c6b04b0e7687dc7af7a04d0e16914cc32dc58213994a748c709fc05",
    });
  });

  it("maps the database guard to a usable 400 business validation response", async () => {
    const source = await readFile(
      "apps/api/src/rework/production-external-responsibility-service.ts",
      "utf8",
    );
    expect(source).toContain('candidate?.code !== "23514"');
    expect(source).toContain("累计实扣金额不能低于 0，也不能超过当前拟扣金额。");
    expect(source).toContain("扣款调整或冲销只能引用当前这笔扣款台账中的原流水。");
    expect(source).toContain('new ApplicationError("VALIDATION_ERROR", message, 400)');
  });
});
