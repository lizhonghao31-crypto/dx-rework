import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N02/N03 process configuration UI idempotency", () => {
  it("reuses draft, plan and review keys and resumes an uncertain submit", async () => {
    const source = await read("apps/web/src/process-worker-assignment-form.tsx");

    expect(source).toContain("pendingKeys = useRef<Record<string, string>>({})");
    expect(source).toContain("pendingSubmit = useRef<PendingSubmit | null>(null)");
    expect(source).toContain('headers: { "idempotency-key": mutationKey(configSignature) }');
    expect(source).toContain('headers: { "idempotency-key": mutationKey(planSignature) }');
    expect(source).toContain("let attempt = pendingSubmit.current");
    expect(source).toContain('headers: { "idempotency-key": attempt.key }');
    expect(source).toContain("pendingSubmit.current = null");
    expect(source).toContain('const reviewSignature = `review:${JSON.stringify(reviewBody)}`;');
    expect(source).toContain('headers: { "idempotency-key": mutationKey(reviewSignature) }');
    expect(source).toContain("delete pendingKeys.current[reviewSignature]");
  });

  it("requires N02 process, candidate price, worker and tail-inspector assignment before N03 IE review", async () => {
    const source = await read("apps/web/src/process-worker-assignment-form.tsx");

    expect(source).toContain("分配工序 &工人");
    expect(source).toContain("候选单价（元/件）");
    expect(source).toContain("至少分配 1 名工人");
    expect(source).toContain("至少分配 1 名整查");
    expect(source).toContain("提交 IE 核价");
  });
});
