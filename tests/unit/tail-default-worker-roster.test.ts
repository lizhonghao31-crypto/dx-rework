import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("tail inspection default worker roster", () => {
  it("keeps tail defaults versioned and audited without turning tail into a catalog process", () => {
    const migration = read("apps/api/migrations/0099_tail_default_worker_roster.sql");
    expect(migration).toContain("tail_inspection_default_worker_roster_versions");
    expect(migration).toContain("master_data.tail_default_workers.replace");
    expect(migration).toContain("person.person_type='temporary'");
    expect(migration).toContain("assignment.role_code IN ('worker','tail_inspector')");
    expect(migration).not.toContain("INSERT INTO process_catalog_items");
  });

  it("loads, saves and explicitly applies the tail roster in N02", () => {
    const form = read("apps/web/src/process-worker-assignment-form.tsx");
    const service = read("apps/api/src/access/service.ts");
    const routes = read("apps/api/src/access/routes.ts");
    const options = read("apps/api/src/rework/process-configuration-service.ts");
    expect(form).toContain("tailDefaultWorkerPersonIds");
    expect(form).toContain("saveTailDefaultWorkers");
    expect(form).toContain("尾查默认工人已保存");
    expect(form).toContain("保存为默认名单");
    expect(service).toContain("replaceTailInspectionDefaultWorkers");
    expect(routes).toContain('"/master-data/tail-inspection/default-workers"');
    expect(options).toContain("tailDefaultWorkerPersonIds");
  });
});
