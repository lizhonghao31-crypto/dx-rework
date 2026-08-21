import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("business-chain isolated schema cleanup", () => {
  it("drops only generated gate schemas and always cleans after execution", async () => {
    const source = await readFile(
      new URL("../../scripts/run-business-chain-gate.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "/^(?:full_chain_[0-9a-f]{32}|root_http_[12]_[0-9a-f]{32}|receiving_[0-9a-f]{32})$/",
    );
    expect(source).toContain("if (!ISOLATED_GATE_SCHEMA.test(schema)) continue;");
    expect(source).toContain("WHERE nspname LIKE 'full_chain_%'");
    expect(source).toContain("OR nspname LIKE 'root_http_%'");
    expect(source).toContain("OR nspname LIKE 'receiving_%'");
    expect(source).toContain("finally {");
    expect(source).toContain("if (hasDatabase) await cleanupIsolatedGateSchemas();");
    expect(source).not.toContain("DROP SCHEMA public");
  });
});
