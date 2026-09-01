import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("master-data process catalog pagination", () => {
  it("loads only a 15-row page for normal browsing and preserves full export/import semantics lazily", async () => {
    const source = await read("apps/web/src/master-data-page.tsx");

    expect(source).toContain("master-data/process-catalog?");
    expect(source).toContain("processCursorHistory");
    expect(source).toContain("每页最多 15 条");
    expect(source).toContain("搜索工序名称或系统编码");
    expect(source).toContain('const loadAllProcesses = () => json<Process[]>("master-data/processes?includeInactive=true")');
    expect(source).toContain("previewProcessImport(file.name, rows, await loadAllProcesses())");
    expect(source).toContain("row.process.processId");
  });

  it("keeps the pager usable on desktop and mobile", async () => {
    const styles = await read("apps/web/src/master-data-page.css");

    expect(styles).toContain(".master-data-process-pager");
    expect(styles).toContain(".master-data-process-search");
    expect(styles).toContain("grid-template-columns:1fr 1fr");
  });
});
