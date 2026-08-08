import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow navigation access contract", () => {
  it("shows N07-N08 entries to actors who can actually use them and does not piggyback on dashboard access", async () => {
    const shell = await readFile("apps/web/src/components.tsx", "utf8");

    expect(shell).toContain('const responsibilityAccess = isRoot || isOwner');
    expect(shell).toContain('hasCapability("responsibility:determine")');
    expect(shell).toContain('hasCapability("responsibility:takeover")');
    expect(shell).toContain('hasCapability("responsibility:confirm_high_multiplier")');
    expect(shell).toContain('const ownFactoryAccess = isRoot || isOwner || hasCapability("own_factory:view")');
    expect(shell).toContain('const externalResponsibilityAccess = isRoot || isOwner || hasCapability("external_responsibility:view")');
    expect(shell).toContain("if (responsibilityAccess)");
    expect(shell).toContain("if (ownFactoryAccess)");
    expect(shell).toContain("if (externalResponsibilityAccess)");
  });
});
