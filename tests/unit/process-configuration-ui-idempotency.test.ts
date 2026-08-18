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
  it("requires N02 process, estimated quantity and price before N03 IE review", async () => {
    const source = await read("apps/web/src/process-configuration-form.tsx");

    expect(source).toContain("工序、计划数量与单价");
    expect(source).toContain("单价（元）");
    expect(source).toContain("提交 IE 审核");
  });

});
