import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("acceptance role seeder fail-closed ordering", () => {
  it("completes the readonly dirty-identity preflight before the first identity mutation path", async () => {
    const source = await readFile(
      new URL("../../scripts/acceptance/seed-role-users.ts", import.meta.url),
      "utf8",
    );
    const preflightLoop = source.indexOf("await preflightExistingAcceptanceIdentity(pool");
    const firstEnsureUserCall = source.indexOf("await ensureUser(alias, displayName)");
    expect(preflightLoop).toBeGreaterThan(-1);
    expect(firstEnsureUserCall).toBeGreaterThan(preflightLoop);
  });
});
