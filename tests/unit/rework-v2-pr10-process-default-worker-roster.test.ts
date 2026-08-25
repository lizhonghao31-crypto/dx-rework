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
    expect(masterData).toContain("默认候选人");
    expect(masterData).toContain("新订单选择该工序时自动带入，可在订单内调整。");
    expect(form).toContain("defaultWorkerPersonIds");
    expect(form).toContain("selectCatalogProcess");
    expect(form).toContain("已自动带入 {item.defaultCandidateCount} 名默认候选人");
    expect(form).not.toContain("replaceProcessDefaultWorkers(");
  });
});
