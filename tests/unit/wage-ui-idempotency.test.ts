import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N11 wage UI retry safety", () => {
  it("reuses command keys when a wage review or lock result is uncertain", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");

    expect(source).toContain("pendingMutationKeys = useRef<Record<string, string>>({})");
    expect(source).toContain("pendingMutationKeys.current[signature] ?? crypto.randomUUID()");
    expect(source).toContain('"idempotency-key": idempotencyKey');
    expect(source).toContain("delete pendingMutationKeys.current[signature]");
    expect(source).not.toContain('"idempotency-key": crypto.randomUUID()');
  });

  it("reuses the same adjustment key only while the payload is unchanged", async () => {
    const source = await read("apps/web/src/wages/wage-adjustment-form.tsx");

    expect(source).toContain("pendingAttempt = useRef<PendingAdjustmentAttempt | null>(null)");
    expect(source).toContain("pendingAttempt.current?.signature === signature");
    expect(source).toContain('"idempotency-key": attempt.key');
    expect(source).toContain("pendingAttempt.current = null");
  });

  it("requires an explicit confirmation before the irreversible month lock", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");

    expect(source).toContain("确认锁定本月工资？锁定后本月不能直接修改，只能在后续未锁定月份生成调整。");
    expect(source).toContain("await confirmInApp");
    expect(source).not.toContain("window.confirm");
  });
});
