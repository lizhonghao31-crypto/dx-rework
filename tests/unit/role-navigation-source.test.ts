import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("1.0 role entry and navigation closure", () => {
  it("copies the finance-read baseline to finance director and enables embroidery todo entry", async () => {
    const migration = await readFile(
      "apps/api/migrations/0091_role_entry_todo_reliability.sql",
      "utf8",
    );
    expect(migration).toContain("SELECT 'finance_director',capability");
    expect(migration).toContain("WHERE role_code='finance_read'");
    expect(migration).toContain("('embroidery_washing_merchandiser','todo:view')");
  });

  it("removes the management cockpit route and keeps named role labels", async () => {
    const [app, navigation] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(app).not.toContain('path === "/ui/management"');
    expect(navigation).toContain('finance_director: "财务总监"');
    expect(navigation).toContain('tail_inspector: "尾查"');
  });
});
