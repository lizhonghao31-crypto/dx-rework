import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("acceptance role seeder fail-closed ordering", () => {
  it("completes Root and dirty-identity readonly preflight before the first identity mutation path", async () => {
    const source = await readFile(
      new URL("../../scripts/acceptance/seed-role-users.ts", import.meta.url),
      "utf8",
    );
    const rootPreflight = source.indexOf("await preflightAcceptanceRootState(pool, corpId)");
    const identityPreflight = source.indexOf("await preflightExistingAcceptanceIdentity(pool");
    const firstEnsureUserCall = source.indexOf("await ensureUser(alias, displayName)");
    expect(rootPreflight).toBeGreaterThan(-1);
    expect(identityPreflight).toBeGreaterThan(rootPreflight);
    expect(firstEnsureUserCall).toBeGreaterThan(identityPreflight);
  });
});
