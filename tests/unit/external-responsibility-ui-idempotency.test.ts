import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("external responsibility UI safety", () => {
  it("reuses idempotency keys for case and supplier-allocation retries", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");

    expect(source).toContain("pendingMutationKeys = useRef<Record<string, string>>({})");
    expect(source).toContain('"idempotency-key": mutationKey(signature)');
    expect(source).toContain("delete pendingMutationKeys.current[signature]");
    expect(source).not.toContain('"idempotency-key": crypto.randomUUID()');
  });

  it("uses a structured responsibility-revision request instead of inferring responsibility from free text", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");

    expect(source).toContain('kind: "other"');
    expect(source).toContain("configurationItemIds: caseItem.items.map");
    expect(source).toContain("summary: reason");
    expect(source).not.toContain('includes("本厂")');
  });

  it("auto-closes only after the amount reaches zero remaining and confirms rejudgment approval", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");

    expect(source).toContain('recorded.remainingAmount === "0.00" && recorded.canClose');
    expect(source).toContain("await closeFull(recorded)");
    expect(source).toContain("确认通过重判责任？通过后重新进入 N08 判责。");
    expect(source).toContain("await confirmInApp");
    expect(source).not.toContain("window.confirm");
  });
});
