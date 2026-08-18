import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N08-B/N10-B external responsibility UI safety", () => {
  it("reuses idempotency keys for case and supplier-allocation retries", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");

    expect(source).toContain("pendingMutationKeys = useRef<Record<string, string>>({})");
    expect(source).toContain('"idempotency-key": mutationKey(signature)');
    expect(source).toContain("delete pendingMutationKeys.current[signature]");
    expect(source).not.toContain('"idempotency-key": crypto.randomUUID()');
  });

  it("uses an explicit business choice instead of guessing own-factory transfer from free text", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");

    expect(source).toContain("revisionToOwnFactory[caseItem.caseId] === true");
    expect(source).toContain("将未扣差额转为本厂承担，并进入 N07 重新判责");
    expect(source).not.toContain('includes("本厂")');
  });

  it("requires confirmation before terminal close and responsibility-revision approval", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");

    expect(source).toContain('kind.startsWith("close")');
    expect(source).toContain("关闭后本条扣款台账进入终局状态");
    expect(source).toContain("确认通过责任变更？通过后会生成新的 N07 判责草稿");
    expect(source).toContain("await confirmInApp");
    expect(source).not.toContain("window.confirm");
  });
});
