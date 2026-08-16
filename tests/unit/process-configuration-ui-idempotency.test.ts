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
  it("keeps N02 limited to process and estimated quantity", async () => {
    const source = await read("apps/web/src/process-configuration-form.tsx");

    expect(source).toContain("工序与预估数量");
    expect(source).toContain("预估数量仅作安排参考，不限制工人最终上数。");
    expect(source).not.toContain("单价（元）");
    expect(source).not.toContain("提交 IE 审核");
  });

});
