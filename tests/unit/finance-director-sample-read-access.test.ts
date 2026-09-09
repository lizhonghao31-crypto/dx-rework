import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const writeCapabilities = [
  "sample:create",
  "sample:batch_create",
  "sample:borrow_request",
  "sample:borrow_confirm",
  "sample:return_request",
  "sample:return_confirm",
  "sample:update_basic",
  "sample:update_location",
  "sample:correct_finance",
  "sample:dispose_request",
  "sample:dispose_approve",
  "sample:loss_close",
  "sample:archive",
] as const;

describe("finance director sample read-only remediation", () => {
  it("keeps create and handoff routes on their original write roles while adding read routes", async () => {
    const app = await readFile("apps/web/src/App.tsx", "utf8");
    expect(app).toContain('requiredRole="sample_administrative" requiredCapability="sample:view_basic"');
    expect(app).toContain('requiredRole="sample_finance" requiredCapability={path.endsWith("batch-create") ? "sample:batch_create" : "sample:create"}');
    expect(app).toContain('["sample_finance", "finance_director", "owner_group"]');
    expect(app).toContain('["sample_designer", "sample_administrative", "sample_finance", "finance_director", "owner_group"]');
  });

  it("shows the finance read navigation without aliasing finance director to sample finance", async () => {
    const shell = await readFile("apps/web/src/components.tsx", "utf8");
    expect(shell).toContain('hasRole("finance_director")');
    expect(shell).toContain('hasCapability("sample:view_finance")');
  });

  it("grants only the three approved sample read capabilities in SQL", async () => {
    const migration = await readFile("apps/api/migrations/0162_finance_director_sample_read.sql", "utf8");
    for (const capability of ["sample:view_basic", "sample:view_finance", "sample:view_audit"]) {
      expect(migration).toContain(`('finance_director','${capability}')`);
    }
    for (const capability of writeCapabilities) expect(migration).not.toContain(capability);
  });
});
