import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ROOT_ACTOR_ROLE,
  isRootActor,
} from "../../apps/api/src/access/business-authority.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const rootActor: TrustedActorContext = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: [ROOT_ACTOR_ROLE],
  authorizationCapability: "test:capability",
  authorizationCapabilities: ["test:capability"],
  requestId: "root-global-business-bypass-test",
};

describe("root global business bypass policy", () => {
  it("recognizes the immutable root actor role", () => {
    expect(isRootActor(rootActor)).toBe(true);
    expect(isRootActor({ ...rootActor, actorRoles: ["owner_group"] })).toBe(false);
  });

  it("lets root proxy-report any worker task while ordinary proxies stay temporary-only", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/rework/work-reporting-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("if (isRootActor(actor)) return true;");
    expect(source).toContain("members.some((person) => person.person_type === \"temporary\")");
  });

  it("bypasses root identity separation in quantity confirmation and IE review", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/rework/whole-order-review-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("if (isRootActor(actor)) return true;");
    expect(source).toContain("!isRootActor(actor) && adjustment.requested_by === actor.actorId");
  });

  it("bypasses root handler and independent-review separation in responsibility", async () => {
    const authorized = await readFile(
      new URL("../../apps/api/src/rework/responsibility-determination-authorized-service.ts", import.meta.url),
      "utf8",
    );
    const application = await readFile(
      new URL("../../apps/api/src/rework/responsibility-determination-application-service.ts", import.meta.url),
      "utf8",
    );
    expect(authorized).toContain("!isRootActor(actor) && permission.handlerUserId !== actor.actorId");
    expect(authorized).toContain("!isRootActor(actor) && current.created_by === actor.actorId");
    expect(authorized).toContain("root || row.leaf_created_by !== actor.actorId");
    expect(application).toContain("!isRootActor(actor) && permission.handler_user_id !== actor.actorId");
  });

  it("bypasses root wage adjustment actor separation without bypassing wage state rules", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/wages/wage-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("!isRootActor(actor) && adjustment.requested_by === actor.actorId");
    expect(source).toContain("target.status === \"locked\"");
    expect(source).toContain("period.status !== \"ready_to_lock\"");
  });

  it("keeps the existing root IE self-review bypass", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/rework/process-configuration-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("!isRootActor(actor)");
    expect(source).toContain("orderCreatedBy === actor.actorId || configurationCreatedBy === actor.actorId");
  });
});
