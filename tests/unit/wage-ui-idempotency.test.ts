import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N11 wage UI retry safety", () => {
  it("reuses command keys when a month-lock result is uncertain", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");

    expect(source).toContain("pendingMutationKeys = useRef<Record<string, string>>({})");
    expect(source).toContain("pendingMutationKeys.current[signature] ?? crypto.randomUUID()");
    expect(source).toContain('\"idempotency-key\": idempotencyKey');
    expect(source).toContain("delete pendingMutationKeys.current[signature]");
    expect(source).not.toContain('\"idempotency-key\": crypto.randomUUID()');
  });

  it("requires an explicit confirmation before the irreversible month lock", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");

    expect(source).toContain("确认锁定本月工资？锁定后本月工资不可修改。");
    expect(source).toContain("await confirmInApp");
    expect(source).not.toContain("window.confirm");
    expect(source).not.toContain("工资调整");
  });
});
