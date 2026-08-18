import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ROOT_ACTOR_ROLE } from "../../apps/api/src/access/business-authority.js";
import { isIeSelfReviewBlocked } from "../../apps/api/src/rework/process-configuration-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor = (actorId: string, actorRoles: readonly string[]): TrustedActorContext => ({
  actorId,
  actorRoles,
  authorizationCapability: "process:review",
  requestId: "root-self-review-test",
});

describe("root superuser self-review bypass", () => {
  it("keeps IE separation for ordinary users", () => {
    const reviewer = actor("user-1", ["ie_reviewer"]);

    expect(isIeSelfReviewBlocked(reviewer, "user-1", "other-user")).toBe(true);
    expect(isIeSelfReviewBlocked(reviewer, "other-user", "user-1")).toBe(true);
    expect(isIeSelfReviewBlocked(reviewer, "other-user", "another-user")).toBe(false);
  });

  it("lets root review even when root created the order and configuration", () => {
    const root = actor("root-user", [ROOT_ACTOR_ROLE, "ie_reviewer"]);

    expect(isIeSelfReviewBlocked(root, "root-user", "root-user")).toBe(false);
  });

  it("lets Root use the same explicit N03 IE price-review control", async () => {
    const form = await readFile(
      new URL("../../apps/web/src/process-configuration-form.tsx", import.meta.url),
      "utf8",
    );

    expect(form).toContain("审核通过并生效");
    expect(form).toContain("候选单价（元 / 件）");
  });
});
