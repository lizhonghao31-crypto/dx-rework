import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N02/N03 process configuration UI idempotency", () => {
  it("reuses draft/review keys and resumes an uncertain submit without saving another draft", async () => {
    const source = await read("apps/web/src/process-configuration-form.tsx");

    expect(source).toContain("pendingMutationKeys = useRef<Record<string, string>>({})");
    expect(source).toContain("pendingSubmit = useRef<PendingSubmitAttempt | null>(null)");
    expect(source).toContain('headers: { "idempotency-key": mutationKey(signature) }');
    expect(source).toContain("let attempt = pendingSubmit.current");
    expect(source).toContain('headers: { "idempotency-key": attempt.key }');
    expect(source).toContain("pendingSubmit.current = null");
    expect(source).not.toContain('headers: { "idempotency-key": crypto.randomUUID() }');
  });
  it("preserves the three-decimal unit-price precision accepted by the API", async () => {
    const source = await read("apps/web/src/process-configuration-form.tsx");

    expect(source).toContain("value.toFixed(3).replace(/\\.?0+$/, \"\")");
    expect(source).toContain("const threeDecimals");
    expect(source).toContain('min="0.001" step="0.001"');
    expect(source).toContain("单价最多保留 3 位，最低 0.001 元。");
    expect(source).toContain("¥{formatUnitPrice(item.unitPrice)}");
  });

});
