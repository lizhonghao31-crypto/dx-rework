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
    const [source, form] = await Promise.all([
      readFile(new URL("../../apps/api/src/rework/work-reporting-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8"),
    ]);
    expect(source).toContain("if (isRootActor(actor)) return true;");
    expect(source).toContain("members.some((person) => person.person_type === \"temporary\")");
    expect(form).toContain("const reportableTasks = isRoot ? pendingTasks : canAssign ? temporaryTasks : pendingTasks;");
    expect(form).toContain('isRoot ? "代为报数"');
  });

  it("keeps external deduction authority Root-only while preserving ordinary role checks", async () => {
    const migration = await readFile(
      new URL("../../apps/api/migrations/0064_root_external_responsibility_bypass.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("access_is_root_actor(candidate)");
    expect(migration).toContain("external_responsibility_can_sign");
    expect(migration).toContain("external_responsibility_can_payables");
    expect(migration).toContain("external_responsibility_can_view_all");
    expect(migration).toContain("responsibility_actor_has_direct_role");
  });

  it("bypasses root identity separation in quantity confirmation and IE review", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/rework/whole-order-review-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("if (isRootActor(actor)) return true;");
    expect(source).toContain("!isRootActor(actor) && adjustment.requested_by === actor.actorId");
  });

  it("keeps Root global and allows a direct owner to confirm their own high multiplier", async () => {
    const authorized = await readFile(
      new URL("../../apps/api/src/rework/responsibility-determination-authorized-service.ts", import.meta.url),
      "utf8",
    );
    const application = await readFile(
      new URL("../../apps/api/src/rework/responsibility-determination-application-service.ts", import.meta.url),
      "utf8",
    );
    const queue = await readFile(
      new URL("../../apps/api/src/rework/responsibility-determination-queue-service.ts", import.meta.url),
      "utf8",
    );
    const migration = await readFile(
      new URL("../../apps/api/migrations/0040_root_identity_separation_bypass.sql", import.meta.url),
      "utf8",
    );
    const ownerSelfConfirmationMigration = await readFile(
      new URL("../../apps/api/migrations/0051_owner_self_confirmation_root_todo.sql", import.meta.url),
      "utf8",
    );
    expect(authorized).toContain("!isRootActor(actor) && permission.handlerUserId !== actor.actorId");
    expect(authorized).not.toContain("!isRootActor(actor) && current.created_by === actor.actorId");
    expect(authorized).toContain("directConfirm: root || (row.direct_confirm && caps.includes");
    expect(authorized).toContain("canView = root ||");
    expect(application).toContain("!isRootActor(actor) && permission.handler_user_id !== actor.actorId");
    expect(queue).toContain("const hasTakeover = root || actorCapabilities.includes");
    expect(queue).toContain("const hasConfirm = root || actorCapabilities.includes");
    expect(queue).not.toContain("root || row.leaf_created_by !== actor.actorId");
    expect(migration).toContain("event_actor IS DISTINCT FROM effective_handler");
    expect(migration).toContain("NOT access_is_root_actor(event_actor)");
    expect(migration).toContain("NEW.acted_by IS DISTINCT FROM current_handler");
    expect(migration).toContain("NOT access_is_root_actor(NEW.acted_by)");
    expect(migration).toContain("NOT access_is_root_actor(NEW.confirmed_by)");
    expect(migration).toContain("determination.stage <> 'draft'");
    expect(migration).toContain("process.multiplier > 2");
    expect(migration).toContain("confirmation snapshot does not match the draft");
    expect(ownerSelfConfirmationMigration).toContain("SELECT access_is_root_actor(candidate)");
    expect(ownerSelfConfirmationMigration).not.toContain("high multiplier submitter cannot confirm the same version");
    expect(ownerSelfConfirmationMigration).toContain("high multiplier confirmation requires a direct active owner or root");
  });

  it("keeps Root wage access without reviving the retired review or adjustment workflow", async () => {
    const [routes, service, retirement] = await Promise.all([
      readFile(new URL("../../apps/api/src/wages/wage-routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/wages/wage-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0074_wage_review_adjustment_retirement.sql", import.meta.url), "utf8"),
    ]);
    expect(routes).toContain('capability === "wage:view" && await isRootUser');
    expect(routes).toContain('"wage:export"');
    expect(routes).not.toContain("tail-approve");
    expect(routes).not.toContain("administrative-approve");
    expect(routes).not.toContain("wage-adjustments");
    expect(service).toContain('period.status !== "ready_to_lock"');
    expect(service).toContain("自然月结束前不能锁定");
    expect(retirement).toContain("wage review workflow is retired");
    expect(retirement).toContain("wage adjustment workflow is retired");
  });

  it("does not let recipient routing or account-separation setup block root UAT", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/todos/root-aware-projection-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("actionableForParallelDirectRole");
    expect(source).toContain("actionableForNamedRecipient");
    expect(source).toContain("actionableForIndependentOwner");
    expect(source).toContain("actionableForResponsibilityHandler");
    expect(source).toContain("actionableForNamedSourceActor");
    expect(source).toContain("Todo recipient is no longer eligible");
    expect(source).toContain("High-multiplier confirmation requires one independent direct owner-group recipient");
    expect(source).not.toContain("Todo source event does not match its business fact");
    expect(source).not.toContain("Todo policy is not enabled");
  });

  it("keeps the existing root IE self-review bypass", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/rework/process-configuration-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("!isRootActor(actor)");
    expect(source).toContain("orderCreatedBy === actor.actorId || configurationCreatedBy === actor.actorId");
    expect(source).toContain("if (isRootActor(actor)) return this.dto(this.database, order);");
    expect(source).toContain("if (isRootActor(actor)) return;");
  });
});
