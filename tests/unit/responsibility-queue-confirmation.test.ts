import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N07 independent high-multiplier queue", () => {
  it("exposes actor-specific independent-confirm eligibility without weakening separation", async () => {
    const contract = await read("packages/contracts/src/responsibility-queue.ts");
    const service = await read("apps/api/src/rework/responsibility-determination-queue-service.ts");
    const page = await read("apps/web/src/responsibility-queue-page.tsx");

    expect(contract).toContain("canConfirmHighMultiplier: z.boolean()");
    expect(service).toContain("row.leaf_created_by !== actor.actorId");
    expect(service).toContain('row.determination_stage === "draft"');
    expect(service).toContain("row.high_multiplier_pending");
    expect(page).toContain("高倍率待你独立确认");
    expect(page).toContain("高倍率待其他老板独立确认");
  });
});
