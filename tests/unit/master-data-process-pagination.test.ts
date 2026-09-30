import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("master-data process catalog pagination", () => {
  it("loads only a 15-row page for normal browsing and preserves full export/import semantics lazily", async () => {
    const source = await read("apps/web/src/master-data-page.tsx");

    expect(source).toContain("master-data/process-catalog?");
    expect(source).toContain("const [processPage, setProcessPage] = useState(1);");
    expect(source).toContain("const [processTotalPages, setProcessTotalPages] = useState(1);");
    expect(source).toContain('ariaLabel="公共工序分页"');
    expect(source).toContain("搜索工序名称或系统编码");
    expect(source).toContain('const loadAllProcesses = () => json<Process[]>("master-data/processes?includeInactive=true")');
    expect(source).toContain("previewProcessImport(file.name, rows, await loadAllProcesses())");
    expect(source).toContain("row.process.processId");
    expect(source).toContain("if (processPageLoading || busy) return;");
    expect(source).toContain('setBusy("process-page")');
    expect(source).toContain('setProcessPageLoading(false);\n      setBusy("");');
  });

  it("uses the My Todos pager on desktop and mobile", async () => {
    const page = await read("apps/web/src/master-data-page.tsx");
    const styles = await read("apps/web/src/my-todos.css");

    expect(page).toContain("<ListPagination");
    expect(page).not.toContain("<CursorListPagination");
    expect(styles).toContain("width: 34px");
    expect(styles).toContain("width: 32px");
    expect(styles).toContain("@media (max-width: 800px)");
  });
});
