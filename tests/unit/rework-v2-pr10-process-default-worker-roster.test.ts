import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("PR-10 process default worker roster", () => {
  it("keeps one versioned database authority and loads defaults only on catalog selection", async () => {
    const [migration, service, form, masterData] = await Promise.all([
      readFile(new URL("../../apps/api/migrations/0084_rework_v2_process_default_worker_roster.sql", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/access/service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/process-worker-assignment-form.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/master-data-page.tsx", import.meta.url), "utf8"),
    ]);
    expect(migration).toContain("process_default_worker_roster_versions");
    expect(migration).toContain("process_default_worker_roster_no_update");
    expect(service).toContain("master_data.process_default_workers.replace");
    expect(masterData).toContain("固定人员名单");
    expect(form).toContain("defaultWorkerPersonIds");
    expect(form).toContain("selectCatalogProcess");
    expect(form).not.toContain("replaceProcessDefaultWorkers(");
  });
});
