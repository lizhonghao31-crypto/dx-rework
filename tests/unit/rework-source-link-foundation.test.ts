import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework source linkage foundation", () => {
  it("keeps one explicit business kind and follows stable cutting linkage for source facts", async () => {
    const [migration, service, form, contracts] = await Promise.all([
      readFile("apps/api/migrations/0213_rework_kind_source_link.sql", "utf8"),
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("packages/contracts/src/index.ts", "utf8"),
    ]);
    expect(migration).toContain("rework_kind text NOT NULL DEFAULT 'qc_rework'");
    expect(migration).toContain("'inhouse_finishing'");
    expect(contracts).toContain('ReworkKindSchema = z.enum(["qc_rework", "inhouse_finishing"])');
    expect(service).toContain("LEFT JOIN cutting_orders cutting");
    expect(service).toContain("snapshot.supplier_id AS processing_factory_supplier_id");
    expect(service).not.toContain("COALESCE(current_decision.supplier_id,snapshot.supplier_id)");
    expect(service).toContain("source_case.created_by AS merchandiser_user_id");
    expect(service).toContain("source_line.image_attachment_id AS source_image_attachment_id");
    expect(form).toContain("已从源订单自动带入款号、加工厂和订单跟单");
  });
});
