import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N07 responsibility UI idempotency", () => {
  it("reuses the same mutation key after an uncertain response and clears it only on success", async () => {
    const source = await read("apps/web/src/responsibility-determination-panel.tsx");
    expect(source).toContain("pendingMutationKeys = useRef<Record<string, string>>({})");
    expect(source).toContain("pendingMutationKeys.current[signature] ?? createClientRequestId()");
    expect(source).toContain('headers: { "idempotency-key": idempotencyKey }');
    expect(source).toContain("delete pendingMutationKeys.current[signature]");
    expect(source).not.toContain('headers: { "idempotency-key": crypto.randomUUID() }');
  });
});
